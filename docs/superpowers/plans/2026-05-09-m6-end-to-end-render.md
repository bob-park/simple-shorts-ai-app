# M6: First End-to-End Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the M5 `<videoStem>.highlights.json` and produce one 1080×1920 H.264/AAC MP4 per highlight by invoking system ffmpeg with `-ss / -to` cuts and a center-crop 9:16 filter chain. The NewJob page renders a `RenderCard` chain after `highlights.done`; clicking the button writes per-highlight files into `${settings.paths.outputs}/<sourceStem>/short_<index>.mp4` while streaming per-clip progress to the renderer. This is the first milestone that produces "a working ugly product" per the spec — no smart face tracking (M7), no burned-in subtitles (M8).

**Architecture:** A small `FfmpegRunner` (Node) spawns `ffmpeg` once per call with the supplied args, parses `-progress pipe:2` key-value lines for `out_time_us` / `frame` so it can emit a 0..1 fraction relative to the clip duration, and resolves on exit code 0 / rejects on non-zero or `cancel()`. A higher-level `RenderService` builds the per-clip arg array, runs them sequentially (one ffmpeg child at a time so cancel is unambiguous), and accumulates `RenderClipResult` entries. `cancel()` stops the current clip and drops the queue (no further clips start). The IPC handler in `main.ts` reads the sibling highlights.json + transcript.json (transcript is currently unused but resolves the audio duration question for clips), writes outputs to `${settings.paths.outputs}/<sourceStem>/`, and returns `{ outputDir, results }`. The renderer adds one `RenderCard` (5 states: missing-prereq / idle / rendering / done / canceled / error) and a `useRender` hook that subscribes to per-clip progress.

**Tech Stack:** System `ffmpeg` (PATH lookup; bundling deferred to M10 same as M4's `uv` and the eventual Python sidecar). No new npm deps. Node `child_process.spawn` reuses the existing pattern from `YouTubeService`. Center-crop filter: `crop=ih*9/16:ih,scale=1080:1920` (input wider than 9:16 — typical for YouTube). H264 video (`libx264 -preset fast -crf 23`) + AAC audio (`-c:a aac -b:a 128k`). Cuts use accurate `-ss` AFTER `-i` so `-c copy` is NOT used (we re-encode for guaranteed cut accuracy + filter chain compatibility).

---

## File Structure

```
src/
├── shared/
│   ├── render.ts                          # NEW: RenderClipResult, RenderProgress, RenderStatus types
│   └── ipc.ts                             # MODIFY: add renderShorts / cancelRender / onRenderProgress
├── main/
│   ├── main.ts                            # MODIFY: instantiate runner+service, register IPC, return result
│   ├── preload.ts                         # MODIFY: bridge new methods + progress subscription
│   ├── infra/
│   │   ├── FfmpegRunner.ts                # NEW: spawn ffmpeg, parse progress, cancel
│   │   └── FfmpegRunner.test.ts           # NEW: vitest with FakeChild
│   └── services/
│       ├── RenderService.ts               # NEW: per-highlight orchestration, sequential queue
│       └── RenderService.test.ts          # NEW: vitest with mocked FfmpegRunner
└── renderer/
    ├── hooks/
    │   └── useRender.ts                   # NEW: state machine + progress subscription
    ├── components/newjob/
    │   └── RenderCard.tsx                 # NEW: 5 visual states
    └── pages/NewJob.tsx                   # MODIFY: render RenderCard chain after highlights.done
tests/renderer/
├── App.test.tsx                           # MODIFY: extend api mock with render methods
├── Settings.test.tsx                      # MODIFY: same
└── NewJob.test.tsx                        # MODIFY: same + smoke test for 숏츠 만들기
```

**Decomposition rationale:**

- `FfmpegRunner` is a generic single-process wrapper — exact same pattern as `PythonSidecar` is for `python -m shorts_sidecar`. It owns the `spawn` call + stdout/stderr buffering + cancel signal forwarding. No knowledge of clips or filters.
- `RenderService` decides what args to pass for a given highlight (input path, start/end secs, output path) and runs the queue. Cancel = abort on the active clip + don't start the next.
- The renderer adds one component (`RenderCard`) following the `TranscribeCard` / `HighlightCard` shape. The 5th state (`missing-prereq`) is unique here because rendering needs both the source video AND the highlights.json to exist on disk; if either is missing, `RenderCard` shows guidance instead of letting the user click into a guaranteed failure.
- `render.ts` is separate from `highlight.ts` because per-clip progress is per-process state, not part of the persisted artifact.

---

## Tasks

### Task 1: Verify ffmpeg is on PATH (sanity check, no commit)

**Files:** none

- [ ] **Step 1: Confirm ffmpeg is callable**

```bash
which ffmpeg && ffmpeg -version 2>&1 | head -1
```

Expected: prints something like `ffmpeg version N.N` and exits 0. If ffmpeg is missing, install it (`brew install ffmpeg` on macOS, `winget install Gyan.FFmpeg` on Windows) before continuing.

This is a manual prerequisite check — no commit. The plan deliberately does NOT bundle ffmpeg-static; bundling is M10's job.

---

### Task 2: Shared Render types

**Files:**

- Create: `src/shared/render.ts`

- [ ] **Step 1: Create `src/shared/render.ts` with EXACTLY this content**

```ts
import { z } from 'zod';

/**
 * One clip's final on-disk result. The renderer uses this to display per-clip
 * status; the array is returned in the same order as the input highlights.
 */
export const RenderClipResultSchema = z.object({
  /** 1-based index into the input highlights array. */
  index: z.number().int().positive(),
  /** Highlight title (echoed for convenience). */
  title: z.string().min(1),
  /** Original highlight start, seconds. */
  startSec: z.number().nonnegative(),
  /** Original highlight end, seconds. */
  endSec: z.number().nonnegative(),
  /** Discriminates success vs failure for this specific clip. */
  status: z.enum(['done', 'failed', 'canceled']),
  /** Absolute path of the produced .mp4 (only when status==='done'). */
  outputPath: z.string().optional(),
  /** Human-readable error (only when status==='failed' or 'canceled'). */
  error: z.string().optional(),
});
export type RenderClipResult = z.infer<typeof RenderClipResultSchema>;

export const RenderResultSchema = z.object({
  /** Absolute path of the per-job output directory. */
  outputDir: z.string().min(1),
  results: z.array(RenderClipResultSchema),
});
export type RenderResult = z.infer<typeof RenderResultSchema>;

/** Per-clip progress the IPC layer streams to the renderer. */
export const RenderProgressSchema = z.object({
  /** 1-based clip index. */
  clipIndex: z.number().int().positive(),
  /** Total number of clips in the job. */
  clipTotal: z.number().int().positive(),
  /** 0..1 fraction of the current clip processed (parsed from ffmpeg). */
  fraction: z.number().min(0).max(1),
});
export type RenderProgress = z.infer<typeof RenderProgressSchema>;

export type RenderStatus = 'missing-prereq' | 'idle' | 'rendering' | 'done' | 'canceled' | 'error';
```

- [ ] **Step 2: Format + verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/shared/render.ts
yarn lint && yarn typecheck
```

Expected: lint 0 errors (1 known `__dirname` warning OK), typecheck 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/render.ts
git commit -m "feat(m6): add shared Render result + progress zod schemas"
```

---

### Task 3: IPC contract extension

**Files:**

- Modify: `src/shared/ipc.ts`

- [ ] **Step 1: Add the new types and methods**

Open `src/shared/ipc.ts` and:

a) Add to the imports block (alphabetical placement — after `./highlight`, before `./settings`):

