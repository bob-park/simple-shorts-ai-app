import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import { Readable } from 'node:stream';
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

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  killed = false;
  kill(signal?: string): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', signal === 'SIGTERM' ? null : 0));
    return true;
  }
}

describe('YouTubeService.download', () => {
  let spawn: ReturnType<typeof vi.fn>;
  let service: YouTubeService;
  let child: FakeChild;

  beforeEach(() => {
    child = new FakeChild();
    spawn = vi.fn(() => child);
    service = new YouTubeService({
      youtubeDl: vi.fn() as never,
      spawn: spawn as never,
    });
  });

  it('spawns yt-dlp with the %(ext)s template, format selector, and after_move print hook', () => {
    service.download('https://youtu.be/abc', '/tmp/My Video', { videoId: 'abc' });
    expect(spawn).toHaveBeenCalledTimes(1);
    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--output');
    expect(args).toContain('/tmp/My Video.%(ext)s');
    // No --merge-output-format flag — the FORMAT_SELECTOR drives muxing
    // directly (avc1 + m4a → mp4). See YouTubeService.ts for details.
    expect(args).not.toContain('--merge-output-format');
    // `--print-to-file` (not `--print`) — see PRINT_TEMPLATE comment in
    // YouTubeService for why progress would otherwise be suppressed.
    expect(args).toContain('--print-to-file');
    const ptfIdx = args.indexOf('--print-to-file');
    expect(args[ptfIdx + 1]).toBe('after_move:%(filepath)s');
    // The third arg after --print-to-file is the temp file path yt-dlp writes to.
    expect(args[ptfIdx + 2]).toMatch(/shorts-ai-ytdlp-[0-9a-f]+\.txt$/);
    expect(args).toContain('--newline');
    expect(args.some((a) => a.startsWith('--progress-template'))).toBe(true);
  });

  it('pins format to h264 (avc1) + m4a in mp4 with sensible fallbacks', () => {
    service.download('https://youtu.be/abc', '/tmp/V', { videoId: 'abc' });
    const args = spawn.mock.calls[0]?.[1] as string[];
    const fmtIdx = args.indexOf('--format');
    expect(fmtIdx).toBeGreaterThanOrEqual(0);
    expect(args[fmtIdx + 1]).toBe('bv*[vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/b');
  });

  it('emits parsed progress events as yt-dlp writes lines', async () => {
    const handle = service.download('https://youtu.be/abc', '/tmp/abc', {
      videoId: 'abc',
    });
    const events: number[] = [];
    handle.onProgress((p) => events.push(p.percent));

    child.stdout.push('progress: 12.3%|0:42|1.0MiB|10.0MiB\n');
    child.stdout.push('progress: 50.0%|0:20|5.0MiB|10.0MiB\n');
    child.stdout.push('progress: 100.0%|0:00|10.0MiB|10.0MiB\n');
    await new Promise((r) => setTimeout(r, 0));

    expect(events).toEqual([12.3, 50.0, 100.0]);
  });

  it('resolves done with the captured outputPath on exit code 0', async () => {
    const handle = service.download('https://youtu.be/abc', '/tmp/My Video', {
      videoId: 'abc',
    });
    // Service writes its --print-to-file path into spawn args; simulate yt-dlp
    // by writing the after_move path into that file before exit.
    const args = spawn.mock.calls[0]?.[1] as string[];
    const printOutPath = args[args.indexOf('--print-to-file') + 2]!;
    await fsp.writeFile(printOutPath, '/tmp/My Video.mp4\n', 'utf8');
    child.emit('exit', 0);
    await expect(handle.done).resolves.toEqual({ outputPath: '/tmp/My Video.mp4' });
  });

  it('rejects done with a clear error when exit 0 but no after_move filepath was emitted', async () => {
    const handle = service.download('https://youtu.be/abc', '/tmp/abc', {
      videoId: 'abc',
    });
    // No file written → service can't determine final output location.
    child.emit('exit', 0);
    await expect(handle.done).rejects.toThrow(/after_move/i);
  });

  it('rejects done with a descriptive error on non-zero exit', async () => {
    const handle = service.download('https://youtu.be/abc', '/tmp/abc', {
      videoId: 'abc',
    });
    child.stderr.push('ERROR: Video unavailable\n');
    child.emit('exit', 1);
    await expect(handle.done).rejects.toThrow(/Video unavailable|exit code 1/);
  });

  it('cancel() sends SIGTERM and rejects done as canceled', async () => {
    const handle = service.download('https://youtu.be/abc', '/tmp/abc', {
      videoId: 'abc',
    });
    handle.cancel();
    await expect(handle.done).rejects.toThrow(/canceled/i);
    expect(child.killed).toBe(true);
  });
});
