# M3: YouTube Preview + Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder NewJob page with a real flow: paste a YouTube URL → see a preview card (thumbnail/title/channel/duration) → click 다운로드 → watch a live progress bar → confirm the resulting `.mp4` lives at `settings.paths.downloads/<videoId>.mp4`. The full STT/LLM pipeline stays out of scope; M3 only proves we can reliably get a YouTube video onto disk.

**Architecture:** A typed `YouTubeService` in main wraps `youtube-dl-exec`, exposing two surfaces — `fetchMeta()` (Promise<VideoMeta>) and `download()` (returns a handle with onProgress / cancel / done). The renderer talks to this surface through three new IPC methods plus a one-way `download:progress` event channel. Two renderer hooks (`useVideoPreview`, `useDownload`) wrap the IPC. The NewJob page composes URL input → preview → progress in a four-state machine (`idle` → `previewing` → `previewed` → `downloading|done|error|canceled`). URL validation lives in `src/shared/youtube.ts` and runs in BOTH processes — renderer for UX, main for security.

**Tech Stack:** youtube-dl-exec ^3.0 (bundles yt-dlp binary, no system install needed), zod 3+ (extending the existing schema set), Electron `webContents.send` / `ipcRenderer.on` for one-way progress events, React state machine in `useDownload`.

---

## File Structure

```
src/
├── shared/
│   ├── youtube.ts                  # NEW: VideoMeta, DownloadProgress, DownloadStatus, isYoutubeUrl, extractVideoId
│   └── ipc.ts                      # MODIFY: add fetchPreview, downloadVideo, cancelDownload, onDownloadProgress
├── main/
│   ├── main.ts                     # MODIFY: register 3 new IPC handlers + emit download:progress events
│   ├── preload.ts                  # MODIFY: expose new methods + onDownloadProgress subscription
│   └── services/
│       ├── YouTubeService.ts       # NEW: yt-dlp wrapper (fetchMeta + download with progress)
│       └── YouTubeService.test.ts  # NEW: unit tests with injected youtubeDl mock
└── renderer/
    ├── hooks/
    │   ├── useVideoPreview.ts      # NEW: URL → VideoMeta state machine
    │   └── useDownload.ts          # NEW: download lifecycle state machine
    ├── components/
    │   └── newjob/
    │       ├── UrlInput.tsx        # NEW: URL pill input + paste-aware + clear button
    │       ├── PreviewCard.tsx     # NEW: thumbnail + meta + 다운로드 button
    │       └── DownloadProgress.tsx# NEW: percent bar, ETA, cancel button, done state with "파일 열기"
    └── pages/
        └── NewJob.tsx              # MODIFY: state-machine composition
tests/
└── renderer/
    └── NewJob.test.tsx             # NEW: smoke (paste URL → preview shows → download fires)
```

**Decomposition rationale:**
- `src/shared/youtube.ts` lives in shared because URL validation must be identical on both ends of the IPC boundary, and the `VideoMeta`/`DownloadProgress` types are returned across that boundary.
- `YouTubeService` is the only place yt-dlp is imported. Tests inject a mock `youtubeDl` so we can exercise the wrapper logic without spawning a real binary.
- The `newjob/` component folder mirrors the `settings/` folder from M2 — page-scoped components living next to siblings they share idioms with.
- Two hooks (`useVideoPreview`, `useDownload`) instead of one — they have separate state machines and one fires its IPC channel before the other ever runs.

---

## Tasks

### Task 1: Shared YouTube types + URL validation

**Files:**
- Create: `src/shared/youtube.ts`

This file is imported by both main and renderer. Pure types and pure functions only.

- [ ] **Step 1: Create `src/shared/youtube.ts`**

```ts
import { z } from 'zod';

export const YOUTUBE_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
] as const;

export const VideoMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  channel: z.string().min(1),
  /** Duration in seconds. yt-dlp reports `duration` as a number. */
  durationSec: z.number().nonnegative(),
  thumbnailUrl: z.string().url(),
  webpageUrl: z.string().url(),
});
export type VideoMeta = z.infer<typeof VideoMetaSchema>;

export const DownloadProgressSchema = z.object({
  videoId: z.string().min(1),
  /** 0..100 */
  percent: z.number().min(0).max(100),
  /** Seconds remaining, or null if yt-dlp doesn't know yet. */
  etaSec: z.number().nonnegative().nullable(),
  downloadedBytes: z.number().nonnegative().nullable(),
  totalBytes: z.number().nonnegative().nullable(),
});
export type DownloadProgress = z.infer<typeof DownloadProgressSchema>;

export type DownloadStatus =
  | 'idle'
  | 'starting'
  | 'downloading'
  | 'done'
  | 'canceled'
  | 'error';

/** True iff input is a syntactically valid YouTube URL on a known host. */
export function isYoutubeUrl(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return (YOUTUBE_HOSTS as readonly string[]).includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Extracts the video id from a YouTube URL. Supports `?v=` query param,
 * `youtu.be/<id>` short links, and `/shorts/<id>` URLs. Returns null on
 * unrecognized shapes.
 */
export function extractVideoId(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.replace(/^\/+/, '').split('/')[0];
      return id || null;
    }
    if ((YOUTUBE_HOSTS as readonly string[]).includes(url.hostname)) {
      const v = url.searchParams.get('v');
      if (v) return v;
      const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)/);
      if (shortsMatch) return shortsMatch[1] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Format**

```bash
yarn prettier --write src/shared/youtube.ts
```

- [ ] **Step 3: Verify**

```bash
yarn lint && yarn typecheck
```

Expected: lint exits 0 (1 known `__dirname` warning); typecheck exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/shared/youtube.ts
git commit -m "feat(m3): add shared YouTube types, schemas, and URL validation"
```

---

### Task 2: Tests for shared YouTube helpers

**Files:**
- Create: `src/shared/youtube.test.ts`

Pure-function tests for the URL helpers — fast, no mocking needed.

- [ ] **Step 1: Write the tests**

