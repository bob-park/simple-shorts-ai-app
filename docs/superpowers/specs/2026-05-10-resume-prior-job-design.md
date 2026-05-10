# Resume Prior Job — Design Spec

**Status:** Approved 2026-05-10. Adds the ability to pick up a previously-worked YouTube job — either by re-pasting the same URL or by clicking "이어서 작업" from the History page — and have the new-job pipeline UI restore each completed step's done state from on-disk artifacts.

**Why:** Pipeline artifacts (`<source>.meta.json`, `.transcript.json`, `.highlights.json`, output mp4s) are already written to disk by every step. The renderer state machine, however, always starts at `idle` — every restart of work re-runs every step. Users who paste the same URL or revisit a finished job have no way to skip ahead.

**Outcome:** When the user pastes a URL whose `videoId` matches a prior download in `settings.paths.downloads`, the PreviewCard surfaces a "이어서 작업" banner. Clicking it hydrates the 5 pipeline hooks (preview/download/transcribe/highlights/render) into their `done` states using the persisted artifacts. From the History page, every job row gets an equivalent "이어서 작업" action that navigates to NewJob and triggers the same hydration.

---

## 1. Architecture

### 1.1 The data is already on disk

Every step in the pipeline already writes its artifact next to the source video:

```
<settings.paths.downloads>/
├── <stem>.webm                        # original (yt-dlp output)
├── <stem>.webm.meta.json              # { id (videoId), title, url, downloadedAt, ... }
├── <stem>.webm.transcript.json        # Transcript (after STT)
└── <stem>.webm.highlights.json        # HighlightSet (after extract)

<settings.paths.outputs>/<stem>/
└── short_<i>.mp4                      # render output (after render)
```

History DB (M9) records *completed* renders with `sourcePath`, but doesn't track partial pipelines (download-only, download+STT, etc.). Disk artifacts are the source of truth for resume detection.

### 1.2 Detection model

A new `ResumeService` in main process scans `settings.paths.downloads` for `*.meta.json` files, parses each, and indexes them by `videoId`. Two RPC entry points:

- `resume:detect(videoId)` — used by URL re-paste flow. Returns nullable `ResumeSnapshot`.
- `resume:hydrate(sourcePath)` — used by History entry. Reads sibling artifacts directly from a known sourcePath. Returns nullable `ResumeSnapshot`.

Both produce the same shape:

```ts
interface ResumeSnapshot {
  url: string;                                              // from meta.json
  sourcePath: string;                                        // absolute path to original video
  meta: VideoMeta;                                           // parsed via VideoMetaSchema
  download: { outputPath: string };                          // always present (sourcePath itself)
  transcript?: { path: string; data: Transcript };           // if .transcript.json exists + parses
  highlights?: { path: string; data: HighlightSet };         // if .highlights.json exists + parses
  render?: { outputDir: string; result: RenderResult };      // if outputs/<stem>/ has any short_*.mp4
}
```

### 1.3 Hydration model

Each of the 5 NewJob hooks gains a `hydrate*()` method that pushes the hook into its `done` state directly:

- `useVideoPreview.hydrateLoaded(url, meta)` → `{ status: 'loaded', url, meta }`
- `useDownload.hydrateDone(url, outputPath)` → `{ status: 'done', url, outputPath }`
- `useTranscribe.hydrateDone(audioPath, transcriptPath, transcript)` → `{ status: 'done', ... }`
- `useHighlights.hydrateDone(audioPath, highlightsPath, highlightSet)` → `{ status: 'done', ... }`
- `useRender.hydrateDone(audioPath, result)` → `{ status: 'done', result }`

`NewJobStateContext` exposes a single `hydrate(snapshot)` that calls the right subset of hook hydrators based on which fields the snapshot has populated.

A hook called with a "missing prerequisite" (e.g. transcript hydrated but no download) still works because the upstream `useDownload` was hydrated first; ordering is `preview → download → transcribe → highlights → render` and the snapshot guarantees the prefix is contiguous (no transcript without download, etc.).

