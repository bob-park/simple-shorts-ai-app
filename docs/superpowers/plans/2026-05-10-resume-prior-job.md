# Resume Prior Job — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect previously-worked YouTube jobs (via URL re-paste or History "이어서 작업") and hydrate the new-job pipeline UI from on-disk artifacts so users can pick up where they left off.

**Architecture:** A new main-process `ResumeService` scans `settings.paths.downloads` for `*.meta.json`, matches by `videoId`, and builds a `ResumeSnapshot` containing every artifact that exists (transcript / highlights / render). Two IPCs (`resume:detect(videoId)` and `resume:hydrate(sourcePath)`) feed the renderer. Each pipeline hook (`useVideoPreview`, `useDownload`, `useTranscribe`, `useHighlights`, `useRender`) gains a `hydrate*()` method that pushes its state directly into `done`; `NewJobStateContext.hydrate(snapshot)` orchestrates them. URL re-paste shows a `ResumeBanner` above PreviewCard; the History detail drawer gains an "이어서 작업" button that navigates to NewJob and triggers hydration.

**Tech Stack:** No new deps. Pure TypeScript change touching `src/main/services/ResumeService.ts` (new), `src/main/main.ts`, `src/main/preload.ts`, `src/shared/{ipc,resume}.ts`, `src/renderer/hooks/use*.ts` (5), `src/renderer/components/{NewJobStateContext,newjob/ResumeBanner,history/JobDetailDrawer}.tsx`. Reuses existing zod schemas (`VideoMetaSchema`, `TranscriptSchema`, `HighlightSetSchema`). Spec: `docs/superpowers/specs/2026-05-10-resume-prior-job-design.md`.

---

## File Structure

```
src/
├── shared/
│   ├── resume.ts                                # NEW: ResumeSnapshot + zod schema
│   └── ipc.ts                                   # MODIFY: add resumeDetect/resumeHydrate to AppApi
├── main/
│   ├── main.ts                                  # MODIFY: construct ResumeService + 2 IPC handlers
│   ├── preload.ts                               # MODIFY: expose resumeDetect/resumeHydrate
│   └── services/
│       ├── ResumeService.ts                     # NEW: scan + snapshot builder
│       └── ResumeService.test.ts                # NEW: ~9 vitest cases
└── renderer/
    ├── hooks/
    │   ├── useVideoPreview.ts                   # MODIFY: + hydrateLoaded()
    │   ├── useDownload.ts                       # MODIFY: + hydrateDone()
    │   ├── useTranscribe.ts                     # MODIFY: + hydrateDone()
    │   ├── useHighlights.ts                     # MODIFY: + hydrateDone()
    │   └── useRender.ts                         # MODIFY: + hydrateDone()
    ├── components/
    │   ├── NewJobStateContext.tsx               # MODIFY: expose hydrate(snapshot)
    │   ├── newjob/
    │   │   └── ResumeBanner.tsx                 # NEW: banner above PreviewCard
    │   └── history/
    │       └── JobDetailDrawer.tsx              # MODIFY: + "이어서 작업" button
    └── pages/
        └── NewJob.tsx                           # MODIFY: probe resumeDetect on preview→loaded; render ResumeBanner

tests/renderer/
├── NewJob.test.tsx                              # MODIFY: api stub + 2 resume cases
└── History.test.tsx                             # MODIFY: api stub + 1 resume case
```

**Decomposition rationale:**

- `ResumeService` is its own file (parallel to existing `HistoryService`, `RenderService` etc.) so it stays under ~150 lines and tests in isolation.
- `ResumeSnapshot` and the zod schema live in `src/shared/resume.ts` — both main and renderer consume the type, and zod parsing happens in main.
- Hook changes are tiny per-file (one new method each), so no need for a separate hydration utility.
- The History row entry point lives in `JobDetailDrawer.tsx` (where existing job-action buttons already live).

---

## Tasks

### Task 1: `ResumeSnapshot` shared type + ResumeService skeleton

**Files:**

- Create: `src/shared/resume.ts`
- Create: `src/main/services/ResumeService.ts`
- Create: `src/main/services/ResumeService.test.ts`

This task scaffolds the type + service constructor + a single trivial test. Subsequent tasks fill in `detect()` and `hydrate()`.

- [ ] **Step 1: Create `src/shared/resume.ts`**

```ts
import type { HighlightSet } from './highlight';
import type { RenderResult } from './render';
import type { Transcript } from './transcript';
import type { VideoMeta } from './youtube';

/**
 * Snapshot of every artifact a prior job has on disk. Returned by main's
 * `resume:detect` and `resume:hydrate` IPCs and consumed by the renderer to
 * push the 5 NewJob pipeline hooks into their `done` states.
 *
 * `download` is always present when this object is returned (the source video
 * file existing on disk is the precondition for building a snapshot at all).
 * Later fields are optional — present only when their respective sibling
 * artifact was found and parsed successfully.
 */
export interface ResumeSnapshot {
  url: string;
  sourcePath: string;
  meta: VideoMeta;
  download: { outputPath: string };
  transcript?: { path: string; data: Transcript };
  highlights?: { path: string; data: HighlightSet };
  render?: { outputDir: string; result: RenderResult };
}
```

- [ ] **Step 2: Create `src/main/services/ResumeService.ts` skeleton**

```ts
import type { ResumeSnapshot } from '@shared/resume';

interface SettingsLike {
  get(): { paths: { downloads: string; outputs: string } };
}

type FsLike = {
  readdir: (dir: string) => Promise<string[]>;
  readFile: (path: string, enc: 'utf8') => Promise<string>;
  access: (path: string) => Promise<void>;
};

/**
 * Detect and hydrate prior pipeline runs from on-disk artifacts. No caching
 * — meta.json files are tiny (~300 bytes) and a typical user has < 100
 * prior downloads, so a full directory scan per call is fine.
 */
export class ResumeService {
  constructor(
    private readonly settings: SettingsLike,
    private readonly fs: FsLike,
  ) {}

  async detect(_videoId: string): Promise<ResumeSnapshot | null> {
    return null;
  }

  async hydrate(_sourcePath: string): Promise<ResumeSnapshot | null> {
    return null;
  }
}
```

- [ ] **Step 3: Create `src/main/services/ResumeService.test.ts` with one smoke test**

