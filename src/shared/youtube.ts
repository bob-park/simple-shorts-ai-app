import { z } from 'zod';

export const YOUTUBE_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
] as const;

export const VideoMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  channel: z.string().min(1),
  /** Duration in seconds. yt-dlp reports `duration` as a number. */
  durationSec: z.number().nonnegative(),
  thumbnailUrl: z.string().url(),
  webpageUrl: z.string().url(),
});
export type VideoMeta = z.infer<typeof VideoMetaSchema>;

export const DownloadProgressSchema = z.object({
  videoId: z.string().min(1),
  /** 0..100 */
  percent: z.number().min(0).max(100),
  /** Seconds remaining, or null if yt-dlp doesn't know yet. */
  etaSec: z.number().nonnegative().nullable(),
  downloadedBytes: z.number().nonnegative().nullable(),
  totalBytes: z.number().nonnegative().nullable(),
});
export type DownloadProgress = z.infer<typeof DownloadProgressSchema>;

export type DownloadStatus = 'idle' | 'starting' | 'downloading' | 'done' | 'canceled' | 'error';

/** True iff input is a syntactically valid YouTube URL on a known host. */
export function isYoutubeUrl(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return (YOUTUBE_HOSTS as readonly string[]).includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Extracts the video id from a YouTube URL. Supports `?v=` query param,
 * `youtu.be/<id>` short links, and `/shorts/<id>` URLs. Returns null on
 * unrecognized shapes.
 */
export function extractVideoId(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.replace(/^\/+/, '').split('/')[0];
      return id || null;
    }
    if ((YOUTUBE_HOSTS as readonly string[]).includes(url.hostname)) {
      const v = url.searchParams.get('v');
      if (v) return v;
      const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)/);
      if (shortsMatch) return shortsMatch[1] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}
