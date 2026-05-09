import type { Highlight } from '@shared/highlight';
import type { RenderClipResult, RenderProgress, RenderResult } from '@shared/render';
import type { TrackResult } from '@shared/track';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';

import { buildSendcmd } from './SendcmdGenerator';

interface RunnerLike {
  run(opts: { args: readonly string[]; durationSec: number }): {
    onProgress(cb: (f: number) => void): void;
    cancel(): void;
    done: Promise<void>;
  };
}

interface TrackerLike {
  track(videoPath: string, opts: { startSec: number; endSec: number; fpsSample?: number }): Promise<TrackResult>;
}

type FsLike = Pick<typeof fsPromises, 'writeFile'>;

export interface RenderServiceOptions {
  /** When provided, each clip is tracked before rendering. */
  tracker?: TrackerLike;
  /** Injected for tests. Defaults to the real fs.promises. */
  fs?: FsLike;
}

export interface RenderOptions {
  sourcePath: string;
  outputDir: string;
  highlights: Highlight[];
}

type ProgressHandler = (p: RenderProgress) => void;

const CENTER_CROP_FILTER = 'crop=ih*9/16:ih,scale=1080:1920';

/**
 * Walks a highlights array sequentially, producing one .mp4 per highlight.
 * - If a tracker is configured, each clip is face-tracked and rendered with
 *   a dynamic sendcmd-driven crop. If tracking returns no frames or throws,
 *   the clip falls back to the M6 static center crop and its `tracking` field
 *   is `null`.
 * - Cancel aborts the active ffmpeg child + marks queue tail as 'canceled'.
 * - A failed clip (ffmpeg error) is recorded and the queue continues.
 */
export class RenderService {
  private progressHandlers: ProgressHandler[] = [];
  private activeHandle: ReturnType<RunnerLike['run']> | null = null;
  private canceled = false;
  private readonly tracker?: TrackerLike;
  private readonly fs: FsLike;

  constructor(
    private readonly runner: RunnerLike,
    options: RenderServiceOptions = {},
  ) {
    this.tracker = options.tracker;
    this.fs = options.fs ?? fsPromises;
  }

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

      const trackingInfo = this.tracker ? await this.maybeTrackAndPersist(opts, h, clipIndex) : null;
      const args =
        trackingInfo !== null
          ? buildTrackedArgs(opts.sourcePath, h, outputPath, trackingInfo.cmdPath)
          : buildCenterArgs(opts.sourcePath, h, outputPath);

      const handle = this.runner.run({ args, durationSec });
      this.activeHandle = handle;
      handle.onProgress((fraction) => {
        for (const cb of this.progressHandlers) {
          cb({ clipIndex, clipTotal: total, fraction });
        }
      });
      try {
        await handle.done;
        results.push(
          this.buildClipResult(
            clipIndex,
            h,
            'done',
            outputPath,
            undefined,
            trackingInfo ? { frames: trackingInfo.frameCount, trackPath: trackingInfo.trackPath } : null,
          ),
        );
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

  private async maybeTrackAndPersist(
    opts: RenderOptions,
    h: Highlight,
    clipIndex: number,
  ): Promise<{ cmdPath: string; trackPath: string; frameCount: number } | null> {
    if (!this.tracker) return null;
    let track: TrackResult;
    try {
      track = await this.tracker.track(opts.sourcePath, {
        startSec: h.start_sec,
        endSec: h.end_sec,
      });
    } catch {
      // Tracking failure is non-fatal — clip falls back to center crop.
      return null;
    }
    if (track.frames.length === 0) return null;
    let cmdContent: string;
    try {
      cmdContent = buildSendcmd(track, h.start_sec);
    } catch {
      // SendcmdGenerator throws when the source is already 9:16 or taller —
      // M7's sendcmd-driven crop can't handle that geometry. Fall back to the
      // M6 center-crop args (which also degenerates to a no-op for portrait
      // sources, but at least doesn't crash the entire render job).
      return null;
    }
    const cmdPath = join(opts.outputDir, `short_${clipIndex}.cmd`);
    const trackPath = join(opts.outputDir, `short_${clipIndex}.track.json`);
    await this.fs.writeFile(cmdPath, cmdContent, 'utf8');
    await this.fs.writeFile(trackPath, JSON.stringify(track, null, 2), 'utf8');
    return { cmdPath, trackPath, frameCount: track.frames.length };
  }

  private buildClipResult(
    index: number,
    h: Highlight,
    status: RenderClipResult['status'],
    outputPath?: string,
    error?: string,
    tracking?: RenderClipResult['tracking'],
  ): RenderClipResult {
    return {
      index,
      title: h.title,
      startSec: h.start_sec,
      endSec: h.end_sec,
      status,
      outputPath,
      error,
      tracking,
    };
  }
}

const COMMON_ENCODE_ARGS = [
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
];

function buildCenterArgs(sourcePath: string, h: Highlight, outputPath: string): string[] {
  return [
    '-y',
    '-i',
    sourcePath,
    '-ss',
    String(h.start_sec),
    '-to',
    String(h.end_sec),
    '-vf',
    CENTER_CROP_FILTER,
    ...COMMON_ENCODE_ARGS,
    outputPath,
  ];
}

function buildTrackedArgs(sourcePath: string, h: Highlight, outputPath: string, cmdPath: string): string[] {
  const filter = `sendcmd=f=${cmdPath},crop@c=ih*9/16:ih:0:0,scale=1080:1920`;
  return [
    '-y',
    '-i',
    sourcePath,
    '-ss',
    String(h.start_sec),
    '-to',
    String(h.end_sec),
    '-vf',
    filter,
    ...COMMON_ENCODE_ARGS,
    outputPath,
  ];
}