Create `src/shared/youtube.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isYoutubeUrl, extractVideoId } from './youtube';

describe('isYoutubeUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', true],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ', true],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', true],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', true],
    ['https://youtu.be/dQw4w9WgXcQ', true],
    ['https://www.youtube.com/shorts/abc123', true],
    ['  https://www.youtube.com/watch?v=abc  ', true],
    ['https://vimeo.com/123', false],
    ['https://example.com/youtube.com/watch?v=abc', false],
    ['not a url', false],
    ['', false],
  ])('isYoutubeUrl(%s) === %s', (input, expected) => {
    expect(isYoutubeUrl(input)).toBe(expected);
  });
});

describe('extractVideoId', () => {
  it('reads ?v= from a standard watch URL', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('reads the path from a youtu.be short link', () => {
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('reads the path from a /shorts/<id> URL', () => {
    expect(extractVideoId('https://www.youtube.com/shorts/abc123')).toBe('abc123');
  });

  it('returns null for non-YouTube hosts', () => {
    expect(extractVideoId('https://vimeo.com/123')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(extractVideoId('not a url')).toBeNull();
  });

  it('returns null when no v param and not a short or shorts link', () => {
    expect(extractVideoId('https://www.youtube.com/feed/trending')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
yarn test src/shared/youtube.test.ts
```

Expected: all 17 tests pass (11 + 6).

- [ ] **Step 3: Format + commit**

```bash
yarn prettier --write src/shared/youtube.test.ts
git add src/shared/youtube.test.ts
git commit -m "test(m3): cover isYoutubeUrl and extractVideoId edge cases"
```

---

### Task 3: Install youtube-dl-exec

**Files:**
- Modify: `package.json` + `yarn.lock`

- [ ] **Step 1: Install**

```bash
yarn add youtube-dl-exec@^3.0.0
```

> youtube-dl-exec ships its own yt-dlp binary into `node_modules/youtube-dl-exec/bin/`. The postinstall hook downloads the platform binary; `enableScripts: true` in `.yarnrc.yml` (set up in M1) permits this.

- [ ] **Step 2: Verify the binary landed**

```bash
ls node_modules/youtube-dl-exec/bin/
```

Expected: at least one `yt-dlp*` file exists. On macOS it's typically `yt-dlp` (no extension).

- [ ] **Step 3: Sanity-check the binary**

```bash
node_modules/youtube-dl-exec/bin/yt-dlp --version
```

Expected: prints a version like `2024.10.07` or similar. If it fails with "permission denied", run `chmod +x node_modules/youtube-dl-exec/bin/yt-dlp` and retry.

- [ ] **Step 4: Verify project still builds**

```bash
yarn typecheck && yarn lint && yarn test
```

Expected: all green; existing 15 tests + the 17 new from Task 2 = 32 pass.

- [ ] **Step 5: Commit**

```bash
git add package.json yarn.lock
git commit -m "chore(m3): add youtube-dl-exec for yt-dlp integration"
```

---

### Task 4: YouTubeService — fetchMeta (TDD)

**Files:**
- Create: `src/main/services/YouTubeService.ts`
- Create: `src/main/services/YouTubeService.test.ts`

The service is constructed with an injected `youtubeDl`-like function so tests can mock it. We start with `fetchMeta()` only; download lands in Task 5.

- [ ] **Step 1: Write the failing tests**

Create `src/main/services/YouTubeService.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { YouTubeService } from './YouTubeService';

describe('YouTubeService.fetchMeta', () => {
  let youtubeDl: ReturnType<typeof vi.fn>;
  let service: YouTubeService;

  beforeEach(() => {
    youtubeDl = vi.fn();
    service = new YouTubeService({
      youtubeDl: youtubeDl as never,
      spawn: vi.fn() as never,
    });
  });

  it('calls yt-dlp with metadata-only flags and returns a parsed VideoMeta', async () => {
    youtubeDl.mockResolvedValue({
      id: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      channel: 'Rick Astley',
      duration: 213,
      thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });

    const meta = await service.fetchMeta('https://youtu.be/dQw4w9WgXcQ');

    expect(youtubeDl).toHaveBeenCalledWith(
      'https://youtu.be/dQw4w9WgXcQ',
      expect.objectContaining({
        dumpSingleJson: true,
        skipDownload: true,
        noWarnings: true,
      }),
    );
    expect(meta).toEqual({
      id: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      channel: 'Rick Astley',
      durationSec: 213,
      thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      webpageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
  });

  it('rejects non-YouTube URLs before calling yt-dlp', async () => {
    await expect(service.fetchMeta('https://vimeo.com/123')).rejects.toThrow(
      /not a recognized YouTube/i,
    );
    expect(youtubeDl).not.toHaveBeenCalled();
  });

  it('throws a descriptive error if yt-dlp returns malformed data', async () => {
    youtubeDl.mockResolvedValue({ id: 'x' }); // missing title, channel, etc.
    await expect(service.fetchMeta('https://youtu.be/x')).rejects.toThrow();
  });

  it('passes through yt-dlp execution errors', async () => {
    youtubeDl.mockRejectedValue(new Error('Video unavailable'));
    await expect(service.fetchMeta('https://youtu.be/x')).rejects.toThrow(
      /Video unavailable/,
    );
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
yarn test src/main/services/YouTubeService.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the service skeleton**

Create `src/main/services/YouTubeService.ts`:

```ts
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isYoutubeUrl, VideoMetaSchema, type VideoMeta } from '@shared/youtube';

/** Minimal surface of `youtube-dl-exec` we depend on for metadata calls. */
export type YoutubeDlLike = (
  url: string,
  flags: Record<string, unknown>,
) => Promise<unknown>;

