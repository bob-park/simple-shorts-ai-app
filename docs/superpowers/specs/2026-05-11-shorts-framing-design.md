# Shorts Framing — Top Title Bar + Bottom Subtitle Bar

**Status:** Spec, awaiting plan
**Date:** 2026-05-11
**Author:** Bob Park (with Claude)
**Scope:** Render pipeline only. Windows build support is intentionally deferred to a separate spec.

---

## Problem

Currently a rendered short is a full-bleed 1080×1920 frame: the cropped 9:16 region of the source video fills the entire canvas, with optional word-level subtitles burned in via libass. There is no on-screen indication of *what* the highlight is — the LLM already extracts a `title` for each highlight, but it only appears in the desktop UI, not in the rendered mp4.

The user wants a framed short, in the now-standard Korean shorts aesthetic: black bars top and bottom, with the highlight title rendered in the top bar and the word-level subtitle in the bottom bar.

## Goals

1. Every rendered short has a 240px black bar at the top with the highlight title (white text) and a 240px black bar at the bottom for subtitles (white text on the black background — already black, so no outline needed).
2. The video region in the middle is 1080×1440 (3:4 aspect inside the 1080×1920 canvas). Source is cropped to 3:4 aspect (wider than the previous 9:16) and scaled to fill the inner region.
3. Face tracking continues to work in the new crop aspect.
4. No new LLM call. The existing `Highlight.title` field drives the top bar — schema and prompt are unchanged.
5. Framing is always-on. No user toggle in Settings (YAGNI — can be added later if requested).

## Non-Goals

- Windows build support (separate spec).
- A separate "short_title" field optimized for on-screen display. The existing `Highlight.title` is reused as-is.
- Dynamic bar heights or user-configurable layout.
- drawtext-based title rendering (libass handles both title and subtitle through one ASS file).

---

## Architecture

**Approach:** A single ffmpeg filter graph renders the framed short. The crop aspect changes from 9:16 to 3:4, the scale target changes from 1080×1920 to 1080×1440, and a `pad` filter adds the 240/240 black bars to reach 1080×1920. Title and word-level subtitles are both rendered through one ASS file via the existing `subtitles` filter — libass handles Korean font fallback for both.

```
-vf select='...',setpts=N/FRAME_RATE/TB,
    <crop expr — center or sendcmd-tracked>,
    scale=1080:1440,
    pad=1080:1920:0:240:black,
    subtitles=filename='<clip>.ass'
```

The ASS file always exists (no longer optional), always contains a full-duration title Dialogue line, and contains word-cue Dialogue lines only when the caller passes `transcriptWords + subtitleOptions`.

### New shared module — `src/shared/shortLayout.ts`

Single source of truth for the layout constants. Imported by both `RenderService` and `SendcmdGenerator`.

```ts
export const SHORT_LAYOUT = {
  outputWidth: 1080,
  outputHeight: 1920,
  topBarHeight: 240,
  bottomBarHeight: 240,
  videoHeight: 1440, // outputHeight - topBarHeight - bottomBarHeight
} as const;

/** Source crop aspect: `crop=ih*VIDEO_CROP_NUM/VIDEO_CROP_DEN:ih`. */
export const VIDEO_CROP_NUM = 3;
export const VIDEO_CROP_DEN = 4;
```

### Modified components

**`src/main/services/RenderService.ts`**
- `buildVfChain` appends `,scale=1080:1440,pad=1080:1920:0:240:black` after the crop clause.
- `buildCenterArgs` uses `crop=ih*3/4:ih` (was `ih*9/16:ih`).
- `buildTrackedArgs` uses `crop@c=ih*3/4:ih:0:0` (was `ih*9/16:ih:0:0`).
- Crop / scale / pad expressions are derived from the shared `shortLayout` constants (no inline magic numbers).
- `maybeWriteSubtitles` → renamed to `writeAssFile`. Always called. Returns `{ assPath, cueCount }` non-null (cueCount may be 0 when no word cues, but the file still exists for the title).
- `appendSubtitleFilter` is always called (subtitles filter applied to every render).
- The existing "No such filter: subtitles" retry-without-subtitles fallback is preserved verbatim. In that fallback path, both title and subtitle are absent — only the black bars remain. Documented as an acceptable degraded state since bundled ffmpeg always has libass; the fallback exists for defense-in-depth.