### 1.4 URL re-paste flow

```
User pastes URL into UrlInput
  → preview.fetch(url) (existing)
  → preview state → 'loaded' { url, meta }
  → NewJobPage useEffect: when preview.status === 'loaded' AND no other pipeline state in flight,
    call window.api.resumeDetect(meta.id)
    → if snapshot returned:
        render <ResumeBanner snapshot={...} /> alongside PreviewCard
        with two buttons:
          [이어서 작업]  → context.hydrate(snapshot); banner unmounts
          [새로 시작]   → dismiss banner; user proceeds with normal Download flow
    → if null:
        no banner; existing flow unchanged
```

### 1.5 History "이어서 작업" flow

`JobDetailDrawer` (or wherever the per-job actions live) gets a new button "이어서 작업" alongside the existing actions. Clicking it:

```
1. navigate('/')
2. window.api.resumeHydrate(job.sourcePath) → snapshot | null
3. If snapshot: context.hydrate(snapshot)
4. If null (file moved/deleted): toast/inline notice "원본 파일을 찾을 수 없습니다", normal NewJob page rendered
```

Because the M11 NewJobStateProvider sits above react-router's Outlet, the navigate-then-hydrate sequence works without race: the page mounts, then the hydrate call fires synchronously and the cards re-render in their done states.

### 1.6 Failure modes

| Situation | Behavior |
|---|---|
| `meta.json` exists but `<sourcePath>` file missing | Treat as no snapshot; user starts fresh |
| `transcript.json` exists but fails zod parse | Skip transcript step in snapshot (treat as not done); user re-runs STT |
| `highlights.json` exists but fails zod parse | Skip highlights in snapshot |
| `outputs/<stem>/` exists but empty | No `render` field in snapshot |
| Multiple meta.json files match same videoId | Pick most recent (`downloadedAt` descending); ignore others |
| `videoId` not present in any meta.json | Return null; user proceeds normally |
| `settings.paths.downloads` doesn't exist (fresh install) | Return null without error |

### 1.7 What stays the same

- The 5 hooks' existing `start()` / `cancel()` / `reset()` paths are untouched. Hydration is an additional entry point.
- No new IPC channels for the existing pipeline steps.
- `RenderResult` schema unchanged. Reconstruction from disk uses `outputs/<stem>/short_*.mp4` filenames + the highlights.json's titles to fill `RenderClipResult` — see §3.4.
- History DB (M9) is read-only here; resume doesn't write to it.

---

## 2. RPC contract

### 2.1 `resume:detect`

```ts
// Request
window.api.resumeDetect(videoId: string): Promise<ResumeSnapshot | null>

// Sidecar logic (in main process, no Python involvement)
1. List settings.paths.downloads/*.meta.json
2. For each, parse via VideoMetaSchema (skip on parse failure)
3. Filter where meta.id === videoId AND fs.exists(sourcePath inferred from meta.json sibling)
4. Sort by meta.downloadedAt descending
5. Take the first; build snapshot via the shared snapshot-builder helper (§2.3)
6. Return snapshot or null
```

### 2.2 `resume:hydrate`

```ts
// Request
window.api.resumeHydrate(sourcePath: string): Promise<ResumeSnapshot | null>

// Logic
1. metaPath = `${sourcePath}.meta.json`; read + parse
2. If parse fails OR fs.access(sourcePath) throws → return null
3. Build snapshot via the shared helper
```

### 2.3 Shared snapshot builder

```ts
async function buildSnapshot(sourcePath: string, meta: VideoMeta): Promise<ResumeSnapshot> {
  const transcriptPath = `${sourcePath}.transcript.json`;
  const highlightsPath = `${sourcePath}.highlights.json`;
  const outputDir = join(settings.paths.outputs, basename(sourcePath, extname(sourcePath)));

  const [transcript, highlights] = await Promise.all([
    tryReadJson(transcriptPath, TranscriptSchema),
    tryReadJson(highlightsPath, HighlightSetSchema),
  ]);
  const renderResult = await tryRebuildRender(outputDir, highlights);

  return {
    url: meta.webpageUrl,
    sourcePath,
    meta,
    download: { outputPath: sourcePath },
    transcript: transcript ? { path: transcriptPath, data: transcript } : undefined,
    highlights: highlights ? { path: highlightsPath, data: highlights } : undefined,
    render: renderResult,
  };
}
```

