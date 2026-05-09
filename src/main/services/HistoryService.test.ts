import type { Highlight, HighlightSet } from '@shared/highlight';
import type { RenderResult } from '@shared/render';
import type { VideoMeta } from '@shared/youtube';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HistoryService } from './HistoryService';

function fakeMeta(overrides: Partial<VideoMeta> = {}): VideoMeta {
  return {
    id: 'abc',
    title: 'My Talk',
    channel: 'Bob Park',
    durationSec: 600,
    thumbnailUrl: 'https://i.ytimg.com/vi/abc/maxresdefault.jpg',
    webpageUrl: 'https://youtu.be/abc',
    ...overrides,
  };
}

function fakeHighlight(start: number, end: number, title: string, hook = 'h'): Highlight {
  return { start_sec: start, end_sec: end, title, hook };
}

function fakeHighlightSet(highlights: Highlight[]): HighlightSet {
  return {
    generatedAt: '2026-05-10T00:00:00Z',
    model: 'anthropic/claude-sonnet-4.5',
    audioPath: '/tmp/My Talk.webm',
    highlights,
  };
}

function fakeRenderResult(
  specs: { idx: number; status: 'done' | 'failed' | 'canceled'; outputPath?: string }[],
): RenderResult {
  return {
    outputDir: '/tmp/out/My Talk',
    results: specs.map((s) => ({
      index: s.idx,
      title: `Short ${s.idx}`,
      startSec: 0,
      endSec: 30,
      status: s.status,
      outputPath: s.outputPath,
      error: s.status === 'failed' ? 'oops' : undefined,
      tracking: null,
      subtitles: null,
    })),
  };
}

