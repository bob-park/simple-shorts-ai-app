import { type VideoMeta, VideoMetaSchema, isYoutubeUrl } from '@shared/youtube';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** Minimal surface of `youtube-dl-exec` we depend on for metadata calls. */
export type YoutubeDlLike = (url: string, flags: Record<string, unknown>) => Promise<unknown>;

/** Minimal surface of `node:child_process.spawn` we depend on for downloads. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) => ChildProcessWithoutNullStreams;

export interface YouTubeServiceDeps {
  youtubeDl: YoutubeDlLike;
  spawn: SpawnLike;
}

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
}