```ts
import type { RenderProgress, RenderResult } from './render';
```

b) After the existing `onExtractProgress` declaration in `AppApi`, BEFORE the `revealInFolder` line, insert:

```ts
  /**
   * Render every highlight in the sibling `<audioPath>.highlights.json` into
   * `<settings.paths.outputs>/<sourceStem>/short_<i>.mp4`. Sequential — one
   * ffmpeg child at a time. Returns the per-clip result list (some clips may
   * have status 'failed' even if the overall call resolves).
   *
   * Throws `Error('No highlights found at <path>')` if the highlights.json
   * does not exist. Throws `Error('ffmpeg is not on PATH')` if the ffmpeg
   * binary cannot be spawned (caught at first attempt).
   */
  renderShorts(audioPath: string): Promise<RenderResult>;
  /** Cancel the active render job (kills current ffmpeg + drops the queue). */
  cancelRender(): Promise<void>;
  /** Subscribe to per-clip progress notifications. Returns unsubscribe. */
  onRenderProgress(callback: (p: RenderProgress) => void): () => void;
```

- [ ] **Step 2: Format + typecheck (lint will fail until preload + stubs are updated)**

```bash
yarn prettier --write src/shared/ipc.ts
yarn typecheck 2>&1 | tail -20
```

Expected: typecheck FAILS only at `src/main/preload.ts` and `tests/renderer/*.test.tsx`. Errors elsewhere are real bugs — fix before committing.

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc.ts
git commit -m "feat(m6): extend AppApi with renderShorts/cancelRender/onRenderProgress"
```

---

### Task 4: FfmpegRunner infra (TDD)

**Files:**

- Create: `src/main/infra/FfmpegRunner.ts`
- Create: `src/main/infra/FfmpegRunner.test.ts`

`FfmpegRunner` is a generic single-process spawn wrapper. It runs one ffmpeg invocation with the args you give it, parses `-progress pipe:2` lines from stderr to compute a 0..1 fraction of `clipDurationSec`, and resolves on exit 0 / rejects on non-zero or cancel. No filter / arg knowledge — that belongs in RenderService.

- [ ] **Step 1: Write the failing tests**

Create `src/main/infra/FfmpegRunner.test.ts` with EXACTLY this content:

```ts
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FfmpegRunner } from './FfmpegRunner';

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