/** Minimal surface of `node:child_process.spawn` we depend on for downloads. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) => ChildProcessWithoutNullStreams;

export interface YouTubeServiceDeps {
  youtubeDl: YoutubeDlLike;
  spawn: SpawnLike;
}

export class YouTubeService {
  constructor(private readonly deps: YouTubeServiceDeps) {}

  async fetchMeta(url: string): Promise<VideoMeta> {
    if (!isYoutubeUrl(url)) {
      throw new Error(`URL is not a recognized YouTube link: ${url}`);
    }
    const raw = await this.deps.youtubeDl(url, {
      dumpSingleJson: true,
      skipDownload: true,
      noWarnings: true,
    });
    return VideoMetaSchema.parse({
      id: (raw as { id?: unknown }).id,
      title: (raw as { title?: unknown }).title,
      channel: (raw as { channel?: unknown }).channel,
      durationSec: (raw as { duration?: unknown }).duration,
      thumbnailUrl: (raw as { thumbnail?: unknown }).thumbnail,
      webpageUrl: (raw as { webpage_url?: unknown }).webpage_url,
    });
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
yarn test src/main/services/YouTubeService.test.ts
```

Expected: 4/4 passing.

- [ ] **Step 5: Format + verify**

```bash
yarn prettier --write src/main/services/
yarn lint && yarn typecheck
```

Expected: lint clean; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/YouTubeService.ts src/main/services/YouTubeService.test.ts
git commit -m "feat(m3): add YouTubeService.fetchMeta with injected yt-dlp wrapper"
```

---

### Task 5: YouTubeService — download with progress + cancel

**Files:**
- Modify: `src/main/services/YouTubeService.ts`
- Modify: `src/main/services/YouTubeService.test.ts`

Add `download(url, outputPath)` returning a `DownloadHandle` with `onProgress`, `done`, and `cancel`. We spawn yt-dlp directly (not via the youtube-dl-exec wrapper) so we have a clean way to attach to stdout — yt-dlp emits progress lines we parse with a regex. The path to the bundled binary comes from `youtube-dl-exec`'s exported `binaryPath`.

- [ ] **Step 1: Add tests for download**

Append the following describe block to `src/main/services/YouTubeService.test.ts` (do NOT modify the existing fetchMeta tests):

```ts
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  killed = false;
  kill(signal?: string): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', signal === 'SIGTERM' ? null : 0));
    return true;
  }
}

describe('YouTubeService.download', () => {
  let spawn: ReturnType<typeof vi.fn>;
  let service: YouTubeService;
  let child: FakeChild;

  beforeEach(() => {
    child = new FakeChild();
    spawn = vi.fn(() => child);
    service = new YouTubeService({
      youtubeDl: vi.fn() as never,
      spawn: spawn as never,
    });
  });

  it('spawns yt-dlp with the configured output path and progress template', () => {
    service.download('https://youtu.be/abc', '/tmp/abc.mp4', { videoId: 'abc' });
    expect(spawn).toHaveBeenCalledTimes(1);
    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--output');
    expect(args).toContain('/tmp/abc.mp4');
    expect(args).toContain('--newline');
    expect(args.some((a) => a.startsWith('--progress-template'))).toBe(true);
  });

  it('emits parsed progress events as yt-dlp writes lines', async () => {
    const handle = service.download('https://youtu.be/abc', '/tmp/abc.mp4', {
      videoId: 'abc',
    });
    const events: number[] = [];
    handle.onProgress((p) => events.push(p.percent));

    child.stdout.push('progress: 12.3%|0:42|1.0MiB|10.0MiB\n');
    child.stdout.push('progress: 50.0%|0:20|5.0MiB|10.0MiB\n');
    child.stdout.push('progress: 100.0%|0:00|10.0MiB|10.0MiB\n');
    await new Promise((r) => setTimeout(r, 0));

    expect(events).toEqual([12.3, 50.0, 100.0]);
  });

  it('resolves done when yt-dlp exits with code 0', async () => {
    const handle = service.download('https://youtu.be/abc', '/tmp/abc.mp4', {
      videoId: 'abc',
    });
    child.emit('exit', 0);
    await expect(handle.done).resolves.toBeUndefined();
  });

  it('rejects done with a descriptive error on non-zero exit', async () => {
    const handle = service.download('https://youtu.be/abc', '/tmp/abc.mp4', {
      videoId: 'abc',
    });
    child.stderr.push('ERROR: Video unavailable\n');
    child.emit('exit', 1);
    await expect(handle.done).rejects.toThrow(/Video unavailable|exit code 1/);
  });

  it('cancel() sends SIGTERM and resolves done as canceled', async () => {
    const handle = service.download('https://youtu.be/abc', '/tmp/abc.mp4', {
      videoId: 'abc',
    });
    handle.cancel();
    await expect(handle.done).rejects.toThrow(/canceled/i);
    expect(child.killed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
yarn test src/main/services/YouTubeService.test.ts
```

Expected: 4 fetchMeta tests still pass; 5 download tests fail because `download` is undefined.

- [ ] **Step 3: Extend the implementation**

Replace the contents of `src/main/services/YouTubeService.ts` with:

```ts
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isYoutubeUrl, VideoMetaSchema, type VideoMeta } from '@shared/youtube';
import type { DownloadProgress } from '@shared/youtube';

export type YoutubeDlLike = (
  url: string,
  flags: Record<string, unknown>,
) => Promise<unknown>;

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) => ChildProcessWithoutNullStreams;

export interface YouTubeServiceDeps {
  youtubeDl: YoutubeDlLike;
  spawn: SpawnLike;
  /** Absolute path to the yt-dlp binary. Defaults to `'yt-dlp'` (PATH lookup). */
  binaryPath?: string;
}

export interface DownloadOptions {
  videoId: string;
}

export interface DownloadHandle {
  onProgress(callback: (p: DownloadProgress) => void): void;
  cancel(): void;
  done: Promise<void>;
}

const PROGRESS_TEMPLATE =
  'progress: %(progress._percent_str)s|%(progress._eta_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s';
const PROGRESS_LINE = /^progress:\s*([\d.]+)%\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*$/;

export class YouTubeService {
  constructor(private readonly deps: YouTubeServiceDeps) {}

  async fetchMeta(url: string): Promise<VideoMeta> {
    if (!isYoutubeUrl(url)) {
      throw new Error(`URL is not a recognized YouTube link: ${url}`);
    }
    const raw = await this.deps.youtubeDl(url, {
      dumpSingleJson: true,
      skipDownload: true,
      noWarnings: true,
    });
    return VideoMetaSchema.parse({
      id: (raw as { id?: unknown }).id,
      title: (raw as { title?: unknown }).title,
      channel: (raw as { channel?: unknown }).channel,
      durationSec: (raw as { duration?: unknown }).duration,
      thumbnailUrl: (raw as { thumbnail?: unknown }).thumbnail,
      webpageUrl: (raw as { webpage_url?: unknown }).webpage_url,
    });
  }