describe('HistoryService', () => {
  let repo: { insertJob: ReturnType<typeof vi.fn>; insertShorts: ReturnType<typeof vi.fn> };
  let thumbs: { extractMidpoint: ReturnType<typeof vi.fn> };
  let mkdir: ReturnType<typeof vi.fn>;
  let service: HistoryService;

  beforeEach(() => {
    repo = { insertJob: vi.fn(), insertShorts: vi.fn() };
    thumbs = { extractMidpoint: vi.fn(async (_v: string, out: string) => out) };
    mkdir = vi.fn(async () => undefined);
    service = new HistoryService({
      repo: repo as never,
      thumbs: thumbs as never,
      thumbsDir: '/data/thumbs',
      fs: { mkdir } as never,
      now: () => 5000,
      idGen: (() => {
        let n = 0;
        return () => `id${++n}`;
      })(),
    });
  });

  it('records a job + shorts when render had at least one done clip', async () => {
    await service.recordJob({
      meta: fakeMeta(),
      sourcePath: '/tmp/My Talk.webm',
      highlightSet: fakeHighlightSet([fakeHighlight(0, 30, 'Opener'), fakeHighlight(60, 90, 'Mid')]),
      renderResult: fakeRenderResult([
        { idx: 1, status: 'done', outputPath: '/tmp/out/My Talk/short_1.mp4' },
        { idx: 2, status: 'done', outputPath: '/tmp/out/My Talk/short_2.mp4' },
      ]),
      whisperModel: 'small',
    });

    expect(repo.insertJob).toHaveBeenCalledTimes(1);
    const job = repo.insertJob.mock.calls[0]![0];
    expect(job.id).toBe('id1');
    expect(job.title).toBe('My Talk');
    expect(job.channel).toBe('Bob Park');
    expect(job.url).toBe('https://youtu.be/abc');
    expect(job.videoId).toBe('abc');
    expect(job.status).toBe('done');
    expect(job.llmModel).toBe('anthropic/claude-sonnet-4.5');
    expect(job.whisperModel).toBe('small');
    expect(job.createdAt).toBe(5000);
    expect(job.finishedAt).toBe(5000);

    expect(repo.insertShorts).toHaveBeenCalledTimes(1);
    const shorts = repo.insertShorts.mock.calls[0]![0];
    expect(shorts).toHaveLength(2);
    expect(shorts[0].idx).toBe(1);
    expect(shorts[0].outputPath).toBe('/tmp/out/My Talk/short_1.mp4');
    expect(shorts[0].thumbPath).toBe('/data/thumbs/id2.png'); // id1 = job, id2/id3 = shorts
    expect(shorts[1].thumbPath).toBe('/data/thumbs/id3.png');
  });

  it('marks job as partial_done when some clips failed', async () => {
    await service.recordJob({
      meta: fakeMeta(),
      sourcePath: '/tmp/in.mp4',
      highlightSet: fakeHighlightSet([fakeHighlight(0, 30, 'A')]),
      renderResult: fakeRenderResult([
        { idx: 1, status: 'done', outputPath: '/tmp/out/short_1.mp4' },
        { idx: 2, status: 'failed' },
      ]),
      whisperModel: 'small',
    });
    expect(repo.insertJob.mock.calls[0]![0].status).toBe('partial_done');
  });

  it('marks job as failed when no clip succeeded', async () => {
    await service.recordJob({
      meta: fakeMeta(),
      sourcePath: '/tmp/in.mp4',
      highlightSet: fakeHighlightSet([fakeHighlight(0, 30, 'A')]),
      renderResult: fakeRenderResult([{ idx: 1, status: 'failed' }]),
      whisperModel: 'small',
    });
    expect(repo.insertJob.mock.calls[0]![0].status).toBe('failed');
  });

  it('marks job as canceled when all results are canceled', async () => {
    await service.recordJob({
      meta: fakeMeta(),
      sourcePath: '/tmp/in.mp4',
      highlightSet: fakeHighlightSet([fakeHighlight(0, 30, 'A')]),
      renderResult: fakeRenderResult([{ idx: 1, status: 'canceled' }]),
      whisperModel: 'small',
    });
    expect(repo.insertJob.mock.calls[0]![0].status).toBe('canceled');
  });

  it('skips thumbnail extraction (and stores null thumbPath) for non-done shorts', async () => {
    await service.recordJob({
      meta: fakeMeta(),
      sourcePath: '/tmp/in.mp4',
      highlightSet: fakeHighlightSet([fakeHighlight(0, 30, 'A'), fakeHighlight(60, 90, 'B')]),
      renderResult: fakeRenderResult([
        { idx: 1, status: 'done', outputPath: '/tmp/out/short_1.mp4' },
        { idx: 2, status: 'failed' },
      ]),
      whisperModel: 'small',
    });
    // Thumb only attempted for the 'done' clip
    expect(thumbs.extractMidpoint).toHaveBeenCalledTimes(1);
    const shorts = repo.insertShorts.mock.calls[0]![0];
    expect(shorts[1].thumbPath).toBeNull();
  });

  it('stores null thumbPath when the thumbnail extraction fails (non-fatal)', async () => {
    thumbs.extractMidpoint.mockResolvedValue(null);
    await service.recordJob({
      meta: fakeMeta(),
      sourcePath: '/tmp/in.mp4',
      highlightSet: fakeHighlightSet([fakeHighlight(0, 30, 'A')]),
      renderResult: fakeRenderResult([{ idx: 1, status: 'done', outputPath: '/tmp/out/short_1.mp4' }]),
      whisperModel: 'small',
    });
    const shorts = repo.insertShorts.mock.calls[0]![0];
    expect(shorts[0].thumbPath).toBeNull();
  });

  it('mkdir -p the thumbsDir before extracting', async () => {
    await service.recordJob({
      meta: fakeMeta(),
      sourcePath: '/tmp/in.mp4',
      highlightSet: fakeHighlightSet([fakeHighlight(0, 30, 'A')]),
      renderResult: fakeRenderResult([{ idx: 1, status: 'done', outputPath: '/tmp/out/short_1.mp4' }]),
      whisperModel: 'small',
    });
    expect(mkdir).toHaveBeenCalledWith('/data/thumbs', { recursive: true });
  });
});
