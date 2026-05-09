interface RunnerLike {
  run(opts: { args: readonly string[]; durationSec: number }): {
    onProgress(cb: (f: number) => void): void;
    cancel(): void;
    done: Promise<void>;
  };
}

export interface ExtractOptions {
  startSec: number;
  endSec: number;
}

/**
 * Extracts a single PNG frame at the midpoint of a clip range. Failures are
 * non-fatal — returns null so the caller can skip the thumb without aborting
 * the whole history-record flow.
 */
export class ThumbnailService {
  constructor(private readonly runner: RunnerLike) {}

  async extractMidpoint(videoPath: string, outPath: string, opts: ExtractOptions): Promise<string | null> {
    const midpoint = (opts.startSec + opts.endSec) / 2;
    const args = ['-y', '-ss', String(midpoint), '-i', videoPath, '-vframes', '1', outPath];
    const handle = this.runner.run({ args, durationSec: 1 });
    try {
      await handle.done;
      return outPath;
    } catch {
      return null;
    }
  }
}