  download(url: string, outputPath: string, opts: DownloadOptions): DownloadHandle {
    if (!isYoutubeUrl(url)) {
      throw new Error(`URL is not a recognized YouTube link: ${url}`);
    }
    const args = [
      url,
      '--output',
      outputPath,
      '--format',
      'bv*+ba/b',
      '--no-playlist',
      '--newline',
      `--progress-template=${PROGRESS_TEMPLATE}`,
    ];
    const child = this.deps.spawn(this.deps.binaryPath ?? 'yt-dlp', args, {});

    const progressCallbacks: ((p: DownloadProgress) => void)[] = [];
    let stderrBuffer = '';
    let canceled = false;

    child.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        const m = PROGRESS_LINE.exec(line);
        if (!m) continue;
        const [, pctStr, etaStr, downStr, totStr] = m;
        const progress: DownloadProgress = {
          videoId: opts.videoId,
          percent: Number.parseFloat(pctStr ?? '0'),
          etaSec: parseEtaSeconds(etaStr ?? ''),
          downloadedBytes: parseByteSize(downStr ?? ''),
          totalBytes: parseByteSize(totStr ?? ''),
        };
        for (const cb of progressCallbacks) cb(progress);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    const done = new Promise<void>((resolve, reject) => {
      child.on('exit', (code: number | null) => {
        if (canceled) {
          reject(new Error('Download canceled'));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        const msg = stderrBuffer.trim() || `yt-dlp exited with code ${code}`;
        reject(new Error(msg));
      });
      child.on('error', (err: Error) => reject(err));
    });

    return {
      onProgress: (cb) => progressCallbacks.push(cb),
      cancel: () => {
        canceled = true;
        child.kill('SIGTERM');
      },
      done,
    };
  }
}

function parseEtaSeconds(eta: string): number | null {
  const trimmed = eta.trim();
  if (!trimmed || trimmed === 'NA' || trimmed === '--:--') return null;
  const parts = trimmed.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function parseByteSize(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed || trimmed === 'NA') return null;
  const m = /^([\d.]+)\s*([KMGT]?)i?B$/i.exec(trimmed);
  if (!m) return null;
  const n = Number.parseFloat(m[1] ?? '0');
  const unit = (m[2] ?? '').toUpperCase();
  const mult = unit === 'K' ? 1024 : unit === 'M' ? 1024 ** 2 : unit === 'G' ? 1024 ** 3 : unit === 'T' ? 1024 ** 4 : 1;
  return Math.round(n * mult);
}
```

- [ ] **Step 4: Run tests to confirm 9/9 passing**

```bash
yarn test src/main/services/YouTubeService.test.ts
```

Expected: 9/9 passing (4 fetchMeta + 5 download).

- [ ] **Step 5: Format + lint**

```bash
yarn prettier --write src/main/services/
yarn lint
```

Expected: lint exits 0 (1 known warning).

- [ ] **Step 6: Commit**

```bash
git add src/main/services/YouTubeService.ts src/main/services/YouTubeService.test.ts
git commit -m "feat(m3): add YouTubeService.download with progress streaming and cancel"
```

---

### Task 6: IPC contract extension

**Files:**
- Modify: `src/shared/ipc.ts`

Add the four new methods. `onDownloadProgress` is the one-way subscription pattern — it returns an unsubscribe function (cleanup-in-callback).

- [ ] **Step 1: Replace `src/shared/ipc.ts` entirely**

```ts
import type { Settings } from './settings';
import type { DownloadProgress, VideoMeta } from './youtube';

/**
 * Typed IPC bridge between renderer and main.
 * Channels and methods are added as features land.
 */
export interface AppApi {
  /** App version surfaced from main → renderer at boot. */
  getAppVersion(): Promise<string>;

  /** Settings persistence (electron-store backed). */
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  resetSettings(): Promise<Settings>;

  /** OpenRouter API key (safeStorage backed; never echoed back in plaintext). */
  hasApiKey(): Promise<boolean>;
  setApiKey(key: string): Promise<void>;
  clearApiKey(): Promise<void>;

  /** Native folder picker; returns selected absolute path or null on cancel. */
  pickFolder(opts: { title?: string; defaultPath?: string }): Promise<string | null>;

  /** Fetches title/duration/thumbnail/etc. for a YouTube URL via yt-dlp. */
  fetchVideoPreview(url: string): Promise<VideoMeta>;
  /** Starts a download. Resolves to the absolute output path on success. */
  downloadVideo(url: string): Promise<{ outputPath: string }>;
  /** Cancels the active download (no-op if none in flight). */
  cancelDownload(): Promise<void>;
  /** Subscribe to download progress events. Returns an unsubscribe function. */
  onDownloadProgress(callback: (p: DownloadProgress) => void): () => void;