**`src/main/services/SubtitleGenerator.ts`**
- `buildAssFile` signature gains one trailing arg: `titleText: string`. The title Dialogue's end time is computed as `clipEndSec - clipStartSec` (clip-relative duration) using the existing arguments — no new duration parameter needed.
- New `Title` style row in the `[V4+ Styles]` section:
  - Fontname: same `style.fontFamily` as Default (user-configurable, Korean-capable)
  - Fontsize: 64
  - PrimaryColour: `&H00FFFFFF` (white)
  - OutlineColour: `&H00000000` (black, unused since BorderStyle=1 + Outline=0)
  - BorderStyle: 1 (outline+shadow)
  - Outline: 0 (no outline — text sits on solid black bar)
  - Alignment: 8 (top-center)
  - MarginV: 140 (1920-canvas coordinate — measured from top because alignment=8; 140 places baseline near the vertical center of the 240px top bar)
- New full-duration Dialogue line under Title style (end time = `clipEndSec - clipStartSec`):
  ```
  Dialogue: 0,0:00:00.00,<formatAssTime(clipEndSec - clipStartSec)>,Title,<escapeAssText(titleText)>
  ```
- Default style `MarginV: 200` → `120`. The new value places the bottom-aligned subtitle inside the 240px bottom bar (was tuned for the 9:16 layout). Outline width and outline color stay user-controlled — typically the user will choose outline 0 / black bar now, but the spec does not force this.
- The early-return-empty-string condition (`if (inWindow.length === 0) return ''`) is removed. The function always returns non-empty content because the title line is always present.
- The existing `WrapStyle: 2` is preserved — libass auto-wraps long titles. No ellipsis logic is added.

**`src/main/services/SendcmdGenerator.ts`**
- Replace hardcoded `(track.sourceHeight * 9) / 16` with `(track.sourceHeight * VIDEO_CROP_NUM) / VIDEO_CROP_DEN` (imported from `shortLayout`).
- Error message updated: `"source is already ${VIDEO_CROP_NUM}:${VIDEO_CROP_DEN} or taller"` (template-driven).
- All other logic (30fps interpolation, clamp, `dt=0` guard) unchanged.
- Numerical impact: for a 1920×1080 source, `cropW` goes from 607 to 810 and the trackable x-range goes from 1313 to 1110. The face-tracking sendcmd path now has slightly less horizontal latitude but still ample range for typical YouTube content.

---

## Data Flow

```
Highlight {title, segments, hook}
    │
    ├──> RenderService.render()
    │        │
    │        ├──> writeAssFile(highlight.title, words?, subtitleOptions?)
    │        │        └──> SubtitleGenerator.buildAssFile(words, start, end, style, title)
    │        │                 └──> writes <clip>.ass to outputDir
    │        │
    │        ├──> (if tracker) maybeTrackAndPersist()
    │        │        └──> SendcmdGenerator.buildSendcmd(track, 0)  [cropW now uses 3:4]
    │        │                 └──> writes <clip>.cmd
    │        │
    │        └──> spawn ffmpeg with argv:
    │             -vf <crop>,scale=1080:1440,pad=1080:1920:0:240:black,subtitles=<clip>.ass
    │
    └──> short_<N>.mp4 (1080×1920, framed)
```