```ts
import { describe, expect, it, vi } from 'vitest';

import { ResumeService } from './ResumeService';

function makeStubFs() {
  return {
    readdir: vi.fn(async (_d: string) => [] as string[]),
    readFile: vi.fn(async (_p: string, _e: 'utf8') => ''),
    access: vi.fn(async (_p: string) => undefined),
  };
}

function makeStubSettings(downloads = '/dl', outputs = '/out') {
  return { get: () => ({ paths: { downloads, outputs } }) };
}

describe('ResumeService', () => {
  it('detect returns null when downloads dir is empty', async () => {
    const fs = makeStubFs();
    const svc = new ResumeService(makeStubSettings(), fs);
    expect(await svc.detect('any-id')).toBeNull();
  });

  it('hydrate returns null when meta.json is missing', async () => {
    const fs = makeStubFs();
    fs.readFile.mockRejectedValue(new Error('ENOENT'));
    const svc = new ResumeService(makeStubSettings(), fs);
    expect(await svc.hydrate('/dl/missing.mp4')).toBeNull();
  });
});
```

- [ ] **Step 4: Run tests — should pass 2/2**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/ResumeService.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/shared/resume.ts src/main/services/ResumeService.ts src/main/services/ResumeService.test.ts
git commit -m "feat: ResumeSnapshot type + ResumeService skeleton"
```

---

### Task 2: `ResumeService.detect()` — scan downloads dir, match videoId

**Files:**

- Modify: `src/main/services/ResumeService.ts`
- Modify: `src/main/services/ResumeService.test.ts`

Implements `detect(videoId)`: list `*.meta.json` in downloads dir, parse each via `VideoMetaSchema`, filter by id + source-file existence, sort by mtime descending, build a download-only snapshot from the most recent match.

(Task 3 extends `buildSnapshot` with transcript/highlights/render reading. Task 2 keeps it minimal.)

- [ ] **Step 1: Add failing tests to `src/main/services/ResumeService.test.ts`**

Append:

```ts
import { promises as fsPromises } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withTempDl(): Promise<{ dl: string; cleanup: () => Promise<void> }> {
  const dl = await mkdtemp(join(tmpdir(), 'resume-test-'));
  return { dl, cleanup: () => rm(dl, { recursive: true, force: true }) };
}

const baseMeta = {
  id: 'abc123',
  title: 'Test',
  channel: 'C',
  durationSec: 60,
  thumbnailUrl: 'https://example.com/t.jpg',
  webpageUrl: 'https://youtu.be/abc123',
};