  /** Reveal a file in the OS file manager (Finder / Explorer). */
  revealInFolder(absolutePath: string): Promise<void>;
}

declare global {
  interface Window {
    api: AppApi;
  }
}

export {};
```

- [ ] **Step 2: Format + verify typecheck**

```bash
yarn prettier --write src/shared/ipc.ts
yarn typecheck
```

> `yarn lint` will fail because `preload.ts` doesn't yet implement these new methods. Skip lint for this task.

Expected: typecheck exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc.ts
git commit -m "feat(m3): extend AppApi with video preview, download, cancel, and reveal"
```

---

### Task 7: Wire YouTube IPC handlers in main.ts

**Files:**
- Modify: `src/main/main.ts`

Instantiate `YouTubeService` at startup, register the 4 handlers, and emit `download:progress` events on the active window.

- [ ] **Step 1: Apply the edits to `src/main/main.ts`**

a. Update imports — add these lines (place near the other electron imports, prettier will reorder):

```ts
import { spawn } from 'node:child_process';
import youtubeDl from 'youtube-dl-exec';
import { YouTubeService, type DownloadHandle } from './services/YouTubeService';
```

Ensure `BrowserWindow` and `shell` are still imported from electron (they already are).

b. Update the import for `Settings` to also import `dirname` from `node:path` (only if not already imported); keep `join` as-is.

c. After the `let secureStorage: SecureStorage;` line, add:

```ts
let youtubeService: YouTubeService;
let activeDownload: DownloadHandle | null = null;
```

d. Inside `app.whenReady().then(() => { ... })`, after the `secureStorage = new SecureStorage(...)` line and before the existing `ipcMain.handle` block, add service init:

```ts
youtubeService = new YouTubeService({
  youtubeDl: youtubeDl as never,
  spawn: spawn as never,
});
```

e. Inside the same `whenReady` block, after the `ipcMain.handle('dialog:pickFolder', ...)` line, append the 4 new IPC handlers:

```ts
ipcMain.handle('youtube:fetchPreview', (_e, url: string) => youtubeService.fetchMeta(url));

ipcMain.handle('youtube:download', async (_e, url: string) => {
  if (activeDownload) {
    throw new Error('A download is already in progress');
  }
  const settings = settingsStore.get();
  const meta = await youtubeService.fetchMeta(url);
  const outputPath = join(settings.paths.downloads, `${meta.id}.mp4`);
  const handle = youtubeService.download(url, outputPath, { videoId: meta.id });
  activeDownload = handle;
  handle.onProgress((p) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('download:progress', p);
    }
  });
  try {
    await handle.done;
    return { outputPath };
  } finally {
    activeDownload = null;
  }
});

ipcMain.handle('youtube:cancel', () => {
  activeDownload?.cancel();
});

ipcMain.handle('shell:reveal', (_e, absolutePath: string) => {
  shell.showItemInFolder(absolutePath);
});
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/main/main.ts
yarn typecheck
```

> `yarn lint` will still fail until preload is updated (Task 8). Skip it for now.

Expected: typecheck exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(m3): wire YouTube IPC handlers and progress event emit in main"
```

---

### Task 8: Update preload bridge

**Files:**
- Modify: `src/main/preload.ts`

Expose the four new methods + the subscription pattern for progress events.

- [ ] **Step 1: Replace `src/main/preload.ts` entirely**

```ts
import type { AppApi } from '@shared/ipc';
import type { Settings } from '@shared/settings';
import type { DownloadProgress } from '@shared/youtube';
import { contextBridge, ipcRenderer } from 'electron';

const api: AppApi = {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:update', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  hasApiKey: () => ipcRenderer.invoke('secure:hasKey'),
  setApiKey: (key: string) => ipcRenderer.invoke('secure:setKey', key),
  clearApiKey: () => ipcRenderer.invoke('secure:clearKey'),

  pickFolder: (opts) => ipcRenderer.invoke('dialog:pickFolder', opts),

  fetchVideoPreview: (url: string) => ipcRenderer.invoke('youtube:fetchPreview', url),
  downloadVideo: (url: string) => ipcRenderer.invoke('youtube:download', url),
  cancelDownload: () => ipcRenderer.invoke('youtube:cancel'),
  onDownloadProgress: (callback: (p: DownloadProgress) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: DownloadProgress) => callback(data);
    ipcRenderer.on('download:progress', handler);
    return () => {
      ipcRenderer.off('download:progress', handler);
    };
  },

  revealInFolder: (absolutePath: string) => ipcRenderer.invoke('shell:reveal', absolutePath),
};

contextBridge.exposeInMainWorld('api', api);
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/main/preload.ts
yarn lint && yarn typecheck && yarn test
```

Expected: lint exits 0 (only `__dirname` warning); typecheck exits 0; all existing tests pass (32 + the new 9 service tests = 41 total at this point).

- [ ] **Step 3: Commit**

```bash
git add src/main/preload.ts
git commit -m "feat(m3): expose video preview, download, cancel, and progress on window.api"
```

---

### Task 9: useVideoPreview hook

**Files:**
- Create: `src/renderer/hooks/useVideoPreview.ts`

Idle → loading → loaded | error state machine, triggered by an explicit `fetch(url)` call (not on every keystroke).

- [ ] **Step 1: Create the file**

```ts
import { useCallback, useState } from 'react';
import type { VideoMeta } from '@shared/youtube';

export type VideoPreviewState =
  | { status: 'idle' }
  | { status: 'loading'; url: string }
  | { status: 'loaded'; url: string; meta: VideoMeta }
  | { status: 'error'; url: string; error: Error };