No new IPC. No new sidecar call. No new persisted artifact beyond what already exists (the `.ass` file is already written today when subtitles are enabled — now it's just always written).

---

## Edge Cases

| Case | Handling |
|---|---|
| Title contains ASS metacharacters (`{`, `}`, `\`) | Existing `escapeAssText()` applied. |
| Title very long (60+ chars) | libass `WrapStyle: 2` auto-wraps. 240px top bar fits ~2 lines at fontsize 64; 3+ lines visually overflow at the top. No ellipsis logic — user-visible imperfection accepted. |
| No transcript words in clip (subtitles off or word window empty) | ASS file contains only the Title Dialogue line. Bottom bar is solid black. |
| Source already 3:4 or taller (rare — square or vertical YouTube uploads) | SendcmdGenerator throws → tracker path falls back to center-crop. Center-crop also uses `crop=ih*3/4:ih` and will fail in ffmpeg if `iw < ih*3/4`. Result: clip status `failed` with the ffmpeg error message. Acceptable for v1; YouTube 16:9 is the dominant case. |
| Bundled ffmpeg without libass (defense-in-depth — should not happen with shipped builds) | Existing `subtitlesUnavailable` retry path: render proceeds without the subtitles filter. Result: framed mp4 with black bars only (no title, no subtitles). Clip status `done`. |
| ASS file write fails (disk full, etc.) | Existing fs error path: exception propagates, clip status `failed`. No new handling. |

---

## Testing

### Unit tests

**`SubtitleGenerator.test.ts`** (rewrites + additions):
- Title style row present in `[V4+ Styles]` with alignment=8, MarginV=140, fontsize=64, outline=0.
- Title Dialogue line spans `0:00:00.00` → `formatAssTime(clipDurationSec)`.
- Default style MarginV=120.
- words=[] + titleText="제목" → non-empty ASS containing Title Dialogue + no Default Dialogue lines.
- words=[...] + titleText="제목" → ASS contains both styles' Dialogue lines.
- Title with `{`, `}`, `\` → escaped via `escapeAssText`.
- Title Dialogue end-time equals `clipEndSec - clipStartSec` (clip-relative duration).

**`SendcmdGenerator.test.ts`** (revisions):
- For source 1920×1080: cropW expectation changes 607 → 810; maxX changes 1313 → 1110.
- Error message updated: `"source is already 3:4 or taller"`.
- Interpolation, clamp, and `dt=0` tests unaffected (assert on relative positions, not absolute cropW).

**`RenderService.test.ts`** (revisions):
- vf chain contains `scale=1080:1440` (was 1080:1920).
- vf chain contains `pad=1080:1920:0:240:black`.
- Center-crop case: `crop=ih*3/4:ih` (was 9/16).
- Tracked case: `crop@c=ih*3/4:ih:0:0`.
- ASS file is always written, even when `subtitleOptions`/`transcriptWords` are absent.
- vf chain always ends in `,subtitles=filename='...'`.
- "No such filter: subtitles" fallback test still passes (the retry argv has no `subtitles` clause but still contains the new pad+scale).

### Manual verification

To be performed by the user after the implementer completes the plan:

1. `yarn dev` → paste a YouTube URL → run download → highlight → render.
2. Open the resulting `short_*.mp4` in QuickTime.
3. Verify visually:
   - **Top 240px:** solid black bar, white title centered, 1–2 lines, readable.
   - **Middle 1080×1440:** video content, no left/right black space, no horizontal cropping artifacts.
   - **Bottom 240px:** solid black bar with white subtitle text (when subtitles enabled).
4. Verify face-tracked clips: the inner video glides horizontally as the speaker moves (the existing 30fps sendcmd interpolation from `fd2c56b` still applies — verify no regression).
5. Disable subtitles in Settings → render again. Top bar still shows title, bottom bar is empty solid black.
6. Pick a highlight with a long title (50+ chars) and render. Title wraps to 2 lines within the top bar.

If any of (3)–(6) fail or look wrong, re-open the spec.

---

## Rollback

Single-PR revert. No data migration, no schema change. Existing rendered shorts on disk are not touched.

---

## Open Questions / Deferred

- **Subtitle outline:** With the bottom bar now solid black, the user-configurable `outlineColor` becomes visually redundant for the dominant case. The spec keeps it user-controlled rather than forcing outline=0; the user can choose 0 in Settings if desired. Not enough motivation to redesign Settings now.
- **Windows build:** llama-cpp-python Metal path doesn't apply; need CUDA wheel or CPU strategy. Bundle paths and platform-specific runtime fetcher. Separate spec.
- **drawtext fallback for `subtitlesUnavailable` path:** When libass is unavailable, current fallback drops both title and subtitle. A future enhancement could use `drawtext` for the title in that path. Out of scope for v1 — the case is rare with the bundled ffmpeg.
