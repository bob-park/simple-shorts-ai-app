import type { HighlightSet } from '@shared/highlight';
import type { Job, JobStatus, Short } from '@shared/history';
import type { RenderResult } from '@shared/render';
import type { VideoMeta } from '@shared/youtube';
import { randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';

interface RepoLike {
  insertJob(job: Job): void;
  insertShorts(shorts: Short[]): void;
}

interface ThumbsLike {
  extractMidpoint(
    videoPath: string,
    outPath: string,
    opts: { startSec: number; endSec: number },
  ): Promise<string | null>;
}

type FsLike = Pick<typeof fsPromises, 'mkdir'>;

export interface HistoryServiceOptions {
  repo: RepoLike;
  thumbs: ThumbsLike;
  /** Directory where per-short PNG thumbs are written. */
  thumbsDir: string;
  /** Injected for tests. Defaults to real fs.promises. */
  fs?: FsLike;
  /** Injected for tests. Defaults to Date.now()/1000. */
  now?: () => number;
  /** Injected for tests. Defaults to crypto.randomUUID. */
  idGen?: () => string;
}

export interface RecordJobInput {
  meta: VideoMeta;
  sourcePath: string;
  highlightSet: HighlightSet;
  renderResult: RenderResult;
  whisperModel: string;
}

/**
 * Single entry point for persisting a finished render to history. Generates
 * per-short thumbnails, then writes the job + shorts rows in a transaction.
 */
export class HistoryService {
  private readonly repo: RepoLike;
  private readonly thumbs: ThumbsLike;
  private readonly thumbsDir: string;
  private readonly fs: FsLike;
  private readonly now: () => number;
  private readonly idGen: () => string;

  constructor(opts: HistoryServiceOptions) {
    this.repo = opts.repo;
    this.thumbs = opts.thumbs;
    this.thumbsDir = opts.thumbsDir;
    this.fs = opts.fs ?? fsPromises;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.idGen = opts.idGen ?? randomUUID;
  }

  async recordJob(input: RecordJobInput): Promise<string> {
    await this.fs.mkdir(this.thumbsDir, { recursive: true });
    const jobId = this.idGen();
    const ts = this.now();
    const status = computeJobStatus(input.renderResult);

    const job: Job = {
      id: jobId,
      url: input.meta.webpageUrl,
      videoId: input.meta.id,
      title: input.meta.title,
      channel: input.meta.channel ?? null,
      durationSec: Math.round(input.meta.durationSec),
      sourcePath: input.sourcePath,
      sourceThumb: input.meta.thumbnailUrl ?? null,
      status,
      errorMessage: null,
      optionsJson: JSON.stringify({
        highlightModel: input.highlightSet.model,
        highlightCount: input.highlightSet.highlights.length,
      }),
      llmModel: input.highlightSet.model,
      whisperModel: input.whisperModel,
      createdAt: ts,
      finishedAt: ts,
    };

    const shorts: Short[] = [];
    for (const r of input.renderResult.results) {
      const shortId = this.idGen();
      let thumbPath: string | null = null;
      if (r.status === 'done' && r.outputPath) {
        const candidate = join(this.thumbsDir, `${shortId}.png`);
        thumbPath = await this.thumbs.extractMidpoint(r.outputPath, candidate, {
          startSec: 0,
          endSec: r.montageDurationSec,
        });
      }
      shorts.push({
        id: shortId,
        jobId,
        idx: r.index,
        title: r.title,
        hook: input.highlightSet.highlights[r.index - 1]?.hook ?? null,
        startSec: r.startSec,
        endSec: r.endSec,
        outputPath: r.outputPath ?? '',
        thumbPath,
        width: r.outputPath ? 1080 : null,
        height: r.outputPath ? 1920 : null,
        sizeBytes: null,
      });
    }

    this.repo.insertJob(job);
    this.repo.insertShorts(shorts);
    return jobId;
  }
}

function computeJobStatus(result: RenderResult): JobStatus {
  const counts = { done: 0, failed: 0, canceled: 0 };
  for (const r of result.results) counts[r.status as keyof typeof counts]++;
  if (counts.done === result.results.length) return 'done';
  if (counts.canceled === result.results.length) return 'canceled';
  if (counts.done === 0) return 'failed';
  return 'partial_done';
}