describe('ResumeService.detect (real fs)', () => {
  it('returns snapshot when meta.json matches videoId and source file exists', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      const sourcePath = join(dl, 'video.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      const snap = await svc.detect('abc123');
      expect(snap).not.toBeNull();
      expect(snap!.sourcePath).toBe(sourcePath);
      expect(snap!.meta.id).toBe('abc123');
      expect(snap!.download.outputPath).toBe(sourcePath);
      expect(snap!.transcript).toBeUndefined();
      expect(snap!.highlights).toBeUndefined();
      expect(snap!.render).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('returns null when no meta.json matches the videoId', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      await writeFile(join(dl, 'video.webm'), 'fake');
      await writeFile(join(dl, 'video.webm.meta.json'), JSON.stringify({ ...baseMeta, id: 'other' }));
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      expect(await svc.detect('abc123')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('returns null when meta matches but source file is missing', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      // meta.json exists but the .webm beside it does not
      await writeFile(join(dl, 'gone.webm.meta.json'), JSON.stringify(baseMeta));
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      expect(await svc.detect('abc123')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('returns null without throwing when downloads dir does not exist', async () => {
    const svc = new ResumeService(
      { get: () => ({ paths: { downloads: '/nonexistent/path', outputs: '/out' } }) },
      fsPromises,
    );
    expect(await svc.detect('abc123')).toBeNull();
  });

  it('skips meta.json files that fail to parse', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      await writeFile(join(dl, 'a.webm.meta.json'), 'not-json');
      // Valid sibling that should still be found.
      const sourcePath = join(dl, 'b.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      const snap = await svc.detect('abc123');
      expect(snap?.sourcePath).toBe(sourcePath);
    } finally {
      await cleanup();
    }
  });

  it('picks the most recent on duplicate videoId matches', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      const oldPath = join(dl, 'old.webm');
      const newPath = join(dl, 'new.webm');
      await writeFile(oldPath, 'fake');
      await writeFile(newPath, 'fake');
      await writeFile(`${oldPath}.meta.json`, JSON.stringify(baseMeta));
      // Make `new`'s meta.json mtime newer
      await new Promise((r) => setTimeout(r, 10));
      await writeFile(`${newPath}.meta.json`, JSON.stringify(baseMeta));
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      const snap = await svc.detect('abc123');
      expect(snap?.sourcePath).toBe(newPath);
    } finally {
      await cleanup();
    }
  });
});
```

- [ ] **Step 2: Run — tests should fail (detect still returns null)**

```bash
yarn test src/main/services/ResumeService.test.ts
```

- [ ] **Step 3: Implement `detect()` in `src/main/services/ResumeService.ts`**

Replace the entire file with:

```ts
import type { ResumeSnapshot } from '@shared/resume';
import { type VideoMeta, VideoMetaSchema } from '@shared/youtube';
import { extname, join } from 'node:path';

interface SettingsLike {
  get(): { paths: { downloads: string; outputs: string } };
}

type FsLike = {
  readdir: (dir: string) => Promise<string[]>;
  readFile: (path: string, enc: 'utf8') => Promise<string>;
  access: (path: string) => Promise<void>;
  stat: (path: string) => Promise<{ mtimeMs: number }>;
};

const META_SUFFIX = '.meta.json';

/**
 * Detect and hydrate prior pipeline runs from on-disk artifacts. No caching
 * — meta.json files are tiny (~300 bytes) and a typical user has < 100
 * prior downloads, so a full directory scan per call is fine.
 */
export class ResumeService {
  constructor(
    private readonly settings: SettingsLike,
    private readonly fs: FsLike,
  ) {}

  async detect(videoId: string): Promise<ResumeSnapshot | null> {
    const downloadsDir = this.settings.get().paths.downloads;
    let entries: string[];
    try {
      entries = await this.fs.readdir(downloadsDir);
    } catch {
      return null; // dir doesn't exist or unreadable — no resume
    }
    const candidates: { sourcePath: string; meta: VideoMeta; mtimeMs: number }[] = [];
    for (const name of entries) {
      if (!name.endsWith(META_SUFFIX)) continue;
      const metaPath = join(downloadsDir, name);
      const sourcePath = metaPath.slice(0, -META_SUFFIX.length);
      let raw: string;
      try {
        raw = await this.fs.readFile(metaPath, 'utf8');
      } catch {
        continue;
      }
      let meta: VideoMeta;
      try {
        meta = VideoMetaSchema.parse(JSON.parse(raw));
      } catch {
        continue; // corrupt/legacy meta.json — skip silently
      }
      if (meta.id !== videoId) continue;
      try {
        await this.fs.access(sourcePath);
      } catch {
        continue; // source video file missing — not a valid resume target
      }
      let mtimeMs = 0;
      try {
        mtimeMs = (await this.fs.stat(metaPath)).mtimeMs;
      } catch {
        // fall through with mtime=0 — sort still works for single matches
      }
      candidates.push({ sourcePath, meta, mtimeMs });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const winner = candidates[0]!;
    return {
      url: winner.meta.webpageUrl,
      sourcePath: winner.sourcePath,
      meta: winner.meta,
      download: { outputPath: winner.sourcePath },
    };
  }

  async hydrate(_sourcePath: string): Promise<ResumeSnapshot | null> {
    return null; // implemented in Task 3
  }
}

// Reserve `extname` import — Task 3 uses it for outputDir reconstruction.
void extname;
```

(The unused `extname` reservation keeps the import set stable for Task 3.)

- [ ] **Step 4: Run tests — 8/8 should pass (2 smoke + 6 detect)**

```bash
yarn test src/main/services/ResumeService.test.ts
```

If `node:fs` types reject `fsPromises` because `stat` isn't in the test's `FsLike` interface — verify Step 1's `FsLike` type matches. The skeleton's `FsLike` was 3 methods; this task widens it to 4 (`stat` added). The skeleton-test's `makeStubFs` doesn't have `stat`, but those tests pass `makeStubFs` to ResumeService — `detect` only calls `readdir`. The skeleton tests still pass without `stat`.

Actually that's not true — `detect()` calls `stat()`. But the skeleton-test's `detect` test gives an empty `readdir` so the loop never runs and `stat` is never called. The skeleton's `makeStubFs` only needs `readdir` populated. TypeScript compilation will complain, though, because `makeStubFs` returns an object missing `stat`. Add a stub:

```ts
function makeStubFs() {
  return {
    readdir: vi.fn(async (_d: string) => [] as string[]),
    readFile: vi.fn(async (_p: string, _e: 'utf8') => ''),
    access: vi.fn(async (_p: string) => undefined),
    stat: vi.fn(async (_p: string) => ({ mtimeMs: 0 })),
  };
}
```

Edit `makeStubFs` in the test file accordingly.

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/services/ResumeService.ts src/main/services/ResumeService.test.ts
git add src/main/services/ResumeService.ts src/main/services/ResumeService.test.ts
git commit -m "feat: ResumeService.detect — scan downloads, match videoId, return download-only snapshot"
```

---

### Task 3: `ResumeService.hydrate()` + sibling artifact reading + render reconstruction

**Files:**

- Modify: `src/main/services/ResumeService.ts`
- Modify: `src/main/services/ResumeService.test.ts`

Adds `hydrate(sourcePath)` and refactors detect's snapshot construction to share a `buildSnapshot()` helper that reads transcript.json / highlights.json / outputs/<stem>/short\_\*.mp4 if present.

- [ ] **Step 1: Append hydrate tests to `src/main/services/ResumeService.test.ts`**

```ts
describe('ResumeService.hydrate (real fs)', () => {
  it('returns null when meta.json does not exist for sourcePath', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      expect(await svc.hydrate(join(dl, 'no-meta.webm'))).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('builds download-only snapshot when only meta + source exist', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      const sourcePath = join(dl, 'a.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      const snap = await svc.hydrate(sourcePath);
      expect(snap?.download.outputPath).toBe(sourcePath);
      expect(snap?.transcript).toBeUndefined();
      expect(snap?.highlights).toBeUndefined();
      expect(snap?.render).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('includes transcript when transcript.json exists and parses', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      const sourcePath = join(dl, 'a.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      await writeFile(
        `${sourcePath}.transcript.json`,
        JSON.stringify({
          duration: 60,
          language: 'en',
          segments: [{ start: 0, end: 5, text: 'hi' }],
          words: [{ start: 0, end: 1, text: 'hi' }],
        }),
      );
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      const snap = await svc.hydrate(sourcePath);
      expect(snap?.transcript?.path).toBe(`${sourcePath}.transcript.json`);
      expect(snap?.transcript?.data.segments).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('skips transcript when JSON is corrupt', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      const sourcePath = join(dl, 'a.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      await writeFile(`${sourcePath}.transcript.json`, 'not-json');
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      const snap = await svc.hydrate(sourcePath);
      expect(snap?.transcript).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('includes highlights when highlights.json exists', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      const sourcePath = join(dl, 'a.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      await writeFile(
        `${sourcePath}.highlights.json`,
        JSON.stringify({
          generatedAt: '2026-05-10T00:00:00Z',
          model: 'gemma-3-4b',
          audioPath: sourcePath,
          highlights: [{ segments: [{ start_sec: 0, end_sec: 5 }], title: 'T', hook: 'h' }],
        }),
      );
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      const snap = await svc.hydrate(sourcePath);
      expect(snap?.highlights?.data.highlights).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('rebuilds render result from outputs/<stem>/short_*.mp4 when present', async () => {
    const { dl, cleanup } = await withTempDl();
    const out = await mkdtemp(join(tmpdir(), 'resume-out-'));
    try {
      const sourcePath = join(dl, 'video.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      await writeFile(
        `${sourcePath}.highlights.json`,
        JSON.stringify({
          generatedAt: '2026-05-10T00:00:00Z',
          model: 'gemma-3-4b',
          audioPath: sourcePath,
          highlights: [
            { segments: [{ start_sec: 0, end_sec: 5 }], title: 'A', hook: 'a' },
            { segments: [{ start_sec: 10, end_sec: 15 }], title: 'B', hook: 'b' },
          ],
        }),
      );
      const stemOut = join(out, 'video');
      await fsPromises.mkdir(stemOut, { recursive: true });
      await writeFile(join(stemOut, 'short_1.mp4'), 'mp4-1');
      await writeFile(join(stemOut, 'short_2.mp4'), 'mp4-2');
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: out } }) }, fsPromises);
      const snap = await svc.hydrate(sourcePath);
      expect(snap?.render).toBeDefined();
      expect(snap!.render!.result.results).toHaveLength(2);
      expect(snap!.render!.result.results[0]!.outputPath).toBe(join(stemOut, 'short_1.mp4'));
      expect(snap!.render!.result.results[0]!.title).toBe('A');
      expect(snap!.render!.result.results[1]!.title).toBe('B');
      expect(snap!.render!.result.results[0]!.status).toBe('done');
    } finally {
      await cleanup();
      await rm(out, { recursive: true, force: true });
    }
  });

  it('omits render when outputs/<stem>/ has no mp4 files', async () => {
    const { dl, cleanup } = await withTempDl();
    const out = await mkdtemp(join(tmpdir(), 'resume-out-'));
    try {
      const sourcePath = join(dl, 'video.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      // outputs/<stem>/ exists but is empty
      await fsPromises.mkdir(join(out, 'video'), { recursive: true });
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: out } }) }, fsPromises);
      const snap = await svc.hydrate(sourcePath);
      expect(snap?.render).toBeUndefined();
    } finally {
      await cleanup();
      await rm(out, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
yarn test src/main/services/ResumeService.test.ts
```

- [ ] **Step 3: Replace `src/main/services/ResumeService.ts` ENTIRELY with**

```ts
import { type HighlightSet, HighlightSetSchema } from '@shared/highlight';
import type { RenderClipResult, RenderResult } from '@shared/render';
import type { ResumeSnapshot } from '@shared/resume';
import { type Transcript, TranscriptSchema } from '@shared/transcript';
import { type VideoMeta, VideoMetaSchema } from '@shared/youtube';
import { basename, extname, join } from 'node:path';

interface SettingsLike {
  get(): { paths: { downloads: string; outputs: string } };
}

type FsLike = {
  readdir: (dir: string) => Promise<string[]>;
  readFile: (path: string, enc: 'utf8') => Promise<string>;
  access: (path: string) => Promise<void>;
  stat: (path: string) => Promise<{ mtimeMs: number }>;
};

const META_SUFFIX = '.meta.json';

/**
 * Detect and hydrate prior pipeline runs from on-disk artifacts. No caching
 * — meta.json files are tiny (~300 bytes) and a typical user has < 100
 * prior downloads, so a full directory scan per call is fine.
 */
export class ResumeService {
  constructor(
    private readonly settings: SettingsLike,
    private readonly fs: FsLike,
  ) {}

  async detect(videoId: string): Promise<ResumeSnapshot | null> {
    const downloadsDir = this.settings.get().paths.downloads;
    let entries: string[];
    try {
      entries = await this.fs.readdir(downloadsDir);
    } catch {
      return null;
    }
    const candidates: { sourcePath: string; meta: VideoMeta; mtimeMs: number }[] = [];
    for (const name of entries) {
      if (!name.endsWith(META_SUFFIX)) continue;
      const metaPath = join(downloadsDir, name);
      const sourcePath = metaPath.slice(0, -META_SUFFIX.length);
      const meta = await this.tryReadMeta(metaPath);
      if (!meta || meta.id !== videoId) continue;
      try {
        await this.fs.access(sourcePath);
      } catch {
        continue;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = (await this.fs.stat(metaPath)).mtimeMs;
      } catch {
        // ignore
      }
      candidates.push({ sourcePath, meta, mtimeMs });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const winner = candidates[0]!;
    return this.buildSnapshot(winner.sourcePath, winner.meta);
  }

  async hydrate(sourcePath: string): Promise<ResumeSnapshot | null> {
    const meta = await this.tryReadMeta(`${sourcePath}${META_SUFFIX}`);
    if (!meta) return null;
    try {
      await this.fs.access(sourcePath);
    } catch {
      return null;
    }
    return this.buildSnapshot(sourcePath, meta);
  }

  private async tryReadMeta(metaPath: string): Promise<VideoMeta | null> {
    let raw: string;
    try {
      raw = await this.fs.readFile(metaPath, 'utf8');
    } catch {
      return null;
    }
    try {
      return VideoMetaSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private async buildSnapshot(sourcePath: string, meta: VideoMeta): Promise<ResumeSnapshot> {
    const transcriptPath = `${sourcePath}.transcript.json`;
    const highlightsPath = `${sourcePath}.highlights.json`;
    const stem = basename(sourcePath, extname(sourcePath));
    const outputDir = join(this.settings.get().paths.outputs, stem);

    const [transcript, highlights] = await Promise.all([
      this.tryReadJson<Transcript>(transcriptPath, (raw) => TranscriptSchema.parse(JSON.parse(raw))),
      this.tryReadJson<HighlightSet>(highlightsPath, (raw) => HighlightSetSchema.parse(JSON.parse(raw))),
    ]);

    const renderResult = await this.tryRebuildRender(outputDir, highlights);

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

  private async tryReadJson<T>(path: string, parse: (raw: string) => T): Promise<T | null> {
    try {
      const raw = await this.fs.readFile(path, 'utf8');
      return parse(raw);
    } catch {
      return null;
    }
  }

  private async tryRebuildRender(
    outputDir: string,
    highlightSet: HighlightSet | null,
  ): Promise<{ outputDir: string; result: RenderResult } | undefined> {
    if (!highlightSet) return undefined;
    let files: string[];
    try {
      files = await this.fs.readdir(outputDir);
    } catch {
      return undefined;
    }
    const shorts = files.filter((f) => /^short_\d+\.mp4$/.test(f)).sort();
    if (shorts.length === 0) return undefined;
    const results: RenderClipResult[] = shorts.map((file, idx) => {
      const highlight = highlightSet.highlights[idx];
      const segments = highlight?.segments ?? [];
      const startSec = segments[0]?.start_sec ?? 0;
      const endSec = segments[segments.length - 1]?.end_sec ?? 0;
      const montageDurationSec = segments.reduce((acc, s) => acc + (s.end_sec - s.start_sec), 0);
      return {
        index: idx + 1,
        title: highlight?.title ?? `Clip ${idx + 1}`,
        startSec,
        endSec,
        montageDurationSec,
        status: 'done' as const,
        outputPath: join(outputDir, file),
        tracking: null,
        subtitles: null,
      };
    });
    return { outputDir, result: { outputDir, results } };
  }
}
```

- [ ] **Step 4: Run tests — should pass (2 smoke + 6 detect + 7 hydrate = 15)**

```bash
yarn test src/main/services/ResumeService.test.ts
```

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/services/ResumeService.ts src/main/services/ResumeService.test.ts
git add src/main/services/ResumeService.ts src/main/services/ResumeService.test.ts
git commit -m "feat: ResumeService.hydrate + buildSnapshot (transcript/highlights/render reconstruction)"
```

---

### Task 4: Wire IPC — main.ts + preload + AppApi

**Files:**

- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/shared/ipc.ts`

Adds `resume:detect` and `resume:hydrate` IPC handlers + preload bridge methods + `AppApi` interface entries.

- [ ] **Step 1: Add to `src/shared/ipc.ts`**

Add the import at the top:

```ts
import type { ResumeSnapshot } from './resume';
```

Add these methods to the `AppApi` interface (place them just before `revealInFolder`):

```ts
  /** Detect prior pipeline run by videoId. Returns null if none. */
  resumeDetect(videoId: string): Promise<ResumeSnapshot | null>;
  /** Build snapshot from a known sourcePath (used by History entry). */
  resumeHydrate(sourcePath: string): Promise<ResumeSnapshot | null>;
```

- [ ] **Step 2: Add to `src/main/preload.ts`**

After the existing `extractHighlights` block (right before `renderShorts`), add:

```ts
  resumeDetect: (videoId: string) => ipcRenderer.invoke('resume:detect', videoId),
  resumeHydrate: (sourcePath: string) => ipcRenderer.invoke('resume:hydrate', sourcePath),
```

- [ ] **Step 3: Wire in `src/main/main.ts`**

Add the import at the top with other infra imports:

```ts
import { ResumeService } from './services/ResumeService';
```

Add a state var near the other lazy-singletons (top of file):

```ts
let resumeService: ResumeService | null = null;
```

Add a getter near the other `getXService` functions:

```ts
function getResumeService(): ResumeService {
  if (resumeService) return resumeService;
  resumeService = new ResumeService(settingsStore, fsPromises);
  return resumeService;
}
```

Add IPC handlers inside `app.whenReady().then(...)`, near the existing `extract:run` handler:

```ts
ipcMain.handle('resume:detect', (_e, videoId: string) => getResumeService().detect(videoId));
ipcMain.handle('resume:hydrate', (_e, sourcePath: string) => getResumeService().hydrate(sourcePath));
```

Cleanup in `window-all-closed`:

```ts
resumeService = null;
```

(Add it where other singletons are nulled.)

- [ ] **Step 4: Verify typecheck + lint**

```bash
yarn typecheck && yarn lint 2>&1 | tail -3
```

Both should be 0 errors (1 pre-existing `__dirname` warning is OK).

- [ ] **Step 5: Run all tests — no regressions**

```bash
yarn test 2>&1 | tail -7
```

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/main/preload.ts src/main/main.ts
git commit -m "feat: wire resume:detect + resume:hydrate IPCs (main + preload + AppApi)"
```

---

### Task 5: Hook hydrators (5 hooks)

**Files:**

- Modify: `src/renderer/hooks/useVideoPreview.ts`
- Modify: `src/renderer/hooks/useDownload.ts`
- Modify: `src/renderer/hooks/useTranscribe.ts`
- Modify: `src/renderer/hooks/useHighlights.ts`
- Modify: `src/renderer/hooks/useRender.ts`

Each hook gets a `hydrate*()` method on its return type that pushes the hook directly to `done` (or `loaded` for preview). No tests — these are 1-line setState wrappers covered by the integration test in Task 8 (NewJob.test.tsx).

- [ ] **Step 1: `src/renderer/hooks/useVideoPreview.ts`** — extend the `UseVideoPreview` type and add `hydrateLoaded`

Replace the `UseVideoPreview` type and the bottom of the function:

```ts
export type UseVideoPreview = {
  state: VideoPreviewState;
  fetch: (url: string) => Promise<void>;
  hydrateLoaded: (url: string, meta: VideoMeta) => void;
  reset: () => void;
};

export function useVideoPreview(): UseVideoPreview {
  const [state, setState] = useState<VideoPreviewState>({ status: 'idle' });

  const fetch = useCallback(async (url: string) => {
    setState({ status: 'loading', url });
    try {
      const meta = await window.api.fetchVideoPreview(url);
      setState({ status: 'loaded', url, meta });
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      setState({ status: 'error', url, error });
    }
  }, []);

  const hydrateLoaded = useCallback((url: string, meta: VideoMeta) => {
    setState({ status: 'loaded', url, meta });
  }, []);

  const reset = useCallback(() => {
    setState({ status: 'idle' });
  }, []);

  return { state, fetch, hydrateLoaded, reset };
}
```

- [ ] **Step 2: `src/renderer/hooks/useDownload.ts`** — extend `UseDownload` and add `hydrateDone`

Add to the `UseDownload` type:

```ts
  hydrateDone: (url: string, outputPath: string) => void;
```

Add the implementation inside `useDownload()` (after `cancel`, before `reset`):

```ts
const hydrateDone = useCallback((url: string, outputPath: string) => {
  urlRef.current = url;
  setState({ status: 'done', url, outputPath });
}, []);
```

Update the return statement to include `hydrateDone`.

- [ ] **Step 3: `src/renderer/hooks/useTranscribe.ts`** — extend and add

Add to type:

```ts
  hydrateDone: (audioPath: string, transcriptPath: string, transcript: Transcript) => void;
```

Add implementation:

```ts
const hydrateDone = useCallback((audioPath: string, transcriptPath: string, transcript: Transcript) => {
  setState({ status: 'done', audioPath, transcriptPath, transcript });
}, []);
```

Update return statement.

- [ ] **Step 4: `src/renderer/hooks/useHighlights.ts`** — extend and add

Read the file first to see the current `HighlightState` and return shape.

Add to `UseHighlights` type:

```ts
  hydrateDone: (audioPath: string, highlightsPath: string, highlightSet: HighlightSet) => void;
```

Add implementation (after `cancel`, before `reset`):

```ts
const hydrateDone = useCallback((audioPath: string, highlightsPath: string, highlightSet: HighlightSet) => {
  abortRef.current = true; // any in-flight extraction's promise resolution will be ignored
  setState({ status: 'done', audioPath, highlightsPath, highlightSet });
}, []);
```

Update return statement.

- [ ] **Step 5: `src/renderer/hooks/useRender.ts`** — extend and add

Add to type:

```ts
  hydrateDone: (audioPath: string, result: RenderResult) => void;
```

Add implementation:

```ts
const hydrateDone = useCallback((audioPath: string, result: RenderResult) => {
  abortRef.current = true;
  setState({ status: 'done', audioPath, result });
}, []);
```

Update return statement.

- [ ] **Step 6: Verify typecheck**

```bash
yarn typecheck 2>&1 | tail -10
```

Expected errors: only the existing `tests/renderer/NewJob.test.tsx` may complain because the test file constructs a context value that doesn't include `hydrate` (Task 6 fixes that). Other hook consumers that don't use the new methods are unaffected (additive change).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/hooks/useVideoPreview.ts src/renderer/hooks/useDownload.ts src/renderer/hooks/useTranscribe.ts src/renderer/hooks/useHighlights.ts src/renderer/hooks/useRender.ts
git commit -m "feat: add hydrate*() to all 5 NewJob pipeline hooks"
```

---

### Task 6: `NewJobStateContext.hydrate(snapshot)`

**Files:**

- Modify: `src/renderer/components/NewJobStateContext.tsx`

Adds a `hydrate(snapshot)` method to the context that calls each hook's hydrator in dependency order.

- [ ] **Step 1: Replace `src/renderer/components/NewJobStateContext.tsx` ENTIRELY with**

```tsx
import { type ReactNode, createContext, useContext, useMemo } from 'react';

import { type UseDownload, useDownload } from '@renderer/hooks/useDownload';
import { type UseHighlights, useHighlights } from '@renderer/hooks/useHighlights';
import { type UseRender, useRender } from '@renderer/hooks/useRender';
import { type UseTranscribe, useTranscribe } from '@renderer/hooks/useTranscribe';
import { type UseVideoPreview, useVideoPreview } from '@renderer/hooks/useVideoPreview';
import type { ResumeSnapshot } from '@shared/resume';

/**
 * Hoists the new-job pipeline state above react-router's Outlet so navigating
 * away (e.g. to History or Settings) and back doesn't unmount the hooks and
 * lose the in-progress pipeline state. The IPC progress subscriptions also
 * stay live so background events keep updating state while the user is on
 * another page.
 *
 * Also exposes a `hydrate(snapshot)` entry point for the resume-prior-job
 * feature: callers (URL re-paste banner, History "이어서 작업" button) push
 * a ResumeSnapshot in and the relevant hooks jump straight to their done
 * states.
 */
export interface NewJobState {
  preview: UseVideoPreview;
  download: UseDownload;
  transcribe: UseTranscribe;
  highlights: UseHighlights;
  renderShort: UseRender;
  hydrate: (snapshot: ResumeSnapshot) => void;
}

const NewJobStateCtx = createContext<NewJobState | null>(null);

export function NewJobStateProvider({ children }: { children: ReactNode }) {
  const preview = useVideoPreview();
  const download = useDownload();
  const transcribe = useTranscribe();
  const highlights = useHighlights();
  const renderShort = useRender();

  const value = useMemo<NewJobState>(
    () => ({
      preview,
      download,
      transcribe,
      highlights,
      renderShort,
      hydrate(snapshot) {
        preview.hydrateLoaded(snapshot.url, snapshot.meta);
        download.hydrateDone(snapshot.url, snapshot.download.outputPath);
        if (snapshot.transcript) {
          transcribe.hydrateDone(snapshot.sourcePath, snapshot.transcript.path, snapshot.transcript.data);
        }
        if (snapshot.highlights) {
          highlights.hydrateDone(snapshot.sourcePath, snapshot.highlights.path, snapshot.highlights.data);
        }
        if (snapshot.render) {
          renderShort.hydrateDone(snapshot.sourcePath, snapshot.render.result);
        }
      },
    }),
    [preview, download, transcribe, highlights, renderShort],
  );

  return <NewJobStateCtx.Provider value={value}>{children}</NewJobStateCtx.Provider>;
}

export function useNewJobState(): NewJobState {
  const ctx = useContext(NewJobStateCtx);
  if (!ctx) {
    throw new Error('useNewJobState must be used within NewJobStateProvider');
  }
  return ctx;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
yarn typecheck 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/NewJobStateContext.tsx
git commit -m "feat: NewJobStateContext.hydrate(snapshot) — push ResumeSnapshot into all 5 hooks"
```

---

### Task 7: `ResumeBanner` component

**Files:**

- Create: `src/renderer/components/newjob/ResumeBanner.tsx`

A small presentational component shown above PreviewCard when a snapshot is available. Two buttons: 이어서 작업 / 새로 시작.

- [ ] **Step 1: Create `src/renderer/components/newjob/ResumeBanner.tsx`**

```tsx
import type { ResumeSnapshot } from '@shared/resume';

interface Props {
  snapshot: ResumeSnapshot;
  onResume: () => void;
  onDismiss: () => void;
}

function describeProgress(snapshot: ResumeSnapshot): string {
  if (snapshot.render) return '이미 숏츠까지 만들어진 영상이에요.';
  if (snapshot.highlights) return '하이라이트 추출까지 완료된 영상이에요.';
  if (snapshot.transcript) return 'STT까지 완료된 영상이에요.';
  return '다운로드만 완료된 영상이에요.';
}

export function ResumeBanner({ snapshot, onResume, onDismiss }: Props) {
  return (
    <section className="border-hairline bg-canvas p-md border-l-brand-blue rounded-lg border border-l-4">
      <p className="text-body-md text-ink">{describeProgress(snapshot)}</p>
      <p className="text-body-sm text-slate mt-xs break-all">{snapshot.sourcePath}</p>
      <div className="gap-sm mt-md flex">
        <button
          type="button"
          onClick={onResume}
          className="bg-primary px-xl text-button-md text-on-primary h-10 rounded-full font-semibold"
        >
          이어서 작업
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="border-ink px-xl text-button-md text-ink h-10 rounded-full border bg-transparent font-semibold"
        >
          새로 시작
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Verify typecheck**

```bash
yarn typecheck 2>&1 | tail -3
```

- [ ] **Step 3: Format + commit**

```bash
yarn prettier --write src/renderer/components/newjob/ResumeBanner.tsx
git add src/renderer/components/newjob/ResumeBanner.tsx
git commit -m "feat: ResumeBanner — '이어서 작업' / '새로 시작' card shown when prior job is detected"
```

---

### Task 8: NewJob page integration — probe + render banner + integration test

**Files:**

- Modify: `src/renderer/pages/NewJob.tsx`
- Modify: `tests/renderer/NewJob.test.tsx`

NewJob page:

- New `useEffect`: when `preview.state.status === 'loaded'` AND `download.state.status === 'idle'` AND user hasn't dismissed, call `window.api.resumeDetect(meta.id)`.
- New local state `resumeSnapshot` and `resumeDismissed`.
- Render `<ResumeBanner>` between PreviewCard and DownloadProgress when conditions met.

- [ ] **Step 1: Read `src/renderer/pages/NewJob.tsx` end-to-end**

Use the Read tool to look at the current file. Identify where PreviewCard is rendered (currently inside the `{preview.state.status === 'loaded' && download.state.status === 'idle' ? (...) : null}` block).

- [ ] **Step 2: Update imports in `src/renderer/pages/NewJob.tsx`**

Add at the top:

```ts
import { useEffect, useState } from 'react';

import { ResumeBanner } from '@renderer/components/newjob/ResumeBanner';
import type { ResumeSnapshot } from '@shared/resume';
```

- [ ] **Step 3: Add resume state + effect inside `NewJobPage`**

After the destructure of `useNewJobState()`:

```ts
const [resumeSnapshot, setResumeSnapshot] = useState<ResumeSnapshot | null>(null);
const [resumeDismissed, setResumeDismissed] = useState(false);

useEffect(() => {
  if (preview.state.status !== 'loaded') {
    setResumeSnapshot(null);
    setResumeDismissed(false);
    return;
  }
  if (resumeDismissed) return;
  if (download.state.status !== 'idle') return;
  let cancelled = false;
  void window.api.resumeDetect(preview.state.meta.id).then((snap) => {
    if (!cancelled) setResumeSnapshot(snap);
  });
  return () => {
    cancelled = true;
  };
}, [preview.state, download.state.status, resumeDismissed]);
```

- [ ] **Step 4: Render `<ResumeBanner>` in the JSX**

Find the PreviewCard render block. Insert the banner just before it:

```tsx
      {preview.state.status === 'loaded' && download.state.status === 'idle' && resumeSnapshot && !resumeDismissed ? (
        <ResumeBanner
          snapshot={resumeSnapshot}
          onResume={() => {
            hydrate(resumeSnapshot);
            setResumeSnapshot(null);
          }}
          onDismiss={() => setResumeDismissed(true)}
        />
      ) : null}

      {preview.state.status === 'loaded' && download.state.status === 'idle' ? (
        <PreviewCard ... />
      ) : null}
```

(The PreviewCard block is the existing one — unchanged. The banner is a peer above it.)

You'll also need to destructure `hydrate` from `useNewJobState()`:

```ts
const { preview, download, transcribe, highlights, renderShort, hydrate } = useNewJobState();
```

- [ ] **Step 5: Update `tests/renderer/NewJob.test.tsx` window.api stub**

Find the `installApiMock` (or wherever the `window.api` stub lives). Add to the mock object:

```ts
  resumeDetect: vi.fn(async (_id: string) => null),
  resumeHydrate: vi.fn(async (_p: string) => null),
```

- [ ] **Step 6: Add 2 resume tests at the bottom of `tests/renderer/NewJob.test.tsx`**

```tsx
it('shows ResumeBanner when resumeDetect returns a snapshot and hydrates on click', async () => {
  const user = userEvent.setup();
  const snap = {
    url: 'https://youtu.be/dQw4w9WgXcQ',
    sourcePath: '/tmp/dQw4w9WgXcQ.mp4',
    meta: {
      id: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      channel: 'Rick Astley',
      durationSec: 213,
      thumbnailUrl: 'https://example.com/t.jpg',
      webpageUrl: 'https://youtu.be/dQw4w9WgXcQ',
    },
    download: { outputPath: '/tmp/dQw4w9WgXcQ.mp4' },
    transcript: undefined,
    highlights: undefined,
    render: undefined,
  };
  (window.api.resumeDetect as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
  render(
    <NewJobStateProvider>
      <NewJobPage />
    </NewJobStateProvider>,
  );
  await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
  await user.click(screen.getByRole('button', { name: '미리보기' }));
  // Banner appears with download-only progress copy
  await waitFor(() => expect(screen.getByText(/다운로드만 완료된 영상/)).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: '이어서 작업' }));
  // After hydrate: banner gone, DownloadProgress 'done' is shown
  await waitFor(() => expect(screen.queryByText(/다운로드만 완료된 영상/)).not.toBeInTheDocument());
});

it('hides ResumeBanner when 새로 시작 is clicked', async () => {
  const user = userEvent.setup();
  const snap = {
    url: 'https://youtu.be/dQw4w9WgXcQ',
    sourcePath: '/tmp/dQw4w9WgXcQ.mp4',
    meta: {
      id: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      channel: 'Rick Astley',
      durationSec: 213,
      thumbnailUrl: 'https://example.com/t.jpg',
      webpageUrl: 'https://youtu.be/dQw4w9WgXcQ',
    },
    download: { outputPath: '/tmp/dQw4w9WgXcQ.mp4' },
    transcript: undefined,
    highlights: undefined,
    render: undefined,
  };
  (window.api.resumeDetect as ReturnType<typeof vi.fn>).mockResolvedValue(snap);
  render(
    <NewJobStateProvider>
      <NewJobPage />
    </NewJobStateProvider>,
  );
  await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
  await user.click(screen.getByRole('button', { name: '미리보기' }));
  await waitFor(() => expect(screen.getByText(/다운로드만 완료된 영상/)).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: '새로 시작' }));
  expect(screen.queryByText(/다운로드만 완료된 영상/)).not.toBeInTheDocument();
});
```

(Reset the `resumeDetect` mock between tests if the test file uses `beforeEach`. Add `beforeEach(() => (window.api.resumeDetect as ReturnType<typeof vi.fn>).mockResolvedValue(null))` if needed to keep prior tests clean.)

- [ ] **Step 7: Run NewJob test suite**

```bash
yarn test tests/renderer/NewJob.test.tsx 2>&1 | tail -10
```

- [ ] **Step 8: Verify all tests + commit**

```bash
yarn typecheck && yarn test 2>&1 | tail -7
git add src/renderer/pages/NewJob.tsx tests/renderer/NewJob.test.tsx
git commit -m "feat: NewJob page probes resumeDetect on preview→loaded; ResumeBanner with hydrate flow"
```

---

### Task 9: History "이어서 작업" button + test

**Files:**

- Modify: `src/renderer/components/history/JobDetailDrawer.tsx`
- Modify: `tests/renderer/History.test.tsx`

Adds a button to the JobDetailDrawer that navigates to `/` and calls `resumeHydrate(job.sourcePath)`.

- [ ] **Step 1: Update `src/renderer/components/history/JobDetailDrawer.tsx`**

Add imports at the top:

```ts
import { useNewJobState } from '@renderer/components/NewJobStateContext';
import { useNavigate } from 'react-router-dom';
```

Inside the `JobDetailDrawer` function body (top), add:

```ts
const navigate = useNavigate();
const { hydrate } = useNewJobState();

async function handleResume() {
  if (!detail) return;
  const snap = await window.api.resumeHydrate(detail.job.sourcePath);
  if (snap) {
    hydrate(snap);
    navigate('/');
    onClose();
  } else {
    // Source file is gone or meta corrupt — silently bail; user stays on history.
    // (Future: show a toast.)
  }
}
```

In the JSX `<div className="gap-sm flex">` block (the existing buttons section), add a new button as the FIRST child:

```tsx
<button
  type="button"
  onClick={() => void handleResume()}
  className="bg-primary px-xl text-button-md text-on-primary h-10 rounded-full font-semibold"
>
  이어서 작업
</button>
```

(The existing "폴더 열기" button changes from `bg-primary` to `border-ink ... border bg-transparent` style if the design wants only one primary action per card. But to keep the change minimal, leave the existing buttons styled as they are — having two `bg-primary` buttons is acceptable for v1.)

- [ ] **Step 2: Update `tests/renderer/History.test.tsx` window.api stub**

Add to the mock object:

```ts
  resumeDetect: vi.fn(async (_id: string) => null),
  resumeHydrate: vi.fn(async (_p: string) => ({
    url: 'https://youtu.be/x',
    sourcePath: '/tmp/x.mp4',
    meta: {
      id: 'x',
      title: 'X',
      channel: 'C',
      durationSec: 60,
      thumbnailUrl: 'https://example.com/t.jpg',
      webpageUrl: 'https://youtu.be/x',
    },
    download: { outputPath: '/tmp/x.mp4' },
  })),
```

- [ ] **Step 3: Add a test for "이어서 작업" button click**

Append to `tests/renderer/History.test.tsx`:

```tsx
it('clicks 이어서 작업 in JobDetailDrawer to call resumeHydrate', async () => {
  const user = userEvent.setup();
  // (reuse existing test setup that opens the drawer for a job — see other tests in this file
  //  for the exact pattern. Once the drawer is open with detail loaded, click 이어서 작업.)
  // ...
  await user.click(await screen.findByRole('button', { name: '이어서 작업' }));
  expect(window.api.resumeHydrate).toHaveBeenCalled();
});
```

(Consult the existing tests in this file for the JobDetailDrawer-opening pattern — the click flow that triggers `historyGetDetail` and renders the drawer.)

- [ ] **Step 4: Verify**

```bash
yarn typecheck && yarn test 2>&1 | tail -7
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/history/JobDetailDrawer.tsx tests/renderer/History.test.tsx
git commit -m "feat: '이어서 작업' button in JobDetailDrawer triggers resumeHydrate + navigate"
```

---

### Task 10: DoD verification + push

**Files:** none

- [ ] **Step 1: Run all DoD checks**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn typecheck && echo "TYPECHECK OK"
yarn lint && echo "LINT OK"
yarn test 2>&1 | tail -7
yarn build 2>&1 | tail -5
cd sidecar && uv run pytest 2>&1 | tail -5 && cd ..
```

Expected:

- typecheck: 0 errors
- lint: 0 errors (1 known `__dirname` warning OK)
- vitest: 173 baseline + ~18 new = ~190 (give or take)
- yarn build: succeeds
- sidecar pytest: 37 pass (unchanged — this milestone has no Python changes)

If anything fails, STOP and report BLOCKED.

- [ ] **Step 2: Push to origin**

```bash
git push origin master 2>&1 | tail -3
```

- [ ] **Step 3: Manual integration check (controller hands off to user)**

Skip in this task — controller will hand off to user. Manual checks:

1. Paste a previously-downloaded URL → ResumeBanner appears with correct progress copy.
2. Click 이어서 작업 → relevant cards show done state.
3. Click 새로 시작 → banner disappears.
4. From History, click row → drawer opens → click 이어서 작업 → navigates to NewJob with all done.
5. Manually delete a previously-downloaded source video file → paste same URL → banner does NOT appear (snapshot null).
6. Paste a brand-new URL → no banner; normal flow works.

---

## Status

(Filled by the controller after each task is reviewed and merged.)

- [ ] Task 1: ResumeSnapshot + ResumeService skeleton
- [ ] Task 2: ResumeService.detect (TDD)
- [ ] Task 3: ResumeService.hydrate + buildSnapshot (TDD)
- [ ] Task 4: Wire IPC (main + preload + AppApi)
- [ ] Task 5: Hook hydrators (5 hooks)
- [ ] Task 6: NewJobStateContext.hydrate
- [ ] Task 7: ResumeBanner component
- [ ] Task 8: NewJob page integration + 2 vitest cases
- [ ] Task 9: History 이어서 작업 button + 1 vitest case
- [ ] Task 10: DoD + push

---

## Definition of Done

1. `yarn typecheck`, `yarn lint`, `yarn test`, `yarn build` all exit 0.
2. `cd sidecar && uv run pytest` reports 37 passing (unchanged — no Python work).
3. Vitest count is ~190 (baseline 173 + ~18 new from ResumeService + NewJob/History tests).
4. ResumeService is the single source of truth for snapshot construction; both IPCs (`resume:detect`, `resume:hydrate`) flow through `buildSnapshot`.
5. The 5 NewJob hooks each expose a `hydrate*()` method that's a thin setState wrapper to `done`.
6. URL re-paste of a prior job shows ResumeBanner above PreviewCard with the correct progress copy.
7. History detail drawer's "이어서 작업" button navigates + hydrates.
8. After "이어서 작업", `RenderCard` (and earlier cards) display the done state correctly.
9. Pushed to origin master.

---

## What's NOT in scope

- Restoring Settings (Whisper model, count, minSec/maxSec, subtitle style) from prior options — current Settings always apply
- Resuming partial downloads (yt-dlp atomicity)
- Multi-candidate UI when several meta.json files match (most-recent picked silently)
- Scanning workspace folder or any directory beyond `settings.paths.downloads`
- TTL cache of meta.json index (re-scan each call)
- Toast notification when resumeHydrate returns null from History (current: silent no-op)
- Hydrating state when the user is mid-pipeline on something else (banner suppressed by `download.status === 'idle'` guard)

---

## Notes for the implementing agent

- `youtubeService.fetchMeta(url)` already returns `id` (videoId) — no new YouTube parsing needed.
- The existing `VideoMetaSchema.parse(JSON.parse(...))`, `TranscriptSchema.parse(...)`, `HighlightSetSchema.parse(...)` all already exist; reuse imports.
- `process.resourcesPath` is not used here — this is dev-mode-only behavior reading from user-configured paths. Same paths work in packaged builds (M12).
- `useNavigate` from `react-router-dom` is already used in NewJob.tsx (was previously, removed in M11; re-add the import for the History drawer's case).
- `useNewJobState` accessed from inside JobDetailDrawer assumes the drawer is rendered within `NewJobStateProvider` — which is true because AppShell wraps everything.
- The `tests/renderer/NewJob.test.tsx` `installApiMock` pattern: prior tasks already updated it to include `llmDownloadModel/llmModelStatus/onLlmDownloadProgress`. Add the 2 resume methods to the same object.
- The bob-park ESLint config bans `../*` parent imports — use `@renderer/*`, `@shared/*` aliases.
- `settings.paths.downloads` is the canonical location; `settings.paths.outputs` is where renders land. Both come from `SettingsStore.get().paths`. ResumeService reads them fresh on each call (no snapshot of settings).
- The render reconstruction (`tryRebuildRender`) sets `tracking: null` and `subtitles: null` on every clip. The renderer's RenderCard `done` UI displays clips fine without those — they're optional per `RenderClipResultSchema`.
