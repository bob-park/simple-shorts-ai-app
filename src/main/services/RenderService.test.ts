import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RenderService } from './RenderService';

function fakeHighlight(i: number, start: number, end: number) {
  return {
    segments: [{ start_sec: start, end_sec: end }],
    title: `H${i}`,
    hook: `hook${i}`,
  };
}

function fakeMultiSegHighlight(i: number, ranges: { start: number; end: number }[]) {
  return {
    segments: ranges.map((r) => ({ start_sec: r.start, end_sec: r.end })),
    title: `H${i}`,
    hook: `hook${i}`,
  };
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
  let writeFile: ReturnType<typeof vi.fn>;
  let service: RenderService;

  beforeEach(() => {
    run = vi.fn();
    runner = { run };
    writeFile = vi.fn(async (_path: string, _content: string, _enc?: string) => undefined);
    service = new RenderService(runner as never, { fs: { writeFile } as never });
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

    // First clip starts after writeAssFile resolves (one microtask)
    await new Promise((r) => setTimeout(r, 0));
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

  it('builds ffmpeg args with select cuts, the 3:4 crop + 1080×1440 scale + 1080×1920 pad filter chain, libx264, and aac', async () => {
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
    // No -ss / -to anymore — select filter does the cuts
    expect(args).not.toContain('-ss');
    expect(args).not.toContain('-to');
    expect(args).toContain('-i');
    expect(args[args.indexOf('-i') + 1]).toBe('/tmp/in.mp4');
    expect(args).toContain('-vf');
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "select='between(t,5,35)',setpts=N/FRAME_RATE/TB,crop=ih*3/4:ih,scale=1080:1440,pad=1080:1920:0:240:black,subtitles=filename='/tmp/out/short_1.ass'",
    );
    expect(args).toContain('-af');
    expect(args[args.indexOf('-af') + 1]).toBe("aselect='between(t,5,35)',asetpts=N/SR/TB");
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args[args.length - 1]).toBe('/tmp/out/short_1.mp4');
    // ASS file always written (title-only when no transcript words / options provided)
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0]).toBe('/tmp/out/short_1.ass');
    expect(writeFile.mock.calls[0]![1] as string).toContain('Style: Title,');
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

    // Yield for writeAssFile to resolve before emitting progress
    await new Promise((r) => setTimeout(r, 0));
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

    // Three files written: short_1.cmd, short_1.track.json, and short_1.ass (always written)
    expect(writeFile).toHaveBeenCalledTimes(3);
    const writePaths = writeFile.mock.calls.map((c: unknown[]) => c[0]);
    expect(writePaths).toContain('/tmp/out/short_1.cmd');
    expect(writePaths).toContain('/tmp/out/short_1.track.json');
    expect(writePaths).toContain('/tmp/out/short_1.ass');

    // ffmpeg args use sendcmd + named crop
    const args: string[] = run.mock.calls[0]![0].args;
    const vfIndex = args.indexOf('-vf');
    expect(vfIndex).toBeGreaterThan(-1);
    expect(args[vfIndex + 1]).toBe(
      "select='between(t,0,30)',setpts=N/FRAME_RATE/TB,sendcmd=f=/tmp/out/short_1.cmd,crop@c=ih*3/4:ih:0:0,scale=1080:1440,pad=1080:1920:0:240:black,subtitles=filename='/tmp/out/short_1.ass'",
    );

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

    // No track files written — but .ass is always written (title-only)
    expect(writeFile).toHaveBeenCalledTimes(1);
    const writePaths = writeFile.mock.calls.map((c: unknown[]) => c[0]);
    expect(writePaths).not.toContain('/tmp/out/short_1.cmd');
    expect(writePaths).not.toContain('/tmp/out/short_1.track.json');
    expect(writePaths).toContain('/tmp/out/short_1.ass');
    // Args use the static center crop with select filter
    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "select='between(t,0,30)',setpts=N/FRAME_RATE/TB,crop=ih*3/4:ih,scale=1080:1440,pad=1080:1920:0:240:black,subtitles=filename='/tmp/out/short_1.ass'",
    );
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

    // Same fallback path as empty frames — .ass always written (title-only), no track files
    expect(writeFile).toHaveBeenCalledTimes(1);
    const writePaths = writeFile.mock.calls.map((c: unknown[]) => c[0]);
    expect(writePaths).toContain('/tmp/out/short_1.ass');
    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "select='between(t,0,30)',setpts=N/FRAME_RATE/TB,crop=ih*3/4:ih,scale=1080:1440,pad=1080:1920:0:240:black,subtitles=filename='/tmp/out/short_1.ass'",
    );
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
    // .ass is still always written (title-only).
    expect(writeFile).toHaveBeenCalledTimes(1);
    const writePaths = writeFile.mock.calls.map((c: unknown[]) => c[0]);
    expect(writePaths).not.toContain('/tmp/out/short_1.cmd');
    expect(writePaths).toContain('/tmp/out/short_1.ass');
    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "select='between(t,0,30)',setpts=N/FRAME_RATE/TB,crop=ih*3/4:ih,scale=1080:1440,pad=1080:1920:0:240:black,subtitles=filename='/tmp/out/short_1.ass'",
    );
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
    expect(args[vfIndex + 1]).toBe(
      "select='between(t,0,30)',setpts=N/FRAME_RATE/TB,crop=ih*3/4:ih,scale=1080:1440,pad=1080:1920:0:240:black,subtitles=filename='/tmp/out/short_1.ass'",
    );

    // RenderClipResult.subtitles populated
    expect(result.results[0]!.subtitles).toEqual({ cues: 1, assPath: '/tmp/out/short_1.ass' });
  });

  it('writes title-only ass + subtitles filter when subtitleOptions is undefined', async () => {
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

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0]).toBe('/tmp/out/short_1.ass');
    const ass = writeFile.mock.calls[0]![1] as string;
    expect(ass).toContain('Style: Title,');
    // No Default-style Dialogue (no subtitleOptions → no word cues are emitted by RenderService)
    expect(ass).not.toContain(',Default,');

    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "select='between(t,0,30)',setpts=N/FRAME_RATE/TB,crop=ih*3/4:ih,scale=1080:1440,pad=1080:1920:0:240:black,subtitles=filename='/tmp/out/short_1.ass'",
    );
    // RenderClipResult.subtitles → null because no word cues were emitted.
    expect(result.results[0]!.subtitles).toBeNull();
  });

  it('writes title-only ass when no transcript words fall inside the clip window', async () => {
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

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0]).toBe('/tmp/out/short_1.ass');
    const ass = writeFile.mock.calls[0]![1] as string;
    expect(ass).toContain('Style: Title,');
    expect(ass).not.toContain(',Default,'); // no word cues fell in window

    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "select='between(t,100,130)',setpts=N/FRAME_RATE/TB,crop=ih*3/4:ih,scale=1080:1440,pad=1080:1920:0:240:black,subtitles=filename='/tmp/out/short_1.ass'",
    );
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

  it('retries clip without subtitles filter when ffmpeg lacks libass, then skips for subsequent clips', async () => {
    const writeFile = vi.fn(async (_path: string, _content: string, _enc?: string) => undefined);
    const fs = { writeFile };
    const service = new RenderService(runner as never, { fs: fs as never });

    // Clip 1: first run fails with subtitle filter error → retry succeeds without subtitles.
    const h1Fail = fakeRunHandle();
    const h1Retry = fakeRunHandle();
    // Clip 2: should skip subtitle gen entirely (no filter, no .ass write).
    const h2 = fakeRunHandle();
    run.mockReturnValueOnce(h1Fail).mockReturnValueOnce(h1Retry).mockReturnValueOnce(h2);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 30), fakeHighlight(2, 60, 90)],
      transcriptWords: fakeWords([
        { text: 'hi', start: 0, end: 0.5 },
        { text: 'there', start: 60, end: 60.5 },
      ]),
      subtitleOptions: SUBTITLE_OPTS,
    });

    h1Fail._reject("[AVFilterGraph @ 0x123] No such filter: 'subtitles'");
    await new Promise((r) => setTimeout(r, 0));
    h1Retry._resolve();
    await new Promise((r) => setTimeout(r, 0));
    h2._resolve();
    const result = await promise;

    // Three runs total: clip1 attempt + clip1 retry + clip2 (no retry needed)
    expect(run).toHaveBeenCalledTimes(3);
    // Clip 1 retry args have NO subtitles filter
    const retryArgs: string[] = run.mock.calls[1]![0].args;
    expect(retryArgs[retryArgs.indexOf('-vf') + 1]).toBe(
      "select='between(t,0,30)',setpts=N/FRAME_RATE/TB,crop=ih*3/4:ih,scale=1080:1440,pad=1080:1920:0:240:black",
    );
    // Clip 2 args also have NO subtitles filter (service flag set after first failure)
    const clip2Args: string[] = run.mock.calls[2]![0].args;
    expect(clip2Args[clip2Args.indexOf('-vf') + 1]).toBe(
      "select='between(t,60,90)',setpts=N/FRAME_RATE/TB,crop=ih*3/4:ih,scale=1080:1440,pad=1080:1920:0:240:black",
    );
    // Both clips end up done with subtitles: null
    expect(result.results[0]!.status).toBe('done');
    expect(result.results[0]!.subtitles).toBeNull();
    expect(result.results[1]!.status).toBe('done');
    expect(result.results[1]!.subtitles).toBeNull();
    // Both clips' ASS files are written (we don't gate writing on the libass
    // flag — only the filter application). The harmless leftovers are fine.
    const writePaths = writeFile.mock.calls.map((c) => c[0]);
    expect(writePaths).toContain('/tmp/out/short_1.ass');
    expect(writePaths).toContain('/tmp/out/short_2.ass');
  });

  it('multi-segment highlight builds select filter with multiple between() ranges', async () => {
    const writeFile = vi.fn(async (_p: string, _c: string, _e?: string) => undefined);
    const fs = { writeFile };
    const service = new RenderService(runner as never, { fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [
        fakeMultiSegHighlight(1, [
          { start: 5, end: 8 },
          { start: 12, end: 15 },
          { start: 30, end: 33 },
        ]),
      ],
    });
    h._resolve();
    const result = await promise;

    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "select='between(t,5,8)+between(t,12,15)+between(t,30,33)',setpts=N/FRAME_RATE/TB,crop=ih*3/4:ih,scale=1080:1440,pad=1080:1920:0:240:black,subtitles=filename='/tmp/out/short_1.ass'",
    );
    expect(args[args.indexOf('-af') + 1]).toBe(
      "aselect='between(t,5,8)+between(t,12,15)+between(t,30,33)',asetpts=N/SR/TB",
    );
    // durationSec = sum of segment durations (3+3+3 = 9)
    expect(run.mock.calls[0]![0].durationSec).toBe(9);
    // RenderClipResult.startSec/endSec derived from first/last segments
    expect(result.results[0]!.startSec).toBe(5);
    expect(result.results[0]!.endSec).toBe(33);
  });

  it('multi-segment with tracker rebases per-segment frames into one sendcmd file', async () => {
    const writeFile = vi.fn(async (_p: string, _c: string, _e?: string) => undefined);
    const fs = { writeFile };
    // Tracker returns one frame per segment, in source-time
    const trackerCalls: { startSec: number; endSec: number }[] = [];
    const tracker = {
      track: vi.fn(async (_path: string, opts: { startSec: number; endSec: number }) => {
        trackerCalls.push({ startSec: opts.startSec, endSec: opts.endSec });
        return {
          sourceWidth: 1920,
          sourceHeight: 1080,
          frames: [{ t: opts.startSec + 1, cx: 500, cy: 500 }],
        };
      }),
    };
    const service = new RenderService(runner as never, { tracker: tracker as never, fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [
        fakeMultiSegHighlight(1, [
          { start: 10, end: 13 },
          { start: 100, end: 102 },
        ]),
      ],
    });
    h._resolve();
    await promise;

    // Tracker called once per segment
    expect(trackerCalls).toEqual([
      { startSec: 10, endSec: 13 },
      { startSec: 100, endSec: 102 },
    ]);
    // .cmd file contains rebased times: seg 0 → t=1 (10→11 rebased to 1), seg 1 → t=4 (100→101 rebased to 3+1=4)
    const cmdWrite = writeFile.mock.calls.find((c) => String(c[0]).endsWith('.cmd'))!;
    const cmdContent = cmdWrite[1] as string;
    expect(cmdContent).toContain('1 crop@c x');
    expect(cmdContent).toContain('4 crop@c x');
  });

  it('still face-tracks the highlight when one segment has zero tracked frames (synthetic fill)', async () => {
    const writeFile = vi.fn(async (_p: string, _c: string, _e?: string) => undefined);
    const fs = { writeFile };
    let call = 0;
    const tracker = {
      track: vi.fn(async () => {
        call += 1;
        return {
          sourceWidth: 1920,
          sourceHeight: 1080,
          frames: call === 1 ? [{ t: 11, cx: 500, cy: 500 }] : [],
        };
      }),
    };
    const service = new RenderService(runner as never, { tracker: tracker as never, fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [
        fakeMultiSegHighlight(1, [
          { start: 10, end: 13 },
          { start: 100, end: 102 },
        ]),
      ],
    });
    h._resolve();
    const result = await promise;

    // Tracked path (sendcmd present, not center-only crop)
    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toContain('sendcmd');
    expect(result.results[0]!.tracking).not.toBeNull();
  });

  it('multi-segment with subtitles rebases words across the montage timeline', async () => {
    const writeFile = vi.fn(async (_p: string, _c: string, _e?: string) => undefined);
    const fs = { writeFile };
    const service = new RenderService(runner as never, { fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [
        fakeMultiSegHighlight(1, [
          { start: 10, end: 13 },
          { start: 100, end: 102 },
        ]),
      ],
      transcriptWords: [
        { text: 'hello', start: 11, end: 11.5 }, // seg 0 → t=1.0..1.5
        { text: 'world', start: 100.5, end: 101 }, // seg 1 → t=3.5..4
      ],
      subtitleOptions: SUBTITLE_OPTS,
    });
    h._resolve();
    await promise;

    const assWrite = writeFile.mock.calls.find((c) => String(c[0]).endsWith('.ass'))!;
    const assContent = assWrite[1] as string;
    // buildAssFile groups 2 words per cue. Both words land in one cue:
    //   start = 1.0 (hello rebased), end = 4.0 (world rebased end).
    // Montage-relative times confirmed: hello→seg0 offset 1s, world→seg1 offset 3+0.5=3.5s..4s.
    expect(assContent).toContain('0:00:01.00,0:00:04.00'); // combined cue for 'hello world'
    expect(assContent).toContain('hello world');
  });

  it('multi-segment durationSec passed to runner is the sum of segment durations', async () => {
    const writeFile = vi.fn(async (_p: string, _c: string, _e?: string) => undefined);
    const service = new RenderService(runner as never, { fs: { writeFile } as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [
        fakeMultiSegHighlight(1, [
          { start: 0, end: 5 },
          { start: 10, end: 15 },
          { start: 20, end: 25 },
        ]),
      ],
    });
    h._resolve();
    await promise;

    // 3 segments × 5s = 15s
    expect(run.mock.calls[0]![0].durationSec).toBe(15);
  });
});
