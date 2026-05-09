import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThumbnailService } from './ThumbnailService';

function fakeRunHandle(succeed: boolean) {
  return {
    onProgress: vi.fn(),
    cancel: vi.fn(),
    done: succeed ? Promise.resolve() : Promise.reject(new Error('ffmpeg failed')),
  };
}

describe('ThumbnailService', () => {
  let run: ReturnType<typeof vi.fn>;
  let runner: { run: typeof run };
  let service: ThumbnailService;

  beforeEach(() => {
    run = vi.fn();
    runner = { run };
    service = new ThumbnailService(runner as never);
  });

  it('builds ffmpeg args with -ss, -i, -vframes 1, png output', async () => {
    run.mockReturnValue(fakeRunHandle(true));
    await service.extractMidpoint('/tmp/in.mp4', '/tmp/thumbs/s1.png', { startSec: 5, endSec: 35 });
    expect(run).toHaveBeenCalledTimes(1);
    const args: string[] = run.mock.calls[0]![0].args;
    // midpoint = 20s
    expect(args).toContain('-ss');
    expect(args[args.indexOf('-ss') + 1]).toBe('20');
    expect(args).toContain('-i');
    expect(args[args.indexOf('-i') + 1]).toBe('/tmp/in.mp4');
    expect(args).toContain('-vframes');
    expect(args[args.indexOf('-vframes') + 1]).toBe('1');
    expect(args[args.length - 1]).toBe('/tmp/thumbs/s1.png');
  });

  it('returns the output path on success', async () => {
    run.mockReturnValue(fakeRunHandle(true));
    const got = await service.extractMidpoint('/tmp/in.mp4', '/tmp/thumbs/s1.png', { startSec: 0, endSec: 10 });
    expect(got).toBe('/tmp/thumbs/s1.png');
  });

  it('returns null on ffmpeg failure (non-fatal)', async () => {
    run.mockReturnValue(fakeRunHandle(false));
    const got = await service.extractMidpoint('/tmp/in.mp4', '/tmp/thumbs/s1.png', { startSec: 0, endSec: 10 });
    expect(got).toBeNull();
  });
});