export type UseVideoPreview = {
  state: VideoPreviewState;
  fetch: (url: string) => Promise<void>;
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

  const reset = useCallback(() => {
    setState({ status: 'idle' });
  }, []);

  return { state, fetch, reset };
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/hooks/useVideoPreview.ts
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/hooks/useVideoPreview.ts
git commit -m "feat(m3): add useVideoPreview hook"
```

---

### Task 10: useDownload hook

**Files:**
- Create: `src/renderer/hooks/useDownload.ts`

Subscribes to `download:progress` for the lifetime of the component, exposes start/cancel.

- [ ] **Step 1: Create the file**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DownloadProgress, DownloadStatus } from '@shared/youtube';

export type DownloadState =
  | { status: 'idle' }
  | { status: 'starting'; url: string }
  | { status: 'downloading'; url: string; progress: DownloadProgress }
  | { status: 'done'; url: string; outputPath: string }
  | { status: 'canceled'; url: string }
  | { status: 'error'; url: string; error: Error };

export type UseDownload = {
  state: DownloadState;
  status: DownloadStatus;
  start: (url: string) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
};

export function useDownload(): UseDownload {
  const [state, setState] = useState<DownloadState>({ status: 'idle' });
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = window.api.onDownloadProgress((p) => {
      const url = urlRef.current;
      if (!url) return;
      setState({ status: 'downloading', url, progress: p });
    });
    return unsubscribe;
  }, []);

  const start = useCallback(async (url: string) => {
    urlRef.current = url;
    setState({ status: 'starting', url });
    try {
      const { outputPath } = await window.api.downloadVideo(url);
      setState({ status: 'done', url, outputPath });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      if (/canceled/i.test(message)) {
        setState({ status: 'canceled', url });
      } else {
        setState({ status: 'error', url, error: e instanceof Error ? e : new Error(message) });
      }
    }
  }, []);

  const cancel = useCallback(async () => {
    await window.api.cancelDownload();
  }, []);

  const reset = useCallback(() => {
    urlRef.current = null;
    setState({ status: 'idle' });
  }, []);

  return { state, status: state.status, start, cancel, reset };
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/hooks/useDownload.ts
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/hooks/useDownload.ts
git commit -m "feat(m3): add useDownload hook with progress subscription"
```

---

### Task 11: UrlInput component

**Files:**
- Create: `src/renderer/components/newjob/UrlInput.tsx`

Input field + 미리보기 button. Disables button when input isn't a YouTube URL.

- [ ] **Step 1: Create the file**

```tsx
import { useState } from 'react';
import { isYoutubeUrl } from '@shared/youtube';

export function UrlInput({
  initialValue,
  onSubmit,
  disabled,
}: {
  initialValue?: string;
  onSubmit: (url: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initialValue ?? '');
  const trimmed = value.trim();
  const valid = isYoutubeUrl(trimmed);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || disabled) return;
    onSubmit(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-sm">
      <input
        type="url"
        inputMode="url"
        spellCheck={false}
        autoComplete="off"
        placeholder="https://www.youtube.com/watch?v=..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        className="h-12 flex-1 rounded-full border border-hairline bg-canvas px-xl text-body-md text-ink focus:border-brand-blue-deep focus:outline-none disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={!valid || disabled}
        className="h-12 rounded-full bg-primary px-xl text-button-md font-semibold text-on-primary disabled:opacity-50"
      >
        미리보기
      </button>
    </form>
  );
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/components/newjob/UrlInput.tsx
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/newjob/UrlInput.tsx
git commit -m "feat(m3): add UrlInput component with YouTube URL validation"
```

---

### Task 12: PreviewCard component

**Files:**
- Create: `src/renderer/components/newjob/PreviewCard.tsx`

Renders thumbnail + title + channel + duration + 다운로드 button.

- [ ] **Step 1: Create the file**

```tsx
import type { VideoMeta } from '@shared/youtube';

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function PreviewCard({
  meta,
  onDownload,
  onClear,
  downloadDisabled,
}: {
  meta: VideoMeta;
  onDownload: () => void;
  onClear: () => void;
  downloadDisabled?: boolean;
}) {
  return (
    <article className="overflow-hidden rounded-xl border border-hairline bg-canvas shadow-1">
      <img
        src={meta.thumbnailUrl}
        alt=""
        className="aspect-video w-full object-cover"
        loading="lazy"
      />
      <div className="flex flex-col gap-md p-xxl">
        <header className="flex flex-col gap-xs">
          <h2 className="text-card-title font-semibold text-ink">{meta.title}</h2>
          <p className="text-body-sm text-slate">
            {meta.channel} · {formatDuration(meta.durationSec)}
          </p>
        </header>
        <div className="flex gap-sm">
          <button
            type="button"
            onClick={onDownload}
            disabled={downloadDisabled}
            className="h-12 rounded-full bg-primary px-xl text-button-md font-semibold text-on-primary disabled:opacity-50"
          >
            다운로드
          </button>
          <button
            type="button"
            onClick={onClear}
            className="h-12 rounded-full border border-ink bg-transparent px-xl text-button-md font-semibold text-ink"
          >
            URL 변경
          </button>
        </div>
      </div>
    </article>
  );
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/components/newjob/PreviewCard.tsx
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/newjob/PreviewCard.tsx
git commit -m "feat(m3): add PreviewCard with thumbnail, meta, and action buttons"
```

---

### Task 13: DownloadProgress component

**Files:**
- Create: `src/renderer/components/newjob/DownloadProgress.tsx`

Progress bar + ETA + cancel button. Shows different states for downloading / done / error / canceled.

- [ ] **Step 1: Create the file**

```tsx
import type { DownloadProgress as Progress } from '@shared/youtube';

function formatEta(sec: number | null): string {
  if (sec === null) return '--:--';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(b: number | null): string {
  if (b === null) return '--';
  if (b > 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b > 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

type Props =
  | { status: 'starting' }
  | { status: 'downloading'; progress: Progress; onCancel: () => void }
  | { status: 'done'; outputPath: string; onReveal: () => void; onReset: () => void }
  | { status: 'canceled'; onReset: () => void }
  | { status: 'error'; error: Error; onReset: () => void };

export function DownloadProgress(props: Props) {
  return (
    <section className="rounded-xl border border-hairline bg-canvas p-xxl shadow-1">
      {props.status === 'starting' ? (
        <p className="text-body-md text-slate">다운로드 준비 중...</p>
      ) : null}

      {props.status === 'downloading' ? (
        <div className="flex flex-col gap-md">
          <div className="flex items-baseline justify-between gap-md">
            <h3 className="text-card-title font-semibold text-ink">
              {props.progress.percent.toFixed(1)}%
            </h3>
            <p className="text-body-sm text-slate">
              {formatBytes(props.progress.downloadedBytes)} /{' '}
              {formatBytes(props.progress.totalBytes)} · ETA{' '}
              {formatEta(props.progress.etaSec)}
            </p>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${Math.min(100, props.progress.percent)}%` }}
            />
          </div>
          <button
            type="button"
            onClick={props.onCancel}
            className="h-10 self-start rounded-full border border-ink bg-transparent px-xl text-button-md font-semibold text-ink"
          >
            취소
          </button>
        </div>
      ) : null}

      {props.status === 'done' ? (
        <div className="flex flex-col gap-md">
          <h3 className="text-card-title font-semibold text-success-text">다운로드 완료</h3>
          <p className="break-all text-body-sm text-slate">{props.outputPath}</p>
          <div className="flex gap-sm">
            <button
              type="button"
              onClick={props.onReveal}
              className="h-10 rounded-full bg-primary px-xl text-button-md font-semibold text-on-primary"
            >
              파일 열기
            </button>
            <button
              type="button"
              onClick={props.onReset}
              className="h-10 rounded-full border border-ink bg-transparent px-xl text-button-md font-semibold text-ink"
            >
              새 작업
            </button>
          </div>
        </div>
      ) : null}

      {props.status === 'canceled' ? (
        <div className="flex flex-col gap-md">
          <h3 className="text-card-title font-semibold text-ink">취소됨</h3>
          <button
            type="button"
            onClick={props.onReset}
            className="h-10 self-start rounded-full bg-primary px-xl text-button-md font-semibold text-on-primary"
          >
            다시 시도
          </button>
        </div>
      ) : null}

      {props.status === 'error' ? (
        <div className="flex flex-col gap-md">
          <h3 className="text-card-title font-semibold text-brand-coral">실패</h3>
          <p className="break-all text-body-sm text-slate">{props.error.message}</p>
          <button
            type="button"
            onClick={props.onReset}
            className="h-10 self-start rounded-full bg-primary px-xl text-button-md font-semibold text-on-primary"
          >
            다시 시도
          </button>
        </div>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/components/newjob/DownloadProgress.tsx
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/newjob/DownloadProgress.tsx
git commit -m "feat(m3): add DownloadProgress with starting/downloading/done/canceled/error states"
```

---

### Task 14: Compose NewJob.tsx page

**Files:**
- Modify: `src/renderer/pages/NewJob.tsx`

Replace the placeholder with a real composition that orchestrates the two hooks and three components.

- [ ] **Step 1: Replace `src/renderer/pages/NewJob.tsx`**

```tsx
import { DownloadProgress } from '@renderer/components/newjob/DownloadProgress';
import { PreviewCard } from '@renderer/components/newjob/PreviewCard';
import { UrlInput } from '@renderer/components/newjob/UrlInput';
import { useDownload } from '@renderer/hooks/useDownload';
import { useVideoPreview } from '@renderer/hooks/useVideoPreview';

export function NewJobPage() {
  const preview = useVideoPreview();
  const download = useDownload();

  const downloadInFlight =
    download.status === 'starting' || download.status === 'downloading';

  return (
    <section className="flex flex-col gap-xl p-section">
      <header>
        <h1 className="text-heading-md font-semibold text-ink">새 작업</h1>
        <p className="mt-md text-body-md text-slate">
          YouTube URL을 입력하면 영상 정보를 미리 확인하고 다운로드할 수 있습니다.
        </p>
      </header>

      <UrlInput
        onSubmit={(url) => void preview.fetch(url)}
        disabled={preview.state.status === 'loading' || downloadInFlight}
      />

      {preview.state.status === 'loading' ? (
        <p className="text-body-md text-slate">영상 정보 가져오는 중...</p>
      ) : null}

      {preview.state.status === 'error' ? (
        <p className="text-body-md text-brand-coral">
          영상 정보를 불러오지 못했습니다: {preview.state.error.message}
        </p>
      ) : null}

      {preview.state.status === 'loaded' && download.state.status === 'idle' ? (
        <PreviewCard
          meta={preview.state.meta}
          onDownload={() => void download.start(preview.state.url)}
          onClear={() => preview.reset()}
        />
      ) : null}

      {download.state.status === 'starting' ? (
        <DownloadProgress status="starting" />
      ) : null}

      {download.state.status === 'downloading' ? (
        <DownloadProgress
          status="downloading"
          progress={download.state.progress}
          onCancel={() => void download.cancel()}
        />
      ) : null}

      {download.state.status === 'done' ? (
        <DownloadProgress
          status="done"
          outputPath={download.state.outputPath}
          onReveal={() => void window.api.revealInFolder(download.state.outputPath)}
          onReset={() => {
            download.reset();
            preview.reset();
          }}
        />
      ) : null}

      {download.state.status === 'canceled' ? (
        <DownloadProgress
          status="canceled"
          onReset={() => {
            download.reset();
            preview.reset();
          }}
        />
      ) : null}

      {download.state.status === 'error' ? (
        <DownloadProgress
          status="error"
          error={download.state.error}
          onReset={() => {
            download.reset();
            preview.reset();
          }}
        />
      ) : null}
    </section>
  );
}
```

- [ ] **Step 2: Update test stubs**

The existing `tests/renderer/App.test.tsx` and `tests/renderer/Settings.test.tsx` install a `window.api` stub. Now that `NewJob` calls `useVideoPreview` and `useDownload`, the App-level navigation tests need stubs for `fetchVideoPreview`, `downloadVideo`, `cancelDownload`, `onDownloadProgress`, and `revealInFolder` too.

Open `tests/renderer/App.test.tsx`. Find the `beforeAll` that installs the api mock. Add the following keys to the api object (alphabetize per existing style):

```ts
fetchVideoPreview: vi.fn(async () => {
  throw new Error('not used in this suite');
}),
downloadVideo: vi.fn(async () => ({ outputPath: '/tmp/x.mp4' })),
cancelDownload: vi.fn(async () => undefined),
onDownloadProgress: vi.fn(() => () => undefined),
revealInFolder: vi.fn(async () => undefined),
```

Then do the same for `tests/renderer/Settings.test.tsx`'s `installApiMock` helper — append the same five entries to the `api` object literal.

- [ ] **Step 3: Format + verify**

```bash
yarn prettier --write src/renderer/pages/NewJob.tsx tests/renderer/App.test.tsx tests/renderer/Settings.test.tsx
yarn lint && yarn typecheck && yarn test
```

Expected: lint exits 0; typecheck exits 0; all 41 tests pass (15 from M2 + 17 + 9 new from M3 Tasks 2 + 4-5).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/pages/NewJob.tsx tests/renderer/App.test.tsx tests/renderer/Settings.test.tsx
git commit -m "feat(m3): replace NewJob placeholder with real preview/download flow"
```

---

### Task 15: Smoke test for NewJob page

**Files:**
- Create: `tests/renderer/NewJob.test.tsx`

Three behaviors: URL input enables button after typing valid URL; preview success shows the card; clicking 다운로드 calls `downloadVideo`.

- [ ] **Step 1: Write the test**

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewJobPage } from '@renderer/pages/NewJob';
import type { VideoMeta } from '@shared/youtube';

const baseMeta: VideoMeta = {
  id: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  channel: 'Rick Astley',
  durationSec: 213,
  thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
  webpageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
};

function installApiMock(overrides?: Partial<Window['api']>) {
  const calls = {
    fetchVideoPreview: vi.fn(async () => baseMeta),
    downloadVideo: vi.fn(async () => ({ outputPath: '/tmp/dQw4w9WgXcQ.mp4' })),
    cancelDownload: vi.fn(async () => undefined),
    onDownloadProgress: vi.fn(() => () => undefined),
    revealInFolder: vi.fn(async () => undefined),
  };
  const api: Window['api'] = {
    getAppVersion: vi.fn(async () => '0.0.1'),
    getSettings: vi.fn(async () => ({}) as never),
    updateSettings: vi.fn(async () => ({}) as never),
    resetSettings: vi.fn(async () => ({}) as never),
    hasApiKey: vi.fn(async () => false),
    setApiKey: vi.fn(async () => undefined),
    clearApiKey: vi.fn(async () => undefined),
    pickFolder: vi.fn(async () => null),
    fetchVideoPreview: calls.fetchVideoPreview,
    downloadVideo: calls.downloadVideo,
    cancelDownload: calls.cancelDownload,
    onDownloadProgress: calls.onDownloadProgress,
    revealInFolder: calls.revealInFolder,
    ...overrides,
  };
  Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true });
  return calls;
}

