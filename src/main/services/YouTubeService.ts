import { type VideoMeta, VideoMetaSchema, isYoutubeUrl } from '@shared/youtube';
import type { DownloadProgress } from '@shared/youtube';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export type YoutubeDlLike = (url: string, flags: Record<string, unknown>) => Promise<unknown>;

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) => ChildProcessWithoutNullStreams;

export interface YouTubeServiceDeps {
  youtubeDl: YoutubeDlLike;
  spawn: SpawnLike;
  /** Absolute path to the yt-dlp binary. Defaults to `'yt-dlp'` (PATH lookup). */
  binaryPath?: string;
}

export interface DownloadOptions {
  videoId: string;
}

export interface DownloadResult {
  /** Final absolute path of the downloaded file (extension chosen by yt-dlp). */
  outputPath: string;
}

export interface DownloadHandle {
  onProgress(callback: (p: DownloadProgress) => void): void;
  cancel(): void;
  done: Promise<DownloadResult>;
}

const PROGRESS_TEMPLATE =
  'progress: %(progress._percent_str)s|%(progress._eta_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s';
const PROGRESS_LINE = /^progress:\s*([\d.]+)%\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*$/;

const OUTFILE_PREFIX = 'OUTFILE:';
/** yt-dlp's `after_move` hook fires after any merge/remux with the final filepath. */
const PRINT_TEMPLATE = `after_move:${OUTFILE_PREFIX}%(filepath)s`;
/**
 * Best video + best audio. We deliberately don't pin the container to mp4 —
 * YouTube increasingly serves AV1/VP9 in webm or mp4, and forcing mp4 either
 * triggers a remux (slow, lossy) or produces "mp4 wrapper, AV1 codec inside"
 * which fails on QuickTime. Letting yt-dlp pick the native format means the
 * file extension always matches the actual codec/container.
 */
const FORMAT_SELECTOR = 'bv*+ba/b';

export class YouTubeService {
  constructor(private readonly deps: YouTubeServiceDeps) {}

  async fetchMeta(url: string): Promise<VideoMeta> {
    if (!isYoutubeUrl(url)) {
      throw new Error(`URL is not a recognized YouTube link: ${url}`);
    }
    const raw = await this.deps.youtubeDl(url, {
      dumpSingleJson: true,
      skipDownload: true,
      noWarnings: true,
    });
    return VideoMetaSchema.parse({
      id: (raw as { id?: unknown }).id,
      title: (raw as { title?: unknown }).title,
      channel: (raw as { channel?: unknown }).channel,
      durationSec: (raw as { duration?: unknown }).duration,
      thumbnailUrl: (raw as { thumbnail?: unknown }).thumbnail,
      webpageUrl: (raw as { webpage_url?: unknown }).webpage_url,
    });
  }

  /**
   * Starts a download. `outputStem` is the path WITHOUT extension —
   * yt-dlp picks the actual extension via the `%(ext)s` template, then
   * `done` resolves with the actual final path captured from yt-dlp's
   * `after_move` print hook.
   */
  download(url: string, outputStem: string, opts: DownloadOptions): DownloadHandle {
    if (!isYoutubeUrl(url)) {
      throw new Error(`URL is not a recognized YouTube link: ${url}`);
    }
    const args = [
      url,
      '--output',
      `${outputStem}.%(ext)s`,
      '--format',
      FORMAT_SELECTOR,
      '--no-playlist',
      '--newline',
      `--progress-template=${PROGRESS_TEMPLATE}`,
      '--print',
      PRINT_TEMPLATE,
    ];
    const child = this.deps.spawn(this.deps.binaryPath ?? 'yt-dlp', args, {});

    const progressCallbacks: ((p: DownloadProgress) => void)[] = [];
    let stderrBuffer = '';
    let capturedPath: string | null = null;
    let canceled = false;

    child.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith(OUTFILE_PREFIX)) {
          capturedPath = line.slice(OUTFILE_PREFIX.length).trim();
          continue;
        }
        const m = PROGRESS_LINE.exec(line);
        if (!m) continue;
        const [, pctStr, etaStr, downStr, totStr] = m;
        const progress: DownloadProgress = {
          videoId: opts.videoId,
          percent: Number.parseFloat(pctStr ?? '0'),
          etaSec: parseEtaSeconds(etaStr ?? ''),
          downloadedBytes: parseByteSize(downStr ?? ''),
          totalBytes: parseByteSize(totStr ?? ''),
        };
        for (const cb of progressCallbacks) cb(progress);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    const done = new Promise<DownloadResult>((resolve, reject) => {
      child.on('exit', (code: number | null) => {
        // Defer one tick so any buffered stdout/stderr data events can fire
        // before we read the captured state (Node Readables emit 'data' via
        // process.nextTick, which can post-date a synchronous 'exit').
        setImmediate(() => {
          if (canceled) {
            reject(new Error('Download canceled'));
            return;
          }
          if (code !== 0) {
            const msg = stderrBuffer.trim() || `yt-dlp exited with code ${code}`;
            reject(new Error(msg));
            return;
          }
          if (!capturedPath) {
            reject(
              new Error(
                "yt-dlp exited 0 but did not print an 'after_move' filepath; cannot determine the final output location",
              ),
            );
            return;
          }
          resolve({ outputPath: capturedPath });
        });
      });
      child.on('error', (err: Error) => reject(err));
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

function parseEtaSeconds(eta: string): number | null {
  const trimmed = eta.trim();
  if (!trimmed || trimmed === 'NA' || trimmed === '--:--') return null;
  const parts = trimmed.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function parseByteSize(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed || trimmed === 'NA') return null;
  const m = /^([\d.]+)\s*([KMGT]?)i?B$/i.exec(trimmed);
  if (!m) return null;
  const n = Number.parseFloat(m[1] ?? '0');
  const unit = (m[2] ?? '').toUpperCase();
  const mult = unit === 'K' ? 1024 : unit === 'M' ? 1024 ** 2 : unit === 'G' ? 1024 ** 3 : unit === 'T' ? 1024 ** 4 : 1;
  return Math.round(n * mult);
}
