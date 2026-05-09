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