describe('NewJobPage', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('keeps the 미리보기 button disabled until a valid YouTube URL is typed', async () => {
    const user = userEvent.setup();
    render(<NewJobPage />);
    const button = screen.getByRole('button', { name: '미리보기' });
    expect(button).toBeDisabled();
    await user.type(
      screen.getByRole('textbox'),
      'https://youtu.be/dQw4w9WgXcQ',
    );
    expect(button).toBeEnabled();
  });

  it('shows the preview card after a successful fetch', async () => {
    const user = userEvent.setup();
    render(<NewJobPage />);
    await user.type(
      screen.getByRole('textbox'),
      'https://youtu.be/dQw4w9WgXcQ',
    );
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Never Gonna Give You Up' })).toBeInTheDocument(),
    );
    expect(screen.getByText(/Rick Astley/)).toBeInTheDocument();
    expect(screen.getByText(/3:33/)).toBeInTheDocument();
  });

  it('clicking 다운로드 calls window.api.downloadVideo with the previewed URL', async () => {
    const calls = installApiMock();
    const user = userEvent.setup();
    render(<NewJobPage />);
    await user.type(
      screen.getByRole('textbox'),
      'https://youtu.be/dQw4w9WgXcQ',
    );
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await waitFor(() => screen.getByRole('button', { name: '다운로드' }));
    await user.click(screen.getByRole('button', { name: '다운로드' }));
    await waitFor(() =>
      expect(calls.downloadVideo).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ'),
    );
  });
});
```

- [ ] **Step 2: Run the new test alone, then the full suite**

```bash
yarn test tests/renderer/NewJob.test.tsx
yarn test
```

Expected first run: 3/3 passing in NewJob.test. Expected full suite: 44 tests passing (15 M1+M2 + 17 + 9 + 3 = 44).

- [ ] **Step 3: Format + commit**

```bash
yarn prettier --write tests/renderer/NewJob.test.tsx
git add tests/renderer/NewJob.test.tsx
git commit -m "test(m3): smoke test for NewJob preview and download click"
```

---

### Task 16: Final verification + README + tag

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Run all DoD checks**

```bash
yarn typecheck && yarn lint && yarn test && yarn build
```

Expected: all four exit 0. The 44-test suite passes. `out/` rebuilds cleanly with `out/main/main.js`, `out/preload/preload.mjs`, `out/renderer/index.html`.

- [ ] **Step 2: Update README status**

Edit the `## Status` section to:

