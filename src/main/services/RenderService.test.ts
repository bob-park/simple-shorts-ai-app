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

function fakeTracker(result: {
  sourceWidth: number;
  sourceHeight: number;
  frames: { t: number; cx: number; cy: number }[];
}) {
  return {
    track: vi.fn(async () => result),
  };
}

describe('RenderService with tracker', () => {
  let run: ReturnType<typeof vi.fn>;
  let runner: { run: typeof run };

  beforeEach(() => {
    run = vi.fn();
    runner = { run };
  });

  it('uses sendcmd args when tracker returns frames and writes track + cmd files', async () => {
    const writeFile = vi.fn(async (_path: string, _content: string, _enc?: string) => undefined);
    const fs = { writeFile };
    const tracker = fakeTracker({
      sourceWidth: 1920,
      sourceHeight: 1080,
      frames: [
        { t: 0, cx: 960, cy: 540 },
        { t: 0.5, cx: 970, cy: 545 },
      ],
    });
    const service = new RenderService(runner as never, { tracker: tracker as never, fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 30)],
    });
    h._resolve();
    const result = await promise;

    // Two files written: short_1.cmd and short_1.track.json
    expect(writeFile).toHaveBeenCalledTimes(2);
    const writePaths = writeFile.mock.calls.map((c: unknown[]) => c[0]);
    expect(writePaths).toContain('/tmp/out/short_1.cmd');
    expect(writePaths).toContain('/tmp/out/short_1.track.json');

    // ffmpeg args use sendcmd + named crop
    const args: string[] = run.mock.calls[0]![0].args;
    const vfIndex = args.indexOf('-vf');
    expect(vfIndex).toBeGreaterThan(-1);
    expect(args[vfIndex + 1]).toMatch(/sendcmd=f=\/tmp\/out\/short_1\.cmd,crop@c=ih\*9\/16:ih:0:0,scale=1080:1920/);

    // RenderClipResult.tracking populated
    expect(result.results[0]!.tracking).toEqual({ frames: 2, trackPath: '/tmp/out/short_1.track.json' });
    expect(result.results[0]!.status).toBe('done');
  });

  it('falls back to center crop when tracker returns empty frames', async () => {
    const writeFile = vi.fn(async (_path: string, _content: string, _enc?: string) => undefined);
    const fs = { writeFile };
    const tracker = fakeTracker({ sourceWidth: 1920, sourceHeight: 1080, frames: [] });
    const service = new RenderService(runner as never, { tracker: tracker as never, fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 30)],
    });
    h._resolve();
    const result = await promise;

    // No track files written
    expect(writeFile).not.toHaveBeenCalled();
    // Args use the M6 static center crop
    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=ih*9/16:ih,scale=1080:1920');
    expect(result.results[0]!.tracking).toBeNull();
    expect(result.results[0]!.status).toBe('done');
  });

  it('falls back to center crop when tracker.track throws (and clip still succeeds)', async () => {
    const writeFile = vi.fn(async (_path: string, _content: string, _enc?: string) => undefined);
    const fs = { writeFile };
    const tracker = {
      track: vi.fn(async () => {
        throw new Error('tracker explosion');
      }),
    };
    const service = new RenderService(runner as never, { tracker: tracker as never, fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 30)],
    });
    h._resolve();
    const result = await promise;

    // Same fallback path as empty frames
    expect(writeFile).not.toHaveBeenCalled();
    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=ih*9/16:ih,scale=1080:1920');
    expect(result.results[0]!.tracking).toBeNull();
    expect(result.results[0]!.status).toBe('done');
  });

  it('falls back to center crop when buildSendcmd throws (portrait source)', async () => {
    const writeFile = vi.fn(async (_path: string, _content: string, _enc?: string) => undefined);
    const fs = { writeFile };
    // Portrait source: 1000×2000 → cropW would be 1125 > sourceWidth, buildSendcmd throws.
    const tracker = fakeTracker({
      sourceWidth: 1000,
      sourceHeight: 2000,
      frames: [{ t: 0, cx: 500, cy: 1000 }],
    });
    const service = new RenderService(runner as never, { tracker: tracker as never, fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/portrait.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 30)],
    });
    h._resolve();
    const result = await promise;

    // No track files written — buildSendcmd's throw is caught + degraded to fallback.
    expect(writeFile).not.toHaveBeenCalled();
    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=ih*9/16:ih,scale=1080:1920');
    expect(result.results[0]!.tracking).toBeNull();
    expect(result.results[0]!.status).toBe('done');
  });
});