`tryReadJson` returns `null` on missing file or parse failure. `tryRebuildRender` (§3.4) reconstructs a `RenderResult` from the output directory's mp4 files + the highlights set.

---

## 3. Implementation details

### 3.1 `ResumeService` (new)

Location: `src/main/services/ResumeService.ts`. Responsibilities:

- `detect(videoId)` — scan downloads dir, find matching meta.json, build snapshot
- `hydrate(sourcePath)` — read meta.json, build snapshot
- `buildSnapshot(sourcePath, meta)` — shared helper (§2.3)

Constructor takes `(settings: SettingsStore, fs: FsLike)` for testability. The downloads directory is read fresh on each call (no caching) — meta.json files are small (~300 bytes each) and a typical user has < 100 prior jobs. If profiling shows this is slow, add a TTL cache later.

### 3.2 IPC wiring (`main.ts`)

```ts
const resumeService = new ResumeService(settingsStore, fsPromises);
ipcMain.handle('resume:detect', (_e, videoId: string) => resumeService.detect(videoId));
ipcMain.handle('resume:hydrate', (_e, sourcePath: string) => resumeService.hydrate(sourcePath));
```

### 3.3 Renderer hook hydrators

Each hook gains a single `hydrate*()` method that pushes a fully-formed done state into the existing `useState`. Implementation pattern (using `useDownload` as example):

```ts
const hydrateDone = useCallback((url: string, outputPath: string) => {
  urlRef.current = url;
  setState({ status: 'done', url, outputPath });
}, []);

return { state, status: state.status, start, cancel, reset, hydrateDone };
```

The 5 hydrators:

| Hook | Method signature |
|---|---|
| `useVideoPreview` | `hydrateLoaded(url: string, meta: VideoMeta)` |
| `useDownload` | `hydrateDone(url: string, outputPath: string)` |
| `useTranscribe` | `hydrateDone(audioPath: string, transcriptPath: string, transcript: Transcript)` |
| `useHighlights` | `hydrateDone(audioPath: string, highlightsPath: string, highlightSet: HighlightSet)` |
| `useRender` | `hydrateDone(audioPath: string, result: RenderResult)` |

### 3.4 Reconstructing `RenderResult` from disk

When `outputs/<stem>/` exists with mp4 files, build a synthetic `RenderResult`:

```ts
async function tryRebuildRender(outputDir: string, highlightSet: HighlightSet | null) {
  if (!highlightSet) return undefined;
  const files = await fsPromises.readdir(outputDir).catch(() => []);
  const shorts = files.filter(f => /^short_\d+\.mp4$/.test(f)).sort();
  if (shorts.length === 0) return undefined;
  const results: RenderClipResult[] = shorts.map((file, idx) => {
    const highlight = highlightSet.highlights[idx];
    return {
      index: idx + 1,
      title: highlight?.title ?? `Clip ${idx + 1}`,
      startSec: highlight?.segments[0]?.start_sec ?? 0,
      endSec: highlight?.segments[highlight.segments.length - 1]?.end_sec ?? 0,
      montageDurationSec: highlight?.segments.reduce((acc, s) => acc + (s.end_sec - s.start_sec), 0) ?? 0,
      status: 'done',
      outputPath: join(outputDir, file),
      tracking: null,
      subtitles: null,
    };
  });
  return { outputDir, result: { outputDir, results } };
}
```

`tracking` and `subtitles` are set to `null` because the .cmd / .ass / .track.json sidecar files aren't required for the post-render UI display (the user just needs to see "5 clips rendered, click to play").