describe('FfmpegRunner', () => {
  let spawn: ReturnType<typeof vi.fn>;
  let runner: FfmpegRunner;
  let child: FakeChild;

  beforeEach(() => {
    child = new FakeChild();
    spawn = vi.fn(() => child);
    runner = new FfmpegRunner({ spawn: spawn as never, command: 'ffmpeg' });
  });

  it('spawns the configured command with the supplied args', () => {
    runner.run({
      args: ['-i', '/tmp/in.mp4', '-c:v', 'libx264', '/tmp/out.mp4'],
      durationSec: 10,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawn.mock.calls[0]!;
    expect(cmd).toBe('ffmpeg');
    expect(args).toEqual(['-i', '/tmp/in.mp4', '-c:v', 'libx264', '/tmp/out.mp4']);
  });

  it('parses out_time_us from -progress lines and emits a 0..1 fraction', async () => {
    const handle = runner.run({ args: ['-i', '/tmp/in.mp4', '/tmp/out.mp4'], durationSec: 10 });
    const events: number[] = [];
    handle.onProgress((f) => events.push(f));

    child.stderr.push('out_time_us=2500000\n');
    child.stderr.push('progress=continue\n');
    child.stderr.push('out_time_us=10000000\n');
    child.stderr.push('progress=end\n');
    await new Promise((r) => setTimeout(r, 0));

    expect(events).toEqual([0.25, 1.0]);
  });

  it('clamps fraction at 1 when ffmpeg over-reports out_time', async () => {
    const handle = runner.run({ args: [], durationSec: 4 });
    const events: number[] = [];
    handle.onProgress((f) => events.push(f));
    child.stderr.push('out_time_us=5000000\n');
    child.stderr.push('progress=continue\n');
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([1.0]);
  });

  it('done resolves on exit 0', async () => {
    const handle = runner.run({ args: [], durationSec: 1 });
    child.emit('exit', 0);
    await expect(handle.done).resolves.toBeUndefined();
  });

  it('done rejects on non-zero exit with stderr tail in the message', async () => {
    const handle = runner.run({ args: [], durationSec: 1 });
    child.stderr.push('Error: Invalid argument\n');
    child.emit('exit', 1);
    await expect(handle.done).rejects.toThrow(/Invalid argument|exit code 1/i);
  });

  it('cancel() sends SIGTERM and rejects done as canceled', async () => {
    const handle = runner.run({ args: [], durationSec: 1 });
    handle.cancel();
    await expect(handle.done).rejects.toThrow(/canceled/i);
    expect(child.killed).toBe(true);
  });

  it('rejects with a clear error when the spawn itself fails (ENOENT)', async () => {
    const handle = runner.run({ args: [], durationSec: 1 });
    child.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }));
    await expect(handle.done).rejects.toThrow(/ffmpeg is not on PATH|ENOENT/);
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
yarn test src/main/infra/FfmpegRunner.test.ts
```

Expected: cannot find FfmpegRunner module.

- [ ] **Step 3: Implement `src/main/infra/FfmpegRunner.ts` with EXACTLY this content**

```ts
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) => ChildProcessWithoutNullStreams;

export interface FfmpegRunnerOptions {
  spawn: SpawnLike;
  /** Defaults to `'ffmpeg'` (PATH lookup). */
  command?: string;
}

export interface RunOptions {
  args: readonly string[];
  /**
   * Expected duration of the clip in seconds — used to convert ffmpeg's
   * `out_time_us` into a 0..1 fraction. Pass the highlight's `end_sec - start_sec`.
   */
  durationSec: number;
}

export interface RunHandle {
  onProgress(callback: (fraction: number) => void): void;
  cancel(): void;
  done: Promise<void>;
}

const OUT_TIME_LINE = /^out_time_us=(\d+)$/;

export class FfmpegRunner {
  private readonly cmd: string;

  constructor(private readonly opts: FfmpegRunnerOptions) {
    this.cmd = opts.command ?? 'ffmpeg';
  }

  run(opts: RunOptions): RunHandle {
    const child = this.opts.spawn(this.cmd, opts.args, {});

    const progressCallbacks: ((f: number) => void)[] = [];
    let stderrTail = '';
    let canceled = false;
    let stderrBuffer = '';

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      // Keep a rolling tail for error messages (last ~2KB is plenty).
      stderrTail = (stderrTail + text).slice(-2048);
      stderrBuffer += text;
      let idx: number;
      while ((idx = stderrBuffer.indexOf('\n')) >= 0) {
        const line = stderrBuffer.slice(0, idx).trim();
        stderrBuffer = stderrBuffer.slice(idx + 1);
        const m = OUT_TIME_LINE.exec(line);
        if (!m) continue;
        const us = Number.parseInt(m[1] ?? '0', 10);
        const fraction = opts.durationSec > 0 ? Math.min(1, us / 1_000_000 / opts.durationSec) : 0;
        for (const cb of progressCallbacks) cb(fraction);
      }
    });

    const done = new Promise<void>((resolve, reject) => {
      child.on('exit', (code: number | null) => {
        // Defer one tick so any buffered stderr 'data' events can fire before
        // we read state (Node Readables emit via process.nextTick).
        setImmediate(() => {
          if (canceled) {
            reject(new Error('Render canceled'));
            return;
          }
          if (code !== 0) {
            const tail = stderrTail.trim().split('\n').slice(-3).join(' | ');
            reject(new Error(tail || `ffmpeg exited with code ${code}`));
            return;
          }
          resolve();
        });
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          reject(new Error('ffmpeg is not on PATH (install via `brew install ffmpeg` on macOS)'));
        } else {
          reject(err);
        }
      });
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
```

- [ ] **Step 4: Run — should pass 7/7**

```bash
yarn test src/main/infra/FfmpegRunner.test.ts
```

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/infra/FfmpegRunner.ts src/main/infra/FfmpegRunner.test.ts
git add src/main/infra/FfmpegRunner.ts src/main/infra/FfmpegRunner.test.ts
git commit -m "feat(m6): add FfmpegRunner with progress parsing and cancel"
```

---

### Task 5: RenderService orchestrator (TDD)

**Files:**

- Create: `src/main/services/RenderService.ts`
- Create: `src/main/services/RenderService.test.ts`

`RenderService` walks the highlights array, builds the per-clip ffmpeg arg array, calls `FfmpegRunner.run()`, accumulates results, and bubbles per-clip progress to subscribers. Cancel = abort current clip + drop the rest of the queue (no further clips start, queue tail entries get status `canceled`).

- [ ] **Step 1: Write the failing tests**

Create `src/main/services/RenderService.test.ts` with EXACTLY this content:

```ts
import type { Highlight } from '@shared/highlight';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RenderService } from './RenderService';

function fakeHighlight(i: number, start: number, end: number): Highlight {
  return { start_sec: start, end_sec: end, title: `H${i}`, hook: `hook${i}` };
}

function fakeRunHandle() {
  let progressCb: (f: number) => void = () => undefined;
  let resolve: () => void = () => undefined;
  let reject: (err: Error) => void = () => undefined;
  const done = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const handle = {
    onProgress: (cb: (f: number) => void) => {
      progressCb = cb;
    },
    cancel: vi.fn(),
    done,
    // Test helpers
    _emit: (f: number) => progressCb(f),
    _resolve: () => resolve(),
    _reject: (msg: string) => reject(new Error(msg)),
  };
  return handle;
}

describe('RenderService', () => {
  let run: ReturnType<typeof vi.fn>;
  let runner: { run: typeof run };
  let service: RenderService;

  beforeEach(() => {
    run = vi.fn();
    runner = { run };
    service = new RenderService(runner as never);
  });

  it('renders one ffmpeg child per highlight, in order', async () => {
    const h1 = fakeRunHandle();
    const h2 = fakeRunHandle();
    run.mockReturnValueOnce(h1).mockReturnValueOnce(h2);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 30), fakeHighlight(2, 60, 90)],
    });

    // First clip starts immediately
    expect(run).toHaveBeenCalledTimes(1);
    h1._resolve();
    await new Promise((r) => setTimeout(r, 0));
    // Second starts after first resolves
    expect(run).toHaveBeenCalledTimes(2);
    h2._resolve();

    const result = await promise;
    expect(result.outputDir).toBe('/tmp/out');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.status).toBe('done');
    expect(result.results[1]!.status).toBe('done');
    expect(result.results[0]!.outputPath).toBe('/tmp/out/short_1.mp4');
    expect(result.results[1]!.outputPath).toBe('/tmp/out/short_2.mp4');
  });

  it('builds ffmpeg args with -ss, -to, the 9:16 crop+scale filter, libx264, and aac', async () => {
    const h = fakeRunHandle();
    run.mockReturnValue(h);
    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 5, 35)],
    });
    h._resolve();
    await promise;

    const opts = run.mock.calls[0]![0];
    expect(opts.durationSec).toBe(30);
    const args: string[] = opts.args;
    expect(args).toContain('-ss');
    expect(args[args.indexOf('-ss') + 1]).toBe('5');
    expect(args).toContain('-to');
    expect(args[args.indexOf('-to') + 1]).toBe('35');
    expect(args).toContain('-i');
    expect(args[args.indexOf('-i') + 1]).toBe('/tmp/in.mp4');
    expect(args).toContain('-vf');
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=ih*9/16:ih,scale=1080:1920');
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args).toContain('-progress');
    expect(args[args.indexOf('-progress') + 1]).toBe('pipe:2');
    expect(args[args.length - 1]).toBe('/tmp/out/short_1.mp4');
  });

  it('emits per-clip progress with clipIndex, clipTotal, and fraction', async () => {
    const h1 = fakeRunHandle();
    const h2 = fakeRunHandle();
    run.mockReturnValueOnce(h1).mockReturnValueOnce(h2);

    const events: { clipIndex: number; clipTotal: number; fraction: number }[] = [];
    service.onProgress((p) => events.push(p));

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 10), fakeHighlight(2, 20, 30)],
    });

    h1._emit(0.5);
    h1._emit(1.0);
    h1._resolve();
    await new Promise((r) => setTimeout(r, 0));
    h2._emit(0.25);
    h2._resolve();
    await promise;

    expect(events).toEqual([
      { clipIndex: 1, clipTotal: 2, fraction: 0.5 },
      { clipIndex: 1, clipTotal: 2, fraction: 1.0 },
      { clipIndex: 2, clipTotal: 2, fraction: 0.25 },
    ]);
  });

  it('records a failed clip and continues with the next', async () => {
    const h1 = fakeRunHandle();
    const h2 = fakeRunHandle();
    run.mockReturnValueOnce(h1).mockReturnValueOnce(h2);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 10), fakeHighlight(2, 20, 30)],
    });
    h1._reject('Codec missing');
    await new Promise((r) => setTimeout(r, 0));
    h2._resolve();
    const result = await promise;

    expect(result.results[0]!.status).toBe('failed');
    expect(result.results[0]!.error).toMatch(/Codec missing/);
    expect(result.results[1]!.status).toBe('done');
  });

  it('cancel() aborts the active clip and marks the remaining as canceled', async () => {
    const h1 = fakeRunHandle();
    const h2 = fakeRunHandle();
    run.mockReturnValueOnce(h1).mockReturnValueOnce(h2);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 10), fakeHighlight(2, 20, 30)],
    });
    // Wait for the first run to start
    await new Promise((r) => setTimeout(r, 0));
    service.cancel();
    h1._reject('Render canceled');
    const result = await promise;

    expect(h1.cancel).toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1); // h2 never started
    expect(result.results[0]!.status).toBe('canceled');
    expect(result.results[1]!.status).toBe('canceled');
  });

  it('returns immediately with empty results when given an empty highlights list', async () => {
    const result = await service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [],
    });
    expect(run).not.toHaveBeenCalled();
    expect(result.results).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
yarn test src/main/services/RenderService.test.ts
```

- [ ] **Step 3: Implement `src/main/services/RenderService.ts` with EXACTLY this content**

```ts
import type { Highlight } from '@shared/highlight';
import type { RenderClipResult, RenderProgress, RenderResult } from '@shared/render';
import { join } from 'node:path';

interface RunnerLike {
  run(opts: { args: readonly string[]; durationSec: number }): {
    onProgress(cb: (f: number) => void): void;
    cancel(): void;
    done: Promise<void>;
  };
}

export interface RenderOptions {
  sourcePath: string;
  outputDir: string;
  highlights: Highlight[];
}

type ProgressHandler = (p: RenderProgress) => void;

const VIDEO_FILTER = 'crop=ih*9/16:ih,scale=1080:1920';

/**
 * Walks a highlights array sequentially, producing one .mp4 per highlight.
 * - Cancel aborts the active ffmpeg child + marks queue tail as 'canceled'.
 * - A failed clip is recorded and the queue continues (partial success).
 * - Per-clip progress is forwarded as `RenderProgress`.
 */
export class RenderService {
  private progressHandlers: ProgressHandler[] = [];
  private activeHandle: ReturnType<RunnerLike['run']> | null = null;
  private canceled = false;

  constructor(private readonly runner: RunnerLike) {}

  onProgress(handler: ProgressHandler): () => void {
    this.progressHandlers.push(handler);
    return () => {
      this.progressHandlers = this.progressHandlers.filter((h) => h !== handler);
    };
  }

  cancel(): void {
    this.canceled = true;
    this.activeHandle?.cancel();
  }

  async render(opts: RenderOptions): Promise<RenderResult> {
    this.canceled = false;
    const results: RenderClipResult[] = [];
    const total = opts.highlights.length;

    for (let i = 0; i < opts.highlights.length; i++) {
      const h = opts.highlights[i]!;
      const clipIndex = i + 1;
      if (this.canceled) {
        results.push(this.buildClipResult(clipIndex, h, 'canceled', undefined, 'Render canceled'));
        continue;
      }
      const outputPath = join(opts.outputDir, `short_${clipIndex}.mp4`);
      const durationSec = h.end_sec - h.start_sec;
      const args = buildArgs(opts.sourcePath, h, outputPath);
      const handle = this.runner.run({ args, durationSec });
      this.activeHandle = handle;
      handle.onProgress((fraction) => {
        for (const cb of this.progressHandlers) {
          cb({ clipIndex, clipTotal: total, fraction });
        }
      });
      try {
        await handle.done;
        results.push(this.buildClipResult(clipIndex, h, 'done', outputPath));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        if (this.canceled || /canceled/i.test(message)) {
          results.push(this.buildClipResult(clipIndex, h, 'canceled', undefined, 'Render canceled'));
        } else {
          results.push(this.buildClipResult(clipIndex, h, 'failed', undefined, message));
        }
      } finally {
        this.activeHandle = null;
      }
    }

    return { outputDir: opts.outputDir, results };
  }

  private buildClipResult(
    index: number,
    h: Highlight,
    status: RenderClipResult['status'],
    outputPath?: string,
    error?: string,
  ): RenderClipResult {
    return {
      index,
      title: h.title,
      startSec: h.start_sec,
      endSec: h.end_sec,
      status,
      outputPath,
      error,
    };
  }
}

function buildArgs(sourcePath: string, h: Highlight, outputPath: string): string[] {
  return [
    '-y', // overwrite if exists
    '-i',
    sourcePath,
    '-ss',
    String(h.start_sec),
    '-to',
    String(h.end_sec),
    '-vf',
    VIDEO_FILTER,
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-progress',
    'pipe:2',
    outputPath,
  ];
}
```

- [ ] **Step 4: Run — should pass 6/6**

```bash
yarn test src/main/services/RenderService.test.ts
```

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/services/RenderService.ts src/main/services/RenderService.test.ts
git add src/main/services/RenderService.ts src/main/services/RenderService.test.ts
git commit -m "feat(m6): add RenderService with sequential queue, partial success, and cancel"
```

---

### Task 6: Wire IPC handlers in main.ts

**Files:**

- Modify: `src/main/main.ts`

The handler:

1. Reads `<audioPath>.highlights.json` from disk; throws if missing.
2. Validates with `HighlightSetSchema` (defensive — could be hand-edited).
3. Computes `sourceStem = basename(audioPath, extname(audioPath))` (strip `.mp4` / `.webm`).
4. `outputDir = join(settings.paths.outputs, sourceStem)`; `mkdir -p`.
5. Calls `renderService.render({ sourcePath: audioPath, outputDir, highlights })`.
6. Returns the `RenderResult`.

Progress events bubble to renderer via `webContents.send('render:progress', ...)`.

- [ ] **Step 1: Add imports**

In `src/main/main.ts`, add to the imports block (alphabetical placement):

```ts
import { HighlightSetSchema } from '@shared/highlight';
```

```ts
import { FfmpegRunner } from './infra/FfmpegRunner';
import { RenderService } from './services/RenderService';
```

Also add `basename` and `extname` to the existing `node:path` import line:

Find: `import { join, resolve as resolvePath } from 'node:path';`
Replace: `import { basename, extname, join, resolve as resolvePath } from 'node:path';`

- [ ] **Step 2: Add module-level state**

After the existing `let extractInFlight = false;` line, add:

```ts
let ffmpegRunner: FfmpegRunner | null = null;
let renderService: RenderService | null = null;
let renderProgressUnsub: (() => void) | null = null;
let renderInFlight = false;
```

- [ ] **Step 3: Add the lazy getter helper**

Insert ABOVE `void app.whenReady().then(() => {`:

```ts
function getRenderService(): RenderService {
  if (renderService) return renderService;
  ffmpegRunner = new FfmpegRunner({ spawn });
  renderService = new RenderService(ffmpegRunner);
  renderProgressUnsub = renderService.onProgress((p) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('render:progress', p);
    }
  });
  return renderService;
}
```

- [ ] **Step 4: Register IPC handlers**

Inside `app.whenReady().then(() => { ... })`, AFTER the existing `extract:cancel` handler and BEFORE `createMainWindow();`, add:

```ts
ipcMain.handle('render:run', async (_e, audioPath: string) => {
  if (renderInFlight) {
    throw new Error('A render is already in progress');
  }
  renderInFlight = true;
  try {
    const highlightsPath = `${audioPath}.highlights.json`;
    let raw: string;
    try {
      raw = await fsPromises.readFile(highlightsPath, 'utf8');
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(`No highlights found at ${highlightsPath}`);
      }
      throw e;
    }
    const highlightSet = HighlightSetSchema.parse(JSON.parse(raw));

    const settings = settingsStore.get();
    const sourceStem = basename(audioPath, extname(audioPath));
    const outputDir = join(settings.paths.outputs, sourceStem);
    await fsPromises.mkdir(outputDir, { recursive: true });

    const service = getRenderService();
    return await service.render({
      sourcePath: audioPath,
      outputDir,
      highlights: highlightSet.highlights,
    });
  } finally {
    renderInFlight = false;
  }
});

ipcMain.handle('render:cancel', () => {
  renderService?.cancel();
});
```

- [ ] **Step 5: Cleanup in window-all-closed**

Update the existing `app.on('window-all-closed', ...)` block. Add the render cleanup BEFORE the `if (process.platform...)` line, alongside the existing extract cleanup:

```ts
renderProgressUnsub?.();
renderProgressUnsub = null;
renderService?.cancel();
renderService = null;
ffmpegRunner = null;
```

- [ ] **Step 6: Format + typecheck**

```bash
yarn prettier --write src/main/main.ts
yarn typecheck 2>&1 | tail -20
```

Expected: typecheck STILL fails at preload + tests/renderer (Task 7 fixes that). Errors elsewhere are real bugs — fix before committing.

- [ ] **Step 7: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(m6): wire render IPC + lazy RenderService + per-job output directory"
```

---

### Task 7: Update preload bridge + test stubs

**Files:**

- Modify: `src/main/preload.ts`
- Modify: `tests/renderer/App.test.tsx`
- Modify: `tests/renderer/Settings.test.tsx`
- Modify: `tests/renderer/NewJob.test.tsx`

- [ ] **Step 1: Add the 3 new methods to preload**

Edit `src/main/preload.ts`. Add this import alongside the existing type imports (alphabetical placement — after `./highlight`, before `./settings`):

```ts
import type { RenderProgress } from '@shared/render';
```

Add these properties to the `api` object literal, alongside the existing extract block (place them after `onExtractProgress` and before `revealInFolder`):

```ts
  renderShorts: (audioPath: string) => ipcRenderer.invoke('render:run', audioPath),
  cancelRender: () => ipcRenderer.invoke('render:cancel'),
  onRenderProgress: (callback: (p: RenderProgress) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: RenderProgress) => callback(data);
    ipcRenderer.on('render:progress', handler);
    return () => {
      ipcRenderer.off('render:progress', handler);
    };
  },
```

- [ ] **Step 2: Update test stubs**

In each of `tests/renderer/App.test.tsx`, `tests/renderer/Settings.test.tsx`, `tests/renderer/NewJob.test.tsx`, find the api mock object and add these 3 stub properties (group with the existing extract stubs):

```ts
renderShorts: vi.fn(async () => ({ outputDir: '/tmp/out', results: [] })),
cancelRender: vi.fn(async () => undefined),
onRenderProgress: vi.fn(() => () => undefined),
```

For App.test.tsx + Settings.test.tsx, the api object is built directly. For NewJob.test.tsx, it's inside `installApiMock`.

- [ ] **Step 3: Run lint + typecheck + tests**

```bash
yarn lint && yarn typecheck && yarn test 2>&1 | tail -10
```

Expected:

- lint: 0 errors (1 known warning OK)
- typecheck: 0 errors
- test: all pass. Current count from end of M5 = 92; this task adds 0 new tests but unblocks the typecheck. Plus there are 2 new test files (FfmpegRunner=7, RenderService=6) that weren't yet in the count — total expected is 92 + 13 = 105.

- [ ] **Step 4: Commit**

```bash
git add src/main/preload.ts tests/renderer/App.test.tsx tests/renderer/Settings.test.tsx tests/renderer/NewJob.test.tsx
git commit -m "feat(m6): expose renderShorts/cancelRender/onRenderProgress on window.api and update test stubs"
```

---

### Task 8: useRender hook

**Files:**

- Create: `src/renderer/hooks/useRender.ts`

The hook owns the state machine. Unlike `useHighlights`, no proactive probe is needed — the prerequisite check (does the highlights.json exist on disk?) is folded into the IPC's error response and mapped to the `missing-prereq` state.

- [ ] **Step 1: Create `src/renderer/hooks/useRender.ts` with EXACTLY this content**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

import type { RenderProgress, RenderResult, RenderStatus } from '@shared/render';

export type RenderState =
  | { status: 'idle' }
  | { status: 'rendering'; audioPath: string; progress: RenderProgress | null }
  | { status: 'done'; audioPath: string; result: RenderResult }
  | { status: 'canceled'; audioPath: string }
  | { status: 'missing-prereq'; audioPath: string; error: Error }
  | { status: 'error'; audioPath: string; error: Error };

export type UseRender = {
  state: RenderState;
  status: RenderStatus | 'idle';
  start: (audioPath: string) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
};

export function useRender(): UseRender {
  const [state, setState] = useState<RenderState>({ status: 'idle' });
  const abortRef = useRef(false);

  useEffect(() => {
    const unsubscribe = window.api.onRenderProgress((p) => {
      setState((current) => {
        if (current.status === 'rendering') {
          return { status: 'rendering', audioPath: current.audioPath, progress: p };
        }
        return current;
      });
    });
    return unsubscribe;
  }, []);

  const start = useCallback(async (audioPath: string) => {
    abortRef.current = false;
    setState({ status: 'rendering', audioPath, progress: null });
    try {
      const result = await window.api.renderShorts(audioPath);
      if (abortRef.current) return;
      setState({ status: 'done', audioPath, result });
    } catch (e: unknown) {
      if (abortRef.current) return;
      const message = e instanceof Error ? e.message : String(e);
      const err = e instanceof Error ? e : new Error(message);
      if (/no highlights found|ffmpeg is not on path/i.test(message)) {
        setState({ status: 'missing-prereq', audioPath, error: err });
        return;
      }
      if (/abort|canceled/i.test(message)) {
        setState({ status: 'canceled', audioPath });
        return;
      }
      setState({ status: 'error', audioPath, error: err });
    }
  }, []);

  const cancel = useCallback(async () => {
    abortRef.current = true;
    await window.api.cancelRender();
  }, []);

  const reset = useCallback(() => {
    abortRef.current = true;
    void window.api.cancelRender();
    setState({ status: 'idle' });
  }, []);

  return { state, status: state.status, start, cancel, reset };
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/hooks/useRender.ts
yarn lint && yarn typecheck && yarn test 2>&1 | tail -8
```

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/hooks/useRender.ts
git commit -m "feat(m6): add useRender hook with state machine and abort-on-reset"
```

---

### Task 9: RenderCard component

**Files:**

- Create: `src/renderer/components/newjob/RenderCard.tsx`

Five visual states (`idle / rendering / done / canceled / error / missing-prereq`). The `done` state lists per-clip results (mark failed clips with a warning icon). Layout follows the same Tailwind patterns as `TranscribeCard` and `HighlightCard`.

- [ ] **Step 1: Create `src/renderer/components/newjob/RenderCard.tsx` with EXACTLY this content**

```tsx
import type { RenderProgress as Progress, RenderClipResult, RenderResult } from '@shared/render';

function formatPercent(p: Progress): string {
  return `${Math.round(p.fraction * 100)}%`;
}

type Props =
  | { status: 'idle'; onStart: () => void }
  | { status: 'rendering'; progress: Progress | null; onCancel: () => void }
  | {
      status: 'done';
      result: RenderResult;
      onRevealDir: () => void;
      onReset: () => void;
    }
  | { status: 'canceled'; onReset: () => void }
  | { status: 'missing-prereq'; error: Error; onReset: () => void }
  | { status: 'error'; error: Error; onReset: () => void };

export function RenderCard(props: Props) {
  return (
    <section className="border-hairline bg-canvas p-xxl shadow-1 rounded-xl border">
      {props.status === 'idle' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">숏츠 렌더링</h3>
          <p className="text-body-sm text-slate">
            추출된 하이라이트 구간을 9:16 비율 mp4 파일로 변환합니다. (M6: 중앙 크롭, 자막 없음)
          </p>
          <button
            type="button"
            onClick={props.onStart}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            숏츠 만들기
          </button>
        </div>
      ) : null}

      {props.status === 'rendering' ? (
        <div className="gap-md flex flex-col">
          <div className="gap-md flex items-baseline justify-between">
            <h3 className="text-card-title text-ink font-semibold">
              렌더링 중
              {props.progress
                ? ` (클립 ${props.progress.clipIndex}/${props.progress.clipTotal} · ${formatPercent(props.progress)})`
                : '...'}
            </h3>
          </div>
          <div className="bg-surface h-2 overflow-hidden rounded-full">
            <div
              className="bg-primary h-full transition-[width]"
              style={{
                width: props.progress
                  ? `${Math.round(((props.progress.clipIndex - 1 + props.progress.fraction) / props.progress.clipTotal) * 100)}%`
                  : '0%',
              }}
            />
          </div>
          <button
            type="button"
            onClick={props.onCancel}
            className="border-ink px-xl text-button-md text-ink h-10 self-start rounded-full border bg-transparent font-semibold"
          >
            취소
          </button>
        </div>
      ) : null}

      {props.status === 'done' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-success-text font-semibold">
            숏츠 {props.result.results.filter((r) => r.status === 'done').length}개 완성
            {props.result.results.some((r) => r.status !== 'done')
              ? ` (실패 ${props.result.results.filter((r) => r.status !== 'done').length}개)`
              : ''}
          </h3>
          <ol className="gap-sm flex flex-col">
            {props.result.results.map((r: RenderClipResult) => (
              <li key={r.index} className={`p-md rounded-lg ${r.status === 'done' ? 'bg-surface' : 'bg-warning-bg'}`}>
                <p className="text-body-md text-ink font-semibold">
                  #{r.index} {r.title}{' '}
                  <span className="text-body-sm text-slate font-normal">
                    {r.status === 'done' ? '✓ 완료' : r.status === 'canceled' ? '⊘ 취소됨' : '✗ 실패'}
                  </span>
                </p>
                {r.outputPath ? <p className="text-body-sm text-slate mt-xs break-all">{r.outputPath}</p> : null}
                {r.error ? <p className="text-body-sm text-brand-coral mt-xs">{r.error}</p> : null}
              </li>
            ))}
          </ol>
          <p className="text-body-sm text-slate break-all">{props.result.outputDir}</p>
          <div className="gap-sm flex">
            <button
              type="button"
              onClick={props.onRevealDir}
              className="bg-primary px-xl text-button-md text-on-primary h-10 rounded-full font-semibold"
            >
              폴더 열기
            </button>
            <button
              type="button"
              onClick={props.onReset}
              className="border-ink px-xl text-button-md text-ink h-10 rounded-full border bg-transparent font-semibold"
            >
              다시 만들기
            </button>
          </div>
        </div>
      ) : null}

      {props.status === 'canceled' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">렌더링 취소됨</h3>
          <button
            type="button"
            onClick={props.onReset}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            다시 시도
          </button>
        </div>
      ) : null}

      {props.status === 'missing-prereq' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">렌더링 준비 미완료</h3>
          <p className="text-body-sm text-slate">{props.error.message}</p>
          <button
            type="button"
            onClick={props.onReset}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            확인
          </button>
        </div>
      ) : null}

      {props.status === 'error' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-brand-coral font-semibold">렌더링 실패</h3>
          <p className="text-body-sm text-slate break-all">{props.error.message}</p>
          <button
            type="button"
            onClick={props.onReset}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
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
yarn prettier --write src/renderer/components/newjob/RenderCard.tsx
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/newjob/RenderCard.tsx
git commit -m "feat(m6): add RenderCard with idle/rendering/done/canceled/missing-prereq/error states"
```

---

### Task 10: Compose RenderCard into NewJob.tsx

**Files:**

- Modify: `src/renderer/pages/NewJob.tsx`

After the `highlights.state.status === 'done'` block, render the RenderCard chain. It uses its own `useRender` hook. The audio source is the same as the upstream — `transcribe.state.audioPath`.

- [ ] **Step 1: Add imports**

In `src/renderer/pages/NewJob.tsx`, add to the imports (alphabetical placement):

```tsx
import { RenderCard } from '@renderer/components/newjob/RenderCard';
import { useRender } from '@renderer/hooks/useRender';
```

- [ ] **Step 2: Add hook usage**

Inside `NewJobPage`, just below `const navigate = useNavigate();`, add:

```tsx
const renderShort = useRender();
```

(Note: `render` is too generic — use `renderShort` to avoid shadowing React's render verb in nearby readers.)

- [ ] **Step 3: Add the RenderCard chain**

Find the existing `highlights.state.status === 'done'` JSX. Currently:

```tsx
{
  highlights.state.status === 'done' ? (
    <HighlightCard
      status="done"
      highlightsPath={highlights.state.highlightsPath}
      highlightSet={highlights.state.highlightSet}
      onOpenJson={() => {
        if (highlights.state.status === 'done') void window.api.openPath(highlights.state.highlightsPath);
      }}
      onReset={() => highlights.reset()}
    />
  ) : null;
}
```

Wrap it in a fragment + add the RenderCard chain. Also: when highlights resets, also reset render.

```tsx
{
  highlights.state.status === 'done' ? (
    <>
      <HighlightCard
        status="done"
        highlightsPath={highlights.state.highlightsPath}
        highlightSet={highlights.state.highlightSet}
        onOpenJson={() => {
          if (highlights.state.status === 'done') void window.api.openPath(highlights.state.highlightsPath);
        }}
        onReset={() => {
          highlights.reset();
          renderShort.reset();
        }}
      />
      {renderShort.state.status === 'idle' ? (
        <RenderCard
          status="idle"
          onStart={() => {
            if (transcribe.state.status === 'done') void renderShort.start(transcribe.state.audioPath);
          }}
        />
      ) : null}
      {renderShort.state.status === 'rendering' ? (
        <RenderCard
          status="rendering"
          progress={renderShort.state.progress}
          onCancel={() => void renderShort.cancel()}
        />
      ) : null}
      {renderShort.state.status === 'done' ? (
        <RenderCard
          status="done"
          result={renderShort.state.result}
          onRevealDir={() => {
            if (renderShort.state.status === 'done') void window.api.revealInFolder(renderShort.state.result.outputDir);
          }}
          onReset={() => renderShort.reset()}
        />
      ) : null}
      {renderShort.state.status === 'canceled' ? (
        <RenderCard status="canceled" onReset={() => renderShort.reset()} />
      ) : null}
      {renderShort.state.status === 'missing-prereq' ? (
        <RenderCard status="missing-prereq" error={renderShort.state.error} onReset={() => renderShort.reset()} />
      ) : null}
      {renderShort.state.status === 'error' ? (
        <RenderCard status="error" error={renderShort.state.error} onReset={() => renderShort.reset()} />
      ) : null}
    </>
  ) : null;
}
```

- [ ] **Step 4: Format + verify**

```bash
yarn prettier --write src/renderer/pages/NewJob.tsx
yarn lint && yarn typecheck && yarn test 2>&1 | tail -8
```

Expected: all green; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/pages/NewJob.tsx
git commit -m "feat(m6): render RenderCard chain after highlights complete"
```

---

### Task 11: Smoke test for the render flow

**Files:**

- Modify: `tests/renderer/NewJob.test.tsx`

Add ONE test: after the highlights flow lands in `done`, the "숏츠 만들기" button is visible and clicking it calls `renderShorts` with the correct audio path. Driving the highlights flow to `done` requires the test to walk preview → download → STT → 하이라이트 추출 → wait for `JSON 열기` (highlights done) → assert render button.

- [ ] **Step 1: Move `renderShorts` mock from inline literal into `installApiMock`'s `calls` object**

In `tests/renderer/NewJob.test.tsx`, the `calls` object should now include:

```ts
renderShorts: vi.fn(async () => ({
  outputDir: '/tmp/Me at the zoo',
  results: [
    {
      index: 1,
      title: 'Opener',
      startSec: 0,
      endSec: 30,
      status: 'done',
      outputPath: '/tmp/Me at the zoo/short_1.mp4',
    },
  ],
})),
```

In the api object, REPLACE the existing inline `renderShorts: vi.fn(async () => ({...}))` with `renderShorts: calls.renderShorts`.

- [ ] **Step 2: Add the smoke test**

After the existing tests inside `describe('NewJobPage', ...)`, append:

```tsx
it('shows the 숏츠 만들기 button after highlights complete and triggers renderShorts on click', async () => {
  const calls = installApiMock({ hasApiKey: vi.fn(async () => true) });
  const user = userEvent.setup();
  render(<NewJobPage />);
  await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
  await user.click(screen.getByRole('button', { name: '미리보기' }));
  await waitFor(() => screen.getByRole('button', { name: '다운로드' }));
  await user.click(screen.getByRole('button', { name: '다운로드' }));
  await waitFor(() => screen.getByRole('button', { name: 'STT 시작' }));
  await user.click(screen.getByRole('button', { name: 'STT 시작' }));
  await waitFor(() => screen.getByRole('button', { name: '하이라이트 추출' }));
  await user.click(screen.getByRole('button', { name: '하이라이트 추출' }));
  await waitFor(() => screen.getByRole('button', { name: '숏츠 만들기' }));
  await user.click(screen.getByRole('button', { name: '숏츠 만들기' }));
  await waitFor(() => expect(calls.renderShorts).toHaveBeenCalledWith('/tmp/dQw4w9WgXcQ.mp4'));
});
```

- [ ] **Step 3: Run the test file**

```bash
yarn test tests/renderer/NewJob.test.tsx
```

Expected: 7 tests pass (6 existing + 1 new).

- [ ] **Step 4: Run the full suite**

```bash
yarn test
```

Expected: 106 tests pass (105 prior + 1 new). If a prior test broke, debug — most likely culprit is the new `useRender` hook in NewJob calling `onRenderProgress` which the existing mocks already stub out.

- [ ] **Step 5: Commit**

```bash
git add tests/renderer/NewJob.test.tsx
git commit -m "test(m6): smoke test for 숏츠 만들기 button after highlights done"
```

---

### Task 12: DoD verification + README + finalize branch

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Run all DoD checks**

```bash
yarn typecheck && yarn lint && yarn test && yarn build
cd sidecar && uv run pytest && cd ..
```

Expected: all green. Sidecar pytest still 16/16. Vitest count is 106 (92 prior + 7 FfmpegRunner + 6 RenderService + 1 smoke).

- [ ] **Step 2: Manual integration check (real ffmpeg, real video)**

In one terminal:

```bash
yarn dev
```

In the app:

1. **Settings page** — confirm `paths.outputs` is set (defaults to `~/Documents` or similar; pick an easy-to-find folder if you want).
2. **NewJob page** — paste a short YouTube URL, click 미리보기, 다운로드, wait for completion.
3. Click **STT 시작**, wait for transcript completion.
4. Click **하이라이트 추출**, wait for the highlight cards to appear.
5. Click **숏츠 만들기**. Per-clip progress should ticker through (each clip might take 10-60s depending on duration + machine).
6. When done, click **폴더 열기** — Finder should open `${outputs}/<sourceStem>/` showing `short_1.mp4`, `short_2.mp4`, etc.
7. Open one of the .mp4 files in QuickTime — confirm it's a 1080×1920 vertical clip cropped from the center of the source.

If a clip fails (codec issue, sources with weird AR, etc.), the partial-success path means other clips still produce output. The failed clip is shown with the error message in the card.

If ffmpeg is not on PATH, the IPC throws a clear error; the renderer maps it to the `missing-prereq` state with a helpful message.

If something is broken, fix and re-test BEFORE committing.

- [ ] **Step 3: Update README status**

Edit `README.md` `## Status`:

```markdown
## Status

- ✅ M1: Project Skeleton
- ✅ M2: Settings page
- ✅ M3: YouTube preview + download
- ✅ M4: Python sidecar + STT
- ✅ M5: LLM highlight extraction
- ✅ M6: First end-to-end render — system ffmpeg, center-crop 9:16, sequential per-clip queue, partial success.
- ⏳ M7: Smart face tracking (next)
```

- [ ] **Step 4: Commit + push branch**

```bash
yarn prettier --write README.md
git add README.md
git commit -m "docs(m6): mark milestone 6 complete in README"
git push -u origin m6-end-to-end-render
```

- [ ] **Step 5: Merge to master + tag**

(Done by the controller via `superpowers:finishing-a-development-branch` skill — see DoD below.)

---

## Definition of Done (M6)

All of these must be true:

1. `yarn typecheck`, `yarn lint` (only known `__dirname` warning), `yarn test`, `yarn build` all exit 0.
2. `cd sidecar && uv run pytest` reports all sidecar tests passing (16, unchanged).
3. `yarn test` includes new test files: `FfmpegRunner.test.ts` (7), `RenderService.test.ts` (6), and 1 new NewJob smoke test. No regressions in pre-existing tests.
4. Manual integration: real `yarn dev` run downloads a short video, transcribes, extracts highlights, renders, opens output folder, plays back a 1080×1920 short.
5. Branch `m6-end-to-end-render` pushed to origin.
6. After review, branch merged to master with `--no-ff` and tagged `m6-complete` on master.

## What's NOT in M6 (intentionally deferred)

- **Smart face tracking** (M7): center crop is the current strategy. M7 adds MediaPipe-based dynamic crop via `sendcmd`.
- **Subtitle burn-in** (M8): no `subtitles=` filter, no ASS generation.
- **History persistence** (M9): renders are written to disk but not indexed in SQLite.
- **Progress jitter smoothing**: ffmpeg's `out_time_us` can briefly stall while it pre-rolls keyframes. Acceptable for M6; if it bothers users, smooth in M9.
- **ffmpeg bundling** (M10): system PATH only. M10 will bundle a static binary like the planned Python sidecar bundling.
- **Per-clip cancel** (vs job-level): M6 cancel = stop the whole render run, not just the current clip. Per-clip cancel is harder UX (queue management) and not requested by the spec.
- **Container/codec choice in settings**: H264/AAC hardcoded. Settings exposure is M9-class.
- **Cut accuracy validation**: we use `-ss` after `-i` to get accurate seeking + reencode, but don't verify the output duration matches the highlight duration. Acceptable for M6.
- **Disk-space check before render**: a long source × N clips can consume hundreds of MB. No upfront check; ffmpeg will fail mid-render if disk fills, surfaced as a generic per-clip error.

## Notes for the implementing agent

- The bob-park ESLint config bans `../*` parent imports — use `@renderer/*`, `@shared/*` aliases.
- `ffmpeg` must be on PATH in dev. The plan deliberately does not add `ffmpeg-static` (that's an M10 packaging concern).
- The center-crop filter `crop=ih*9/16:ih,scale=1080:1920` assumes the source is at least as tall as 9:16 of its own height — i.e., source aspect ratio wider than 9:16. YouTube videos are typically 16:9, where this works perfectly. If a user feeds in an already-vertical source, ffmpeg may error or produce an oddly cropped result. M6 accepts this as a known limitation; M7's tracker will handle it more gracefully.
- The progress-bar formula in `RenderCard` is `(currentClipIndex - 1 + currentClipFraction) / totalClips` — gives a smooth 0..100% across the whole job rather than resetting per clip.
- `useRender.reset()` calls `cancelRender()` defensively (same pattern as `useHighlights.reset()` from M5) — prevents an orphaned ffmpeg from continuing to write to disk after the user has moved on.
- `renderInFlight` synchronous lock in `main.ts` mirrors `extractInFlight` (M5) and `downloadStarting` (M3) — same pattern, same reason.
