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
   * `out_time_us` into a 0..1 fraction. Pass the sum of the highlight's segment durations.
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
