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

export interface DownloadHandle {
  onProgress(callback: (p: DownloadProgress) => void): void;
  cancel(): void;
  done: Promise<void>;
}

const PROGRESS_TEMPLATE =
  'progress: %(progress._percent_str)s|%(progress._eta_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s';
const PROGRESS_LINE = /^progress:\s*([\d.]+)%\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*$/;

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

  download(url: string, outputPath: string, opts: DownloadOptions): DownloadHandle {
    if (!isYoutubeUrl(url)) {
      throw new Error(`URL is not a recognized YouTube link: ${url}`);
    }
    const args = [
      url,
      '--output',
      outputPath,
      '--format',
      'bv*+ba/b',
      '--no-playlist',
      '--newline',
      `--progress-template=${PROGRESS_TEMPLATE}`,
    ];
    const child = this.deps.spawn(this.deps.binaryPath ?? 'yt-dlp', args, {});

    const progressCallbacks: ((p: DownloadProgress) => void)[] = [];
    let stderrBuffer = '';
    let canceled = false;

    child.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
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

    const done = new Promise<void>((resolve, reject) => {
      child.on('exit', (code: number | null) => {
        // Defer one tick so any buffered stderr data events can fire before we
        // read stderrBuffer (Node.js Readable emits 'data' via process.nextTick).
        setImmediate(() => {
          if (canceled) {
            reject(new Error('Download canceled'));
            return;
          }
          if (code === 0) {
            resolve();
            return;
          }
          const msg = stderrBuffer.trim() || `yt-dlp exited with code ${code}`;
          reject(new Error(msg));
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
