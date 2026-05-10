import type { Segment, Transcript } from '@shared/transcript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HighlightService } from './HighlightService';

function fakeSegments(count: number, durationEach = 5): Segment[] {
  return Array.from({ length: count }, (_, i) => ({
    start: i * durationEach,
    end: (i + 1) * durationEach,
    text: `segment ${i}`,
  }));
}

function makeTranscript(segmentCount: number, durationEach = 5): Transcript {
  const segments = fakeSegments(segmentCount, durationEach);
  return {
    duration: segmentCount * durationEach,
    language: 'en',
    segments,
    words: [],
  };
}

describe('HighlightService (segment-based, local LLM client)', () => {
  let chat: ReturnType<typeof vi.fn>;
  let client: { chat: typeof chat };
  let service: HighlightService;

  beforeEach(() => {
    chat = vi.fn();
    client = { chat };
    service = new HighlightService(client as never);
  });

  it('makes one chat call for short transcripts and maps segment indices to time ranges', async () => {
    chat.mockResolvedValue({
      highlights: [
        { segment_indices: [0, 1], title: 'Opener', hook: 'It starts strong' },
        { segment_indices: [3, 4, 5], title: 'Mid', hook: 'Big reveal' },
      ],
    });
    const result = await service.extract({
      transcript: makeTranscript(50),
      audioPath: '/x.mp4',
      count: 2,
      minSec: 5,
      maxSec: 60,
    });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.highlights).toHaveLength(2);
    expect(result.model).toBe('gemma-4-e4b');
    expect(result.highlights[0]!.segments).toEqual([
      { start_sec: 0, end_sec: 5 },
      { start_sec: 5, end_sec: 10 },
    ]);
    expect(result.highlights[1]!.segments).toEqual([
      { start_sec: 15, end_sec: 20 },
      { start_sec: 20, end_sec: 25 },
      { start_sec: 25, end_sec: 30 },
    ]);
  });

  it('passes the correct schemaId per call (chunk vs rerank)', async () => {
    chat
      .mockResolvedValueOnce({ highlights: [{ segment_indices: [0, 1], title: 'C0', hook: 'h' }] })
      .mockResolvedValueOnce({ highlights: [{ segment_indices: [0, 1], title: 'C1', hook: 'h' }] })
      .mockResolvedValueOnce({ highlights: [{ segment_indices: [0, 1], title: 'C2', hook: 'h' }] })
      .mockResolvedValueOnce({ highlights: [{ segment_indices: [90, 91], title: 'X', hook: 'h' }] });
    await service.extract({
      transcript: makeTranscript(200),
      audioPath: '/x.mp4',
      count: 1,
      minSec: 5,
      maxSec: 60,
    });
    expect(chat).toHaveBeenCalledTimes(4);
    // First 3 are 'highlights' (per chunk); last is 'highlights_rerank'
    expect(chat.mock.calls[0]![0].schemaId).toBe('highlights');
    expect(chat.mock.calls[1]![0].schemaId).toBe('highlights');
    expect(chat.mock.calls[2]![0].schemaId).toBe('highlights');
    expect(chat.mock.calls[3]![0].schemaId).toBe('highlights_rerank');
  });

  it('dedupes duplicate indices in the same highlight', async () => {
    chat.mockResolvedValue({
      highlights: [{ segment_indices: [0, 1, 1, 0], title: 'A', hook: 'h' }],
    });
    const result = await service.extract({
      transcript: makeTranscript(10),
      audioPath: '/x.mp4',
      count: 1,
      minSec: 5,
      maxSec: 60,
    });
    expect(result.highlights[0]!.segments).toHaveLength(2);
  });

  it('sorts segments chronologically regardless of LLM output order', async () => {
    chat.mockResolvedValue({
      highlights: [{ segment_indices: [5, 0, 3], title: 'A', hook: 'h' }],
    });
    const result = await service.extract({
      transcript: makeTranscript(10),
      audioPath: '/x.mp4',
      count: 1,
      minSec: 5,
      maxSec: 60,
    });
    expect(result.highlights[0]!.segments.map((s) => s.start_sec)).toEqual([0, 15, 25]);
  });

  it('drops highlights with out-of-bounds segment indices', async () => {
    chat.mockResolvedValue({
      highlights: [
        { segment_indices: [0, 1], title: 'Valid', hook: 'h' },
        { segment_indices: [99, 100], title: 'Invalid', hook: 'h' },
      ],
    });
    const result = await service.extract({
      transcript: makeTranscript(10),
      audioPath: '/x.mp4',
      count: 5,
      minSec: 5,
      maxSec: 60,
    });
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0]!.title).toBe('Valid');
  });

  it('drops highlights whose total duration falls outside [minSec, maxSec]', async () => {
    chat.mockResolvedValue({
      highlights: [
        { segment_indices: [0], title: 'TooShort', hook: 'h' },
        { segment_indices: [0, 1, 2, 3, 4], title: 'Good', hook: 'h' },
        { segment_indices: Array.from({ length: 14 }, (_, i) => i), title: 'TooLong', hook: 'h' },
      ],
    });
    const result = await service.extract({
      transcript: makeTranscript(20),
      audioPath: '/x.mp4',
      count: 5,
      minSec: 20,
      maxSec: 60,
    });
    expect(result.highlights.map((h) => h.title)).toEqual(['Good']);
  });

  it('rebases chunk-local indices to global when running multi-chunk + rerank', async () => {
    chat
      .mockResolvedValueOnce({ highlights: [{ segment_indices: [5, 6], title: 'C0', hook: 'h' }] })
      .mockResolvedValueOnce({ highlights: [{ segment_indices: [0, 1], title: 'C1', hook: 'h' }] })
      .mockResolvedValueOnce({ highlights: [{ segment_indices: [5, 6], title: 'C2', hook: 'h' }] })
      .mockResolvedValueOnce({ highlights: [{ segment_indices: [90, 91], title: 'C1', hook: 'h' }] });
    const result = await service.extract({
      transcript: makeTranscript(200),
      audioPath: '/x.mp4',
      count: 1,
      minSec: 5,
      maxSec: 60,
    });
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0]!.segments).toEqual([
      { start_sec: 450, end_sec: 455 },
      { start_sec: 455, end_sec: 460 },
    ]);
  });

  it('throws step-tagged error when chunk LLM response shape is invalid', async () => {
    chat.mockResolvedValueOnce({ candidates: [] }); // wrong key
    await expect(
      service.extract({
        transcript: makeTranscript(50),
        audioPath: '/x.mp4',
        count: 1,
        minSec: 5,
        maxSec: 60,
      }),
    ).rejects.toThrow(/invalid response shape on chunk 1\/1/i);
  });

  it('throws step-tagged error when rerank response shape is invalid', async () => {
    chat
      .mockResolvedValueOnce({ highlights: [{ segment_indices: [0, 1], title: 'C0', hook: 'h' }] })
      .mockResolvedValueOnce({ highlights: [{ segment_indices: [0, 1], title: 'C1', hook: 'h' }] })
      .mockResolvedValueOnce({ highlights: [{ segment_indices: [0, 1], title: 'C2', hook: 'h' }] })
      .mockResolvedValueOnce({ candidates: [{ segment_indices: [0, 1], title: 'X', hook: 'h' }] });
    await expect(
      service.extract({
        transcript: makeTranscript(200),
        audioPath: '/x.mp4',
        count: 1,
        minSec: 5,
        maxSec: 60,
      }),
    ).rejects.toThrow(/invalid response shape on rerank step/i);
  });
});
