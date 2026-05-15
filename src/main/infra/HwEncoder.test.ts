import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { NVENC_VIDEO_ARGS, X264_VIDEO_ARGS, nvencAvailable, nvencProbeArgs } from './HwEncoder';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function spawnReturning(exitCode: number | null, opts: { throwOnSpawn?: boolean; emitError?: boolean } = {}) {
  const child = new FakeChild();
  const spawn = vi.fn(() => {
    if (opts.throwOnSpawn) throw new Error('spawn EACCES');
    queueMicrotask(() => {
      if (opts.emitError) child.emit('error', new Error('ENOENT'));
      else child.emit('exit', exitCode);
    });
    return child as never;
  });
  return spawn;
}

describe('HwEncoder', () => {
  it('arg sets: NVENC uses h264_nvenc + -cq (NVENC ignores -crf); x264 uses libx264 + -crf', () => {
    expect(NVENC_VIDEO_ARGS).toContain('h264_nvenc');
    expect(NVENC_VIDEO_ARGS).toContain('-cq');
    expect(NVENC_VIDEO_ARGS).not.toContain('-crf');
    expect(X264_VIDEO_ARGS).toEqual(['-c:v', 'libx264', '-preset', 'fast', '-crf', '23']);
  });

  it('probe args do a fast lavfi null-encode through h264_nvenc', () => {
    const a = nvencProbeArgs();
    expect(a).toContain('h264_nvenc');
    expect(a).toContain('lavfi');
    expect(a[a.length - 1]).toBe('-');
    expect(a).toContain('null');
  });

  it('nvencAvailable → true when the probe exits 0', async () => {
    const spawn = spawnReturning(0);
    await expect(nvencAvailable({ ffmpegCmd: 'ffmpeg', spawn: spawn as never })).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledWith('ffmpeg', nvencProbeArgs(), expect.anything());
  });

  it('nvencAvailable → false when the probe exits non-zero (no NVIDIA / unsupported)', async () => {
    await expect(nvencAvailable({ ffmpegCmd: 'ffmpeg', spawn: spawnReturning(1) as never })).resolves.toBe(false);
  });

  it('nvencAvailable → false on spawn error or throw (never rejects)', async () => {
    await expect(
      nvencAvailable({ ffmpegCmd: 'ffmpeg', spawn: spawnReturning(null, { emitError: true }) as never }),
    ).resolves.toBe(false);
    await expect(
      nvencAvailable({ ffmpegCmd: 'ffmpeg', spawn: spawnReturning(0, { throwOnSpawn: true }) as never }),
    ).resolves.toBe(false);
  });
});
