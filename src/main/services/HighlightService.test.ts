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

describe('HighlightService (segment-based)', () => {
  let chatJson: ReturnType<typeof vi.fn>;
  let client: { chatJson: typeof chatJson };
  let service: HighlightService;

  beforeEach(() => {
    chatJson = vi.fn();
    client = { chatJson };
    service = new HighlightService(client as never);
  });

  it('makes one LLM call for short transcripts and maps segment indices to time ranges', async () => {
    chatJson.mockResolvedValue({
      highlights: [
        { segment_indices: [0, 1], title: 'Opener', hook: 'It starts strong' },
        { segment_indices: [3, 4, 5], title: 'Mid', hook: 'Big reveal' },
      ],
    });
    const result = await service.extract({
      transcript: makeTranscript(50),
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 2,
      minSec: 5,
      maxSec: 60,
    });
    expect(chatJson).toHaveBeenCalledTimes(1);
    expect(result.highlights).toHaveLength(2);
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

  it('dedupes duplicate indices in the same highlight', async () => {
    chatJson.mockResolvedValue({
      highlights: [{ segment_indices: [0, 1, 1, 0], title: 'A', hook: 'h' }],
    });
    const result = await service.extract({
      transcript: makeTranscript(10),
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 1,
      minSec: 5,
      maxSec: 60,
    });
    expect(result.highlights[0]!.segments).toHaveLength(2);
  });

  it('sorts segments chronologically regardless of LLM output order', async () => {
    chatJson.mockResolvedValue({
      highlights: [{ segment_indices: [5, 0, 3], title: 'A', hook: 'h' }],
    });
    const result = await service.extract({
      transcript: makeTranscript(10),
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 1,
      minSec: 5,
      maxSec: 60,
    });
    expect(result.highlights[0]!.segments.map((s) => s.start_sec)).toEqual([0, 15, 25]);
  });

  it('drops highlights with out-of-bounds segment indices', async () => {
    chatJson.mockResolvedValue({
      highlights: [
        { segment_indices: [0, 1], title: 'Valid', hook: 'h' },
        { segment_indices: [99, 100], title: 'Invalid', hook: 'h' },
      ],
    });
    const result = await service.extract({
      transcript: makeTranscript(10),
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 5,
      minSec: 5,
      maxSec: 60,
    });
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0]!.title).toBe('Valid');
  });

  it('drops highlights whose total duration falls outside [minSec, maxSec]', async () => {
    chatJson.mockResolvedValue({
      highlights: [
        // 1 segment × 5s = 5s — too short for minSec=20
        { segment_indices: [0], title: 'TooShort', hook: 'h' },
        // 5 segments × 5s = 25s — within [20, 60]
        { segment_indices: [0, 1, 2, 3, 4], title: 'Good', hook: 'h' },
        // 14 segments × 5s = 70s — exceeds maxSec=60
        { segment_indices: Array.from({ length: 14 }, (_, i) => i), title: 'TooLong', hook: 'h' },
      ],
    });
    const result = await service.extract({
      transcript: makeTranscript(20),
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 5,
      minSec: 20,
      maxSec: 60,
    });
    expect(result.highlights.map((h) => h.title)).toEqual(['Good']);
  });

  it('rebases chunk-local indices to global when running multi-chunk + rerank', async () => {
    // 200 segments → 2 chunks (chunkSize=100, overlap=10 → step=90)
    //   chunk 0: indices 0..99    (firstIndex=0)
    //   chunk 1: indices 90..189  (firstIndex=90)
    //   chunk 2: indices 180..199 (firstIndex=180)
    chatJson
      .mockResolvedValueOnce({
        // chunk 0 returns local index 5 → global 5
        highlights: [{ segment_indices: [5, 6], title: 'C0', hook: 'h' }],
      })
      .mockResolvedValueOnce({
        // chunk 1 returns local index 0 → global 90
        highlights: [{ segment_indices: [0, 1], title: 'C1', hook: 'h' }],
      })
      .mockResolvedValueOnce({
        // chunk 2 returns local index 5 → global 185
        highlights: [{ segment_indices: [5, 6], title: 'C2', hook: 'h' }],
      })
      .mockResolvedValueOnce({
        // rerank: pick the one spanning global 90..91
        highlights: [{ segment_indices: [90, 91], title: 'C1', hook: 'h' }],
      });
    const result = await service.extract({
      transcript: makeTranscript(200),
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 1,
      minSec: 5,
      maxSec: 60,
    });
    expect(chatJson).toHaveBeenCalledTimes(4); // 3 chunks + 1 rerank
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0]!.segments).toEqual([
      { start_sec: 450, end_sec: 455 }, // segment 90
      { start_sec: 455, end_sec: 460 }, // segment 91
    ]);
  });

  it('throws a step-tagged error when chunk LLM response is missing the highlights key', async () => {
    chatJson.mockResolvedValueOnce({ candidates: [] });
    await expect(
      service.extract({
        transcript: makeTranscript(50),
        audioPath: '/x.mp4',
        apiKey: 'k',
        model: 'm',
        count: 1,
        minSec: 5,
        maxSec: 60,
      }),
    ).rejects.toThrow(/invalid response shape on chunk 1\/1/i);
  });

  it('throws a step-tagged error when rerank LLM response is missing the highlights key', async () => {
    // 200 segments → 3 chunks → rerank.
    chatJson
      .mockResolvedValueOnce({ highlights: [{ segment_indices: [0, 1], title: 'C0', hook: 'h' }] })
      .mockResolvedValueOnce({ highlights: [{ segment_indices: [0, 1], title: 'C1', hook: 'h' }] })
      .mockResolvedValueOnce({ highlights: [{ segment_indices: [0, 1], title: 'C2', hook: 'h' }] })
      // rerank: model echoes input shape with `candidates` instead of `highlights`
      .mockResolvedValueOnce({ candidates: [{ segment_indices: [0, 1], title: 'X', hook: 'h' }] });
    await expect(
      service.extract({
        transcript: makeTranscript(200),
        audioPath: '/x.mp4',
        apiKey: 'k',
        model: 'm',
        count: 1,
        minSec: 5,
        maxSec: 60,
      }),
    ).rejects.toThrow(/invalid response shape on rerank step/i);
  });

  it('throws MissingApiKeyError when apiKey is empty', async () => {
    await expect(
      service.extract({
        transcript: makeTranscript(10),
        audioPath: '/x.mp4',
        apiKey: '',
        model: 'm',
        count: 1,
        minSec: 5,
        maxSec: 60,
      }),
    ).rejects.toThrow(/OpenRouter API key is not set/i);
    expect(chatJson).not.toHaveBeenCalled();
  });
});
