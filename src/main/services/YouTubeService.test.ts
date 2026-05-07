import { beforeEach, describe, expect, it, vi } from 'vitest';

import { YouTubeService } from './YouTubeService';

describe('YouTubeService.fetchMeta', () => {
  let youtubeDl: ReturnType<typeof vi.fn>;
  let service: YouTubeService;

  beforeEach(() => {
    youtubeDl = vi.fn();
    service = new YouTubeService({
      youtubeDl: youtubeDl as never,
      spawn: vi.fn() as never,
    });
  });

  it('calls yt-dlp with metadata-only flags and returns a parsed VideoMeta', async () => {
    youtubeDl.mockResolvedValue({
      id: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      channel: 'Rick Astley',
      duration: 213,
      thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });

    const meta = await service.fetchMeta('https://youtu.be/dQw4w9WgXcQ');

    expect(youtubeDl).toHaveBeenCalledWith(
      'https://youtu.be/dQw4w9WgXcQ',
      expect.objectContaining({
        dumpSingleJson: true,
        skipDownload: true,
        noWarnings: true,
      }),
    );
    expect(meta).toEqual({
      id: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      channel: 'Rick Astley',
      durationSec: 213,
      thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      webpageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
  });

  it('rejects non-YouTube URLs before calling yt-dlp', async () => {
    await expect(service.fetchMeta('https://vimeo.com/123')).rejects.toThrow(/not a recognized YouTube/i);
    expect(youtubeDl).not.toHaveBeenCalled();
  });

  it('throws a descriptive error if yt-dlp returns malformed data', async () => {
    youtubeDl.mockResolvedValue({ id: 'x' }); // missing title, channel, etc.
    await expect(service.fetchMeta('https://youtu.be/x')).rejects.toThrow();
  });

  it('passes through yt-dlp execution errors', async () => {
    youtubeDl.mockRejectedValue(new Error('Video unavailable'));
    await expect(service.fetchMeta('https://youtu.be/x')).rejects.toThrow(/Video unavailable/);
  });
});