const SUBTITLE_OPTS = {
  fontFamily: 'Pretendard',
  fontSize: 64,
  fillColor: '#FFFFFF',
  outlineColor: '#000000',
  position: 'bottom' as const,
};

function fakeWords(specs: { text: string; start: number; end: number }[]) {
  return specs;
}

describe('RenderService with subtitles', () => {
  let run: ReturnType<typeof vi.fn>;
  let runner: { run: typeof run };

  beforeEach(() => {
    run = vi.fn();
    runner = { run };
  });

  it('writes .ass file and appends subtitles= to filter chain when options provided + words in window', async () => {
    const writeFile = vi.fn(async (_path: string, _content: string, _enc?: string) => undefined);
    const fs = { writeFile };
    const service = new RenderService(runner as never, { fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 30)],
      transcriptWords: fakeWords([
        { text: 'hello', start: 0, end: 0.5 },
        { text: 'world', start: 0.5, end: 1.0 },
      ]),
      subtitleOptions: SUBTITLE_OPTS,
    });
    h._resolve();
    const result = await promise;

    // .ass file written
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0]).toBe('/tmp/out/short_1.ass');
    const assContent = writeFile.mock.calls[0]![1] as string;
    expect(assContent).toContain('Dialogue:');
    expect(assContent).toContain('hello world');

    // ffmpeg filter chain ends with subtitles=filename=<path>
    const args: string[] = run.mock.calls[0]![0].args;
    const vfIndex = args.indexOf('-vf');
    expect(args[vfIndex + 1]).toContain("crop=ih*9/16:ih,scale=1080:1920,subtitles=filename='/tmp/out/short_1.ass'");

    // RenderClipResult.subtitles populated
    expect(result.results[0]!.subtitles).toEqual({ cues: 1, assPath: '/tmp/out/short_1.ass' });
  });

  it('skips ass writing + filter when subtitleOptions is undefined', async () => {
    const writeFile = vi.fn(async (_path: string, _content: string, _enc?: string) => undefined);
    const fs = { writeFile };
    const service = new RenderService(runner as never, { fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 30)],
      transcriptWords: fakeWords([{ text: 'hi', start: 0, end: 0.5 }]),
      // subtitleOptions intentionally omitted
    });
    h._resolve();
    const result = await promise;

    expect(writeFile).not.toHaveBeenCalled();
    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=ih*9/16:ih,scale=1080:1920');
    expect(result.results[0]!.subtitles).toBeNull();
  });

  it('skips ass writing when no transcript words fall inside the clip window', async () => {
    const writeFile = vi.fn(async (_path: string, _content: string, _enc?: string) => undefined);
    const fs = { writeFile };
    const service = new RenderService(runner as never, { fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 100, 130)],
      transcriptWords: fakeWords([{ text: 'hi', start: 0, end: 0.5 }]), // outside [100, 130]
      subtitleOptions: SUBTITLE_OPTS,
    });
    h._resolve();
    const result = await promise;

    expect(writeFile).not.toHaveBeenCalled();
    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=ih*9/16:ih,scale=1080:1920');
    expect(result.results[0]!.subtitles).toBeNull();
  });

  it('single-quotes the .ass path in the filter so paths with spaces work (macOS)', async () => {
    const writeFile = vi.fn(async (_path: string, _content: string, _enc?: string) => undefined);
    const fs = { writeFile };
    const service = new RenderService(runner as never, { fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      // Path with a literal space — common on macOS user folders.
      outputDir: '/Users/Bob Smith/Movies',
      highlights: [fakeHighlight(1, 0, 30)],
      transcriptWords: fakeWords([{ text: 'hi', start: 0, end: 0.5 }]),
      subtitleOptions: SUBTITLE_OPTS,
    });
    h._resolve();
    await promise;

    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toContain("subtitles=filename='/Users/Bob Smith/Movies/short_1.ass'");
  });
});