```markdown
## Status

- ✅ M1: Project Skeleton
- ✅ M2: Settings page
- ✅ M3: YouTube preview + download — paste a URL, see meta card, download with live progress and cancel.
- ⏳ M4: Python sidecar + STT (next)
```

- [ ] **Step 3: Format + commit README**

```bash
yarn prettier --write README.md
git add README.md
git commit -m "docs(m3): mark milestone 3 complete in README"
```

- [ ] **Step 4: Tag and push**

```bash
git tag -a m3-complete -m "M3: YouTube preview + download complete

- youtube-dl-exec integration with bundled yt-dlp binary
- shared URL validation (youtube.com / youtu.be / m.youtube.com / music.youtube.com / shorts)
- YouTubeService: fetchMeta + download with progress/cancel
- 4 new IPC methods + one-way download:progress event channel
- NewJob page: idle → preview → downloading → done/canceled/error
- 'Reveal in folder' integration via shell.showItemInFolder
- 44/44 tests passing
"
git push origin master
git push origin m3-complete
```

---

## Definition of Done (M3)

All of these must be true before declaring M3 finished:

1. `yarn typecheck`, `yarn lint`, `yarn test`, `yarn build` all exit 0.
2. `yarn test` reports 44 passing (15 M2 + 17 URL helpers + 9 YouTubeService + 3 NewJob smoke).
3. Pasting a real YouTube URL in `yarn dev` shows the preview card with a working thumbnail and correct duration.
4. Clicking 다운로드 produces a `<videoId>.mp4` file at `settings.paths.downloads`.
5. The progress bar updates as the file downloads.
6. 취소 actually halts yt-dlp (process exits within ~1s) and the UI returns to a "취소됨" state.
7. 파일 열기 reveals the file in Finder/Explorer.
8. `master` pushed to origin with tag `m3-complete`.

## What's NOT in M3 (intentionally deferred)

- The "분석 시작" button that triggers the STT/LLM/render pipeline — that's M6.
- Resumable / multi-segment downloads — yt-dlp supports `--continue` natively but we don't expose UI for it.
- Format / quality picker (4K vs 1080p vs 720p) — for now `bv*+ba/b` picks the best video+audio combination.
- Concurrent downloads — if a download is in flight, attempts to start another throw "A download is already in progress". Queue UI is M9 (history).
- Caching the preview metadata — every preview re-hits yt-dlp. Refetch is fast and avoids stale data.
- Pre-flight checks (geo-block, age restriction) — yt-dlp surfaces these errors in stderr, which our `error.message` propagation already shows. Per-error UI improvements come in M9+.

## Notes for the implementing agent

- **Do not bypass the URL validation**. Both `useVideoPreview.fetch` (renderer) and `YouTubeService.fetchMeta` / `download` (main) call `isYoutubeUrl`. This is intentional defense in depth — the renderer guards UX and the main process guards security.
- **Do not change the spawn signature** of `youtube-dl-exec`. The package's exported binary path is stable; rely on it.
- **Do not add custom error handling for HTTP / network failures** — yt-dlp's stderr is already user-readable Korean-or-English depending on locale, and we propagate it.
- **The progress template in YouTubeService is load-bearing**. If you change the format, also change `PROGRESS_LINE` regex and the test fixtures.
- The `__dirname` lint warning in `src/main/main.ts` carries through M3. Don't suppress it without asking.
- If `yarn add youtube-dl-exec` warns about prebuilt binary download issues (e.g., behind a corporate proxy), report rather than retry endlessly — there may be a network policy issue.