### 3.5 ResumeBanner component (new)

Tiny presentational component shown above PreviewCard when a snapshot is available:

```tsx
<section className="border-hairline bg-canvas p-md rounded-lg border-l-4 border-l-brand-blue">
  <p className="text-body-md text-ink">
    이전에 작업한 영상이에요.
    {snapshot.render && ' 이미 숏츠까지 만들어졌습니다.'}
    {snapshot.highlights && !snapshot.render && ' 하이라이트 추출까지 완료됐습니다.'}
    {snapshot.transcript && !snapshot.highlights && ' STT까지 완료됐습니다.'}
    {!snapshot.transcript && ' 다운로드만 완료된 상태입니다.'}
  </p>
  <div className="gap-sm flex mt-sm">
    <button onClick={onResume}>이어서 작업</button>
    <button onClick={onDismiss}>새로 시작</button>
  </div>
</section>
```

### 3.6 NewJob page changes

```ts
// inside NewJobPage
const [resumeSnapshot, setResumeSnapshot] = useState<ResumeSnapshot | null>(null);
const [resumeDismissed, setResumeDismissed] = useState(false);
const { hydrate } = useNewJobState();

useEffect(() => {
  if (preview.state.status !== 'loaded') return;
  // Don't probe again if user already dismissed for this preview
  if (resumeDismissed) return;
  // Don't probe if any pipeline step has progressed past idle (resume already happened or user is mid-flow)
  if (download.state.status !== 'idle') return;
  void window.api.resumeDetect(preview.state.meta.id).then(setResumeSnapshot);
}, [preview.state, resumeDismissed, download.state.status]);

// Render: ResumeBanner when snapshot && !resumeDismissed
```

### 3.7 History row changes

`JobDetailDrawer` (or `HistoryListView` row actions) — add a button:

```tsx
<button onClick={() => {
  navigate('/');
  void window.api.resumeHydrate(job.sourcePath).then((snap) => {
    if (snap) hydrate(snap);
    // null → silently fall through to fresh NewJob page
  });
}}>
  이어서 작업
</button>
```

The `navigate('/')` happens first so NewJob mounts; the hydrate call fires after with the cards already rendered. Because `NewJobStateProvider` lives above the router Outlet, the context is stable across this navigation.

---

## 4. Failure handling + edge cases

| Edge case | Behavior |
|---|---|
| `settings.paths.downloads` is unset / non-existent | `resume:detect` returns null without throwing |
| `meta.json` parse error (corrupt file) | Skip silently; that file isn't a candidate |
| Source video file deleted but meta.json remains | Treated as not a valid resume target — return null |
| User pastes URL with extra query params (timestamp, etc.) | `videoId` extraction by `youtubeService.fetchMeta` strips them; matching still works |
| User has 100+ prior downloads | Scan is O(n), each meta.json ~300 bytes. Sub-second on typical hardware. No cache in v1. |
| Snapshot has highlights but no transcript (impossible normally) | `hydrate()` only calls `useTranscribe.hydrateDone` if `snapshot.transcript` is set; downstream `useHighlights.hydrateDone` is independently driven by `snapshot.highlights`. The UI may briefly look "highlights done but transcribe not done" — visually odd but functionally non-breaking. Not expected in practice. |
| User hits "이어서 작업" then "다시 [단계]" on a hydrated card | Existing reset/start path takes over normally; resume is just an entry point. |
| Renderer's outputs path differs from where the original render wrote (user changed Settings → Output path) | `tryRebuildRender` checks `<settings.paths.outputs>/<stem>/`; if path no longer matches, no `render` field. User would have to re-render. |

---

## 5. Migration

**N/A.** No persisted state changes. Existing on-disk artifacts written by M3–M11 are read as-is.

---

## 6. Testing

