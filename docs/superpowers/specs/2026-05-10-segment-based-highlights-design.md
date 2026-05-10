# Segment-Based Highlights Design Spec

**Status:** Approved 2026-05-10. Replaces the word-level highlight extraction shipped in M5 (sub-feature redesign; no production users yet).

**Why:** The current pipeline sends `transcript.words[]` to the LLM and gets back arbitrary `start_sec`/`end_sec` pairs. The LLM frequently picks mid-sentence boundaries, producing awkward cuts. Switching to **non-contiguous Whisper segments** lets the LLM compose narrative montages from the natural sentence-boundary chunks Whisper already produces.

**Outcome:** Each highlight becomes one or more segment ranges. The render pipeline produces a single concatenated mp4 per highlight via ffmpeg's `select` filter. M7 face tracking and M8 subtitle burn-in keep working — both rebase their timestamps to montage-relative time.

---

## 1. Schema

### 1.1 `Highlight` (replaces M5 schema)

```ts
export const HighlightSegmentSchema = z
  .object({
    start_sec: z.number().nonnegative(),
    end_sec: z.number().nonnegative(),
  })
  .refine((v) => v.end_sec > v.start_sec, {
    message: 'end_sec must be greater than start_sec',
  });

export const HighlightSchema = z.object({
  /** 1+ time ranges in source video time. Sorted chronologically by start_sec. */
  segments: z.array(HighlightSegmentSchema).min(1),
  title: z.string().min(1),
  hook: z.string().min(1),
});
```

A single-range highlight is just `segments.length === 1` — degenerate case, no special path.

`HighlightSetSchema` is unchanged in shape: `{ generatedAt, model, audioPath, highlights: Highlight[] }`.

### 1.2 LLM JSON contract

The LLM never sees raw seconds. Each chunk's prompt presents Whisper segments numbered by index:

```
[12] (45.20-48.00) 그래서 제가 그날 진짜 깜짝 놀랐는데요
[13] (48.00-51.30) 알고 보니까 이게 다 계획된 거였어요
[14] (51.30-55.10) 처음부터 끝까지...
```

The LLM returns indices, not times:

```json
{
  "highlights": [{ "segment_indices": [12, 13, 18, 19], "title": "...", "hook": "..." }]
}
```

`HighlightService` maps indices → time ranges using `transcript.segments[index].start/end`. This prevents the LLM from inventing impossible time values and shrinks the input context (~200 segments vs ~5000 words for a 10-min talk).

---

## 2. Service changes

### 2.1 `HighlightService`

The orchestration shape stays the same: `extract(opts)` → maybe-chunked LLM calls → optional rerank → final `HighlightSet`. The differences:

- **Input formatting**: per-chunk prompt formats `chunk.segments` as `[index] (start-end) text` lines instead of word-level lines.
- **Response parsing**: the response schema becomes `{ highlights: [{ segment_indices: number[], title, hook }] }`. Service maps each `segment_indices` to the resolved `Highlight` shape post-LLM.
- **Index translation across chunks**: per-chunk LLM calls return chunk-local indices. Service rebases to global indices using `chunk.firstIndex` before the rerank step. Rerank prompt sees global indices spanning all chunks.
- **Validation/filtering**: post-mapping, drop highlights where any index is out of bounds, where total duration falls outside `[minSec, maxSec]`, or where `segments.length === 0` after dedup.
- **Sort/dedup**: dedupe duplicate indices via `Set`; sort `segments` by `start_sec` ascending so the montage plays chronologically regardless of LLM output order.

### 2.2 `ChunkPlanner`

Rewritten to chunk by **segments** instead of words:

```ts
export interface ChunkPlannerOptions {
  threshold: number; // 150 segments (~7-15 min depending on segment length)
  chunkSize: number; // 100 segments per chunk
  overlap: number; // 10 segments
}

export interface ChunkRange {
  index: number;
  segments: Segment[];
  /** Global index of segments[0] in the source array — needed for index rebasing. */
  firstIndex: number;
  startSec: number;
  endSec: number;
}
```

