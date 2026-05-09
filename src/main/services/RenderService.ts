import type { Highlight, HighlightSegment } from '@shared/highlight';
import type { RenderClipResult, RenderProgress, RenderResult } from '@shared/render';
import type { TrackResult } from '@shared/track';
import type { Word } from '@shared/transcript';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';

import { rebaseTrackingFrames, rebaseTranscriptWords } from './MontageHelpers';
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

export class RenderService {
  private progressHandlers: ProgressHandler[] = [];
  private activeHandle: ReturnType<RunnerLike['run']> | null = null;
  private canceled = false;
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
      const durationSec = h.segments.reduce((acc, s) => acc + (s.end_sec - s.start_sec), 0);

      const trackingInfo = this.tracker ? await this.maybeTrackAndPersist(opts, h, clipIndex) : null;
      const baseArgs =
        trackingInfo !== null
          ? buildTrackedArgs(opts.sourcePath, h.segments, outputPath, trackingInfo.cmdPath)
          : buildCenterArgs(opts.sourcePath, h.segments, outputPath);
      const subtitlesInfo =
        opts.subtitleOptions && opts.transcriptWords && !this.subtitlesUnavailable
          ? await this.maybeWriteSubtitles(opts, h, clipIndex, durationSec)
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
    const perSegmentResults: TrackResult[] = [];
    let firstResult: TrackResult | null = null;
    for (const seg of h.segments) {
      try {
        const r = await this.tracker.track(opts.sourcePath, {
          startSec: seg.start_sec,
          endSec: seg.end_sec,
        });
        if (firstResult === null) firstResult = r;
        perSegmentResults.push(r);
      } catch {
        // Tracking failure on any segment is non-fatal — fall back to center crop.
        return null;
      }
    }
    const allFrames = rebaseTrackingFrames(h.segments, perSegmentResults);
    if (allFrames.length === 0 || firstResult === null) return null;

    const aggregated: TrackResult = {
      sourceWidth: firstResult.sourceWidth,
      sourceHeight: firstResult.sourceHeight,
      frames: allFrames,
    };
    let cmdContent: string;
    try {
      cmdContent = buildSendcmd(aggregated, 0);
    } catch {
      // Source too vertical for sendcmd — fall back to center crop.
      return null;
    }
    const cmdPath = join(opts.outputDir, `short_${clipIndex}.cmd`);
    const trackPath = join(opts.outputDir, `short_${clipIndex}.track.json`);
    await this.fs.writeFile(cmdPath, cmdContent, 'utf8');
    await this.fs.writeFile(trackPath, JSON.stringify(aggregated, null, 2), 'utf8');
    return { cmdPath, trackPath, frameCount: allFrames.length };
  }

  private async maybeWriteSubtitles(
    opts: RenderOptions,
    h: Highlight,
    clipIndex: number,
    montageDuration: number,
  ): Promise<{ assPath: string; cueCount: number } | null> {
    if (!opts.subtitleOptions || !opts.transcriptWords) return null;
    const rebased = rebaseTranscriptWords(h.segments, opts.transcriptWords);
    if (rebased.length === 0) return null;
    const assContent = buildAssFile(rebased, 0, montageDuration, opts.subtitleOptions);
    if (assContent === '') return null;
    const assPath = join(opts.outputDir, `short_${clipIndex}.ass`);
    await this.fs.writeFile(assPath, assContent, 'utf8');
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
      // History persistence (M9): coarse range = first segment start..last segment end.
      startSec: h.segments[0]!.start_sec,
      endSec: h.segments[h.segments.length - 1]!.end_sec,
      montageDurationSec: h.segments.reduce((acc, s) => acc + (s.end_sec - s.start_sec), 0),
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

function buildSelectExpr(segments: HighlightSegment[]): string {
  return segments.map((s) => `between(t,${s.start_sec},${s.end_sec})`).join('+');
}

function buildVfChain(segments: HighlightSegment[], cropClause: string): string {
  return `select='${buildSelectExpr(segments)}',setpts=N/FRAME_RATE/TB,${cropClause},scale=1080:1920`;
}

function buildAfChain(segments: HighlightSegment[]): string {
  return `aselect='${buildSelectExpr(segments)}',asetpts=N/SR/TB`;
}

function buildCenterArgs(sourcePath: string, segments: HighlightSegment[], outputPath: string): string[] {
  return [
    '-y',
    '-i',
    sourcePath,
    '-vf',
    buildVfChain(segments, 'crop=ih*9/16:ih'),
    '-af',
    buildAfChain(segments),
    ...COMMON_ENCODE_ARGS,
    outputPath,
  ];
}

function buildTrackedArgs(
  sourcePath: string,
  segments: HighlightSegment[],
  outputPath: string,
  cmdPath: string,
): string[] {
  const cropClause = `sendcmd=f=${cmdPath},crop@c=ih*9/16:ih:0:0`;
  return [
    '-y',
    '-i',
    sourcePath,
    '-vf',
    buildVfChain(segments, cropClause),
    '-af',
    buildAfChain(segments),
    ...COMMON_ENCODE_ARGS,
    outputPath,
  ];
}

function appendSubtitleFilter(args: readonly string[], assPath: string): string[] {
  const out = [...args];
  const vfIndex = out.indexOf('-vf');
  if (vfIndex === -1) return out;
  // Single-quote the path so ffmpeg's filter parser tolerates spaces.
  out[vfIndex + 1] = `${out[vfIndex + 1]},subtitles=filename='${assPath}'`;
  return out;
}