| File | Cases |
|---|---|
| `ResumeService.test.ts` (new) | detect: matches videoId, picks most recent on duplicates, returns null when no match, returns null when sourcePath missing, parse-failure tolerance. ~5 cases. |
| `ResumeService.test.ts` | hydrate: builds snapshot with all 4 fields, builds with only download, builds with download+transcript, returns null when meta missing. ~4 cases. |
| `useDownload.test.ts` etc. (or inline in NewJob.test.tsx) | hydrateDone pushes state to 'done' shape correctly. ~5 cases (one per hook). |
| `tests/renderer/NewJob.test.tsx` | Resume banner appears when snapshot returned; clicking "이어서 작업" hydrates context and cards reflect done; clicking "새로 시작" dismisses banner. ~3 cases. |
| `tests/renderer/History.test.tsx` | "이어서 작업" button triggers navigate + resumeHydrate + hydrate. ~1 case. |

Net ~18 vitest additions. Sidecar pytest unchanged.

---

## 7. Risk + edge cases

| Risk | Mitigation |
|---|---|
| Snapshot builder reads files that change underneath (race) | All reads happen in main process before sending IPC response; subsequent file edits don't affect the already-sent snapshot |
| Large transcript.json (10+ minute videos can be ~500KB) sent over IPC | Acceptable — single one-shot transfer per resume click, not streamed |
| Resume banner flashes briefly when user pastes URL (preview→loaded→detect call→banner) | Acceptable; the "이전에 작업한..." copy is informative even if it appears late |
| User starts pipeline, navigates away, comes back, re-pastes URL → both Context state AND disk snapshot exist | Banner only shows when `download.status === 'idle'`; if Context already has work in flight, no banner |
| Race between `navigate('/')` and `resumeHydrate(...)` from History | `hydrate()` is synchronous setState; React schedules a re-render. NewJobPage mounts via the navigate; hydrate fires after promise resolves. No race. |
| Fresh install with no downloads dir | `fsPromises.readdir` throws ENOENT; `ResumeService.detect` catches and returns null |

---

## 8. Definition of Done

1. `yarn typecheck`, `yarn lint`, `yarn test`, `yarn build` all green.
2. Manual: paste a URL whose video was previously downloaded → ResumeBanner appears → "이어서 작업" → all relevant cards show done state.
3. Manual: paste same URL with no prior work → no banner; normal flow.
4. Manual: from History page, click "이어서 작업" on a finished job → navigates to NewJob with all cards done.
5. Manual: paste URL whose source file was deleted but meta.json remains → no banner.
6. Manual: paste URL of partially-completed job (download only) → banner says "다운로드만 완료" and only download card hydrates done.
7. Branch merged to master; tag optional (this is a feature, not a milestone).

---

## 9. What's NOT in scope

- Restoring Settings (Whisper model, count, minSec/maxSec, subtitle style) from a prior job's options — current Settings always apply
- Resuming partial downloads (yt-dlp doesn't expose progress checkpoints to the app)
- Multi-candidate UI when several meta.json files match (just pick most recent)
- Scanning workspace folder or any directory beyond `settings.paths.downloads`
- Disk-backed cache of the meta.json index (re-scan each call)
- Deleting prior artifacts via "이어서 작업" UI (use Reset buttons or History delete)
- Hydrating state when the user is mid-pipeline on something else (banner suppressed by `download.status` guard)

---

## 10. Notes for the implementing agent

- `youtubeService.fetchMeta(url)` already returns `id` (videoId). No new YouTube parsing needed for the URL re-paste flow.
- `VideoMetaSchema.parse(JSON.parse(...))` already exists and is used by `main.ts` for the M9 history record path — reuse the same import.
- `HighlightSetSchema.parse(...)` exists and is used by `extract:run` and `render:run`. Reuse.
- `TranscriptSchema.parse(...)` exists and is used by `extract:run`. Reuse.
- The renderer's `formatTime` helper, the various card components, and the existing `done`-state UI all work as-is — hydration just sets state and React renders.
- For the History "이어서 작업" button: `useNavigate()` from `react-router-dom` is already imported elsewhere in renderer.