The structural code is nearly identical to the M5 word-based planner; only the unit changes.

---

## 3. Render pipeline

### 3.1 Single-pass `select` filter

For each highlight, ffmpeg builds:

```
-i source.mp4
-vf "select='between(t,5,8)+between(t,12,15)+between(t,30,33)',
     setpts=N/FRAME_RATE/TB,
     <crop|sendcmd-crop>,
     scale=1080:1920,
     <subtitles=filename=...>"
-af "aselect='between(t,5,8)+between(t,12,15)+between(t,30,33)',
     asetpts=N/SR/TB"
output.mp4
```

`select` keeps frames whose timestamp falls in any range; `setpts=N/FRAME_RATE/TB` rebases kept frames to start at 0 (montage time). Same for audio (`aselect` + `asetpts`). Single ffmpeg invocation, no temp files.

For single-segment highlights, the `select` expression has just one `between()` — works identically to the existing M6/M7 single-range path.

### 3.2 Args builder refactor

`buildCenterArgs` and `buildTrackedArgs` change signatures:

```ts
function buildCenterArgs(sourcePath: string, segments: HighlightSegment[], outputPath: string): string[];
function buildTrackedArgs(
  sourcePath: string,
  segments: HighlightSegment[],
  outputPath: string,
  cmdPath: string,
): string[];
```

They build the `select` / `aselect` expressions internally from `segments`. The `appendSubtitleFilter` helper from M8 stays unchanged.

### 3.3 M7 tracking — rebase keyframes

For a multi-segment highlight, `tracker.track()` is called **once per segment**. The frames from each call are time-shifted to montage time and concatenated:

```ts
let cumulativeMontageTime = 0;
const allFrames: TrackFrame[] = [];
for (const seg of highlight.segments) {
  const result = await tracker.track(sourcePath, { startSec: seg.start_sec, endSec: seg.end_sec });
  for (const f of result.frames) {
    allFrames.push({
      t: cumulativeMontageTime + (f.t - seg.start_sec),
      cx: f.cx,
      cy: f.cy,
    });
  }
  cumulativeMontageTime += seg.end_sec - seg.start_sec;
}
const cmdContent = buildSendcmd({ sourceWidth, sourceHeight, frames: allFrames }, 0);
```

`buildSendcmd` is called with `clipStartSec = 0` — the times are already montage-relative.

