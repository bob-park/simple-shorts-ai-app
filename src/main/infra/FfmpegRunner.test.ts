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
