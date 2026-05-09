import type { Highlight } from '@shared/highlight';
import type { RenderClipResult, RenderProgress, RenderResult } from '@shared/render';
import type { TrackResult } from '@shared/track';
import type { Word } from '@shared/transcript';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';

import { buildSendcmd } from './SendcmdGenerator';
import { type SubtitleStyle, buildAssFile } from './SubtitleGenerator';

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
  /** Whisper word-level timings, used to generate subtitle .ass files. */
  transcriptWords?: Word[];
  /** When provided AND words fall in the clip window, subtitles are burned in. */
  subtitleOptions?: SubtitleStyle;
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
  /**
   * Set to true the first time ffmpeg fails with "No such filter: 'subtitles'"
   * — meaning the user's ffmpeg lacks libass. Subsequent clips skip subtitle
   * generation entirely so we don't pay the failed-render penalty per clip.
   * Resets on every render() call so a future ffmpeg upgrade is picked up.
   */
  private subtitlesUnavailable = false;
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
    this.subtitlesUnavailable = false;
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
      const baseArgs =
        trackingInfo !== null
          ? buildTrackedArgs(opts.sourcePath, h, outputPath, trackingInfo.cmdPath)
          : buildCenterArgs(opts.sourcePath, h, outputPath);
      const subtitlesInfo =
        opts.subtitleOptions && opts.transcriptWords && !this.subtitlesUnavailable
          ? await this.maybeWriteSubtitles(opts, h, clipIndex)
          : null;
      const args = subtitlesInfo ? appendSubtitleFilter(baseArgs, subtitlesInfo.assPath) : baseArgs;

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
            subtitlesInfo ? { cues: subtitlesInfo.cueCount, assPath: subtitlesInfo.assPath } : null,
          ),
        );
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        if (this.canceled || /canceled/i.test(message)) {
          results.push(this.buildClipResult(clipIndex, h, 'canceled', undefined, 'Render canceled'));
        } else if (subtitlesInfo && /No such filter: ['"]subtitles['"]/.test(message)) {
          // ffmpeg lacks libass. Flip the flag so subsequent clips skip
          // subtitle generation entirely, then retry THIS clip without the
          // subtitles filter so the user still gets the mp4.
          this.subtitlesUnavailable = true;
          this.activeHandle = null;
          const retryHandle = this.runner.run({ args: baseArgs, durationSec });
          this.activeHandle = retryHandle;
          retryHandle.onProgress((fraction) => {
            for (const cb of this.progressHandlers) {
              cb({ clipIndex, clipTotal: total, fraction });
            }
          });
          try {
            await retryHandle.done;
            results.push(
              this.buildClipResult(
                clipIndex,
                h,
                'done',
                outputPath,
                undefined,
                trackingInfo ? { frames: trackingInfo.frameCount, trackPath: trackingInfo.trackPath } : null,
                null,
              ),
            );
          } catch (retryErr: unknown) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            results.push(this.buildClipResult(clipIndex, h, 'failed', undefined, retryMsg));
          }
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

  private async maybeWriteSubtitles(
    opts: RenderOptions,
    h: Highlight,
    clipIndex: number,
  ): Promise<{ assPath: string; cueCount: number } | null> {
    if (!opts.subtitleOptions || !opts.transcriptWords) return null;
    const assContent = buildAssFile(opts.transcriptWords, h.start_sec, h.end_sec, opts.subtitleOptions);
    if (assContent === '') return null; // no words in window
    const assPath = join(opts.outputDir, `short_${clipIndex}.ass`);
    await this.fs.writeFile(assPath, assContent, 'utf8');
    // Cue count = number of Dialogue lines (one per cue).
    const cueCount = (assContent.match(/^Dialogue:/gm) ?? []).length;
    return { assPath, cueCount };
  }

  private buildClipResult(
    index: number,
    h: Highlight,
    status: RenderClipResult['status'],
    outputPath?: string,
    error?: string,
    tracking?: RenderClipResult['tracking'],
    subtitles?: RenderClipResult['subtitles'],
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
      subtitles,
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

function appendSubtitleFilter(args: readonly string[], assPath: string): string[] {
  const out = [...args];
  const vfIndex = out.indexOf('-vf');
  if (vfIndex === -1) return out;
  // Single-quote the path so ffmpeg's filter parser tolerates spaces (very
  // common on macOS where users have spaces in their home dir / Documents
  // path). Single quotes inside the path are filesystem-illegal on macOS, so
  // no inner-escape is needed.
  out[vfIndex + 1] = `${out[vfIndex + 1]},subtitles=filename='${assPath}'`;
  return out;
}