**Failure rule:** if ANY segment returns 0 frames, the WHOLE highlight falls back to center crop (matches M7's single-segment behavior — no partial tracking).

### 3.4 M8 subtitles — rebase words

For each highlight, transcript words are filtered per-segment and rebased to montage time:

```ts
const rebasedWords: Word[] = [];
let cumulativeMontageTime = 0;
for (const seg of highlight.segments) {
  const segWords = transcriptWords.filter((w) => w.start < seg.end_sec && w.end > seg.start_sec);
  for (const w of segWords) {
    rebasedWords.push({
      text: w.text,
      start: cumulativeMontageTime + (Math.max(w.start, seg.start_sec) - seg.start_sec),
      end: cumulativeMontageTime + (Math.min(w.end, seg.end_sec) - seg.start_sec),
    });
  }
  cumulativeMontageTime += seg.end_sec - seg.start_sec;
}
const totalMontageDuration = cumulativeMontageTime;
const assContent = buildAssFile(rebasedWords, 0, totalMontageDuration, subtitleOptions);
```

Words straddling segment boundaries are clamped — the audio/video is also cut at the boundary by `select`, so the visible portion gets the right time. `buildAssFile` is called with `clipStartSec = 0` and `clipEndSec = totalMontageDuration`.

### 3.5 Per-clip flow shape

`RenderService.render()` still iterates highlights, runs ffmpeg, captures progress, handles cancel/failure/subtitle-fallback. The unit-of-work is unchanged — just the args and the rebasing helpers differ.

---

## 4. UI

### 4.1 `HighlightCard` done state

Multi-segment shows count + total duration; single-segment keeps the existing single-range form:

```
#1 Opener (3 segments · 1:30 total)
훅 텍스트 ...

#2 Single-range Title (0:45 – 1:15)
훅 텍스트 ...
```

The full segment breakdown lives in `<source>.highlights.json` for power users.

### 4.2 `RenderCard` + `JobDetailDrawer`

No conceptual change. Each highlight still produces one mp4. Per-clip status display unchanged.

---

## 5. Migration

**Hard break.** Legacy `<source>.highlights.json` files (with flat `start_sec`/`end_sec` per highlight) fail the new zod parse. Users re-run **하이라이트 추출** to regenerate. Acceptable because the project is pre-launch and the user already plans to re-run extraction to test the new behavior.

---

## 6. Testing

| File                        | Change                                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HighlightService.test.ts`  | Rewrite all cases — segment-indices LLM responses, segment-time mapping, dedup, sort, out-of-range filter, multi-chunk + rerank with global indices. ~7 cases.                                                                                       |
| `ChunkPlanner.test.ts`      | Rewrite for segments instead of words. ~5 cases.                                                                                                                                                                                                     |
| `RenderService.test.ts`     | +5 cases on top of existing 15: multi-segment select-filter args, multi-segment tracking aggregation, multi-segment subtitle rebasing, single-segment regression (degenerate path stays identical), tracking-fallback when one segment has 0 frames. |
| `SubtitleGenerator.test.ts` | No change (still operates on words).                                                                                                                                                                                                                 |
| `SendcmdGenerator.test.ts`  | No change (still operates on `TrackResult`).                                                                                                                                                                                                         |
| `HighlightCard`             | Manual visual check via `yarn dev`.                                                                                                                                                                                                                  |

Roughly **+15 vitest cases changed/added**, no Python side change.

---

## 7. What's NOT in scope

- **Crossfade between segments**: hard cuts only. Crossfade is a future polish item if user feedback wants smoother transitions.
- **Segment merging when adjacent**: ffmpeg's `select` filter handles adjacent ranges naturally — no pre-merge optimization needed for v1.
- **Per-segment LLM response validation** (e.g., "this index doesn't make narrative sense"): out of scope. The duration window and bounds check are the only filters.
- **Auto-suggest segment edits** (LLM picks A, user wants B): out of scope. Future feature.
- **Backward-compat reader for old highlights.json**: hard break per Section 5.
- **History persistence schema bump** (storing the `segments[]` shape): the existing M9 `shorts` table only stores `start_sec`/`end_sec` per short. For M10, store the FIRST segment's `start_sec` and the LAST segment's `end_sec` as a coarse range — good enough for History list display. The full segment breakdown lives in highlights.json.

---

## 8. Risk + edge cases

| Risk                                                                             | Mitigation                                                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| LLM picks 0 valid highlights (all filtered out)                                  | Service returns empty array; UI shows "0개 추출" — user retries with looser min/max settings                   |
| LLM picks `segment_indices` referencing chunk-local indices in a multi-chunk run | Service rebases to global before rerank; rerank prompt explicitly says "global indices across the whole video" |
| ffmpeg `select` syntax error on edge inputs (e.g., `between(t,5.0,5.0)`)         | `HighlightSegmentSchema.refine(end > start)` prevents zero-duration segments at the schema level               |
| Tracking of multi-segment ends up out-of-sync (montage time mismatch)            | Unit test in RenderService.test.ts asserts the expected montage timestamps after rebasing                      |
| Subtitle words straddling segment boundaries display oddly                       | Clamped to segment edge; visible word portion gets the right time. Acceptable trade-off.                       |
| Project becomes M11 instead of original M10 packaging                            | Rename in README; spec section 8.2 of the original design doc gets a note pointing to this spec.               |
