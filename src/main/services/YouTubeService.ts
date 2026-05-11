import { type VideoMeta, VideoMetaSchema, isYoutubeUrl } from '@shared/youtube';
import type { DownloadProgress } from '@shared/youtube';
import { randomBytes } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  /**
   * Absolute path to ffmpeg, passed to yt-dlp via `--ffmpeg-location`. Without
   * this, yt-dlp downloads video and audio streams but can't merge them, so
   * the user ends up with `<title>.f<id>.mp4` instead of the merged file.
   */
  ffmpegLocation?: string;
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

/**
 * yt-dlp's `after_move` hook fires after any merge/remux with the final
 * filepath. We route it through `--print-to-file` to a temp file rather
 * than `--print` because in yt-dlp 2026+, `--print` paired with
 * `--progress-template` suppresses progress output entirely — we'd lose
 * the % bar in the UI.
 */
const PRINT_TEMPLATE = `after_move:%(filepath)s`;
/**
 * Pin to h264 (avc1) video + AAC (m4a) audio. yt-dlp merges this codec
 * pair to mp4 natively, which yields three wins on Apple Silicon:
 *
 * - macOS VideoToolbox hardware-decodes h264. VP9/AV1 (the typical webm
 *   payload) have no VT decoder, so every downstream ffmpeg/cv2 pass is
 *   software-decoded — much slower on the M-series chips we ship to.
 * - The codec is constrained to avc1, so we don't risk the "AV1 inside
 *   mp4 wrapper" QuickTime hazard that motivated the previous unpinned
 *   selector.
 * - File extension on disk is always .mp4, which matches downstream
 *   tooling expectations.
 *
 * Fallback chain (yt-dlp evaluates left to right):
 *   1. bv*[vcodec^=avc1]+ba[ext=m4a]  — adaptive avc1 video + m4a audio
 *   2. b[ext=mp4]                     — pre-merged single mp4 stream
 *   3. b                              — best of anything (rare videos
 *      with only VP9/AV1 fall back to the prior behavior here)
 *
 * Trade-off: YouTube caps avc1 at 1080p, so a 4K source downgrades to
 * 1080p. The pipeline final output is 1080×1920 (9:16 short), so this
 * is invisible to end users.
 */
const FORMAT_SELECTOR = 'bv*[vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/b';

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
    const printOutPath = join(tmpdir(), `shorts-ai-ytdlp-${randomBytes(8).toString('hex')}.txt`);
    const args = [
      url,
      '--output',
      `${outputStem}.%(ext)s`,
      '--format',
      FORMAT_SELECTOR,
      '--no-playlist',
      '--newline',
      `--progress-template=${PROGRESS_TEMPLATE}`,
      '--print-to-file',
      PRINT_TEMPLATE,
      printOutPath,
    ];
    if (this.deps.ffmpegLocation) {
      args.push('--ffmpeg-location', this.deps.ffmpegLocation);
    }
    // PYTHONUTF8 forces yt-dlp's embedded Python to use UTF-8 for stdio +
    // open() defaults, regardless of the OS codepage. Critical on Windows so
    // the path written to --print-to-file (which we read back as UTF-8) is
    // actually UTF-8, not cp949/cp1252 with surrogateescape mojibake on
    // non-ASCII filenames.
    const child = this.deps.spawn(this.deps.binaryPath ?? 'yt-dlp', args, {
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });

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

    const done = new Promise<DownloadResult>((resolve, reject) => {
      child.on('exit', (code: number | null) => {
        // Defer one tick so any buffered stdout/stderr data events can fire
        // before we read the captured state (Node Readables emit 'data' via
        // process.nextTick, which can post-date a synchronous 'exit').
        setImmediate(async () => {
          // Read the after_move filepath that yt-dlp wrote to printOutPath.
          // The file may contain multiple lines if the hook fired more than
          // once (unusual); take the LAST non-empty one as the final location.
          let capturedPath: string | null = null;
          try {
            const raw = await fsp.readFile(printOutPath, 'utf8');
            const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
            capturedPath = lines.length > 0 ? lines[lines.length - 1]!.trim() : null;
          } catch {
            // File never created (yt-dlp failed before any after_move) — leave null.
          }
          // Best-effort cleanup; ignore failures.
          fsp.unlink(printOutPath).catch(() => undefined);

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
