import type { Transcript } from '@shared/transcript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HighlightService } from './HighlightService';

function makeTranscript(wordCount: number): Transcript {
  return {
    duration: wordCount * 0.4,
    language: 'en',
    segments: [],
    words: Array.from({ length: wordCount }, (_, i) => ({
      start: i * 0.4,
      end: (i + 1) * 0.4,
      text: `w${i}`,
    })),
  };
}

const validResponse = {
  highlights: [
    { start_sec: 0, end_sec: 30, title: 'Opener', hook: 'It starts strong' },
    { start_sec: 60, end_sec: 90, title: 'Middle', hook: 'Big reveal' },
  ],
};

describe('HighlightService', () => {
  let chatJson: ReturnType<typeof vi.fn>;
  let client: { chatJson: typeof chatJson };
  let service: HighlightService;

  beforeEach(() => {
    chatJson = vi.fn();
    client = { chatJson };
    service = new HighlightService(client as never);
  });

  it('makes one LLM call for short transcripts (no rerank)', async () => {
    chatJson.mockResolvedValue(validResponse);
    const transcript = makeTranscript(1500); // below threshold
    const result = await service.extract({
      transcript,
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 2,
      minSec: 20,
      maxSec: 60,
    });
    expect(chatJson).toHaveBeenCalledTimes(1);
    expect(result.highlights).toHaveLength(2);
    expect(result.model).toBe('m');
    expect(result.audioPath).toBe('/x.mp4');
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('chunks long transcripts and runs a final rerank call', async () => {
    chatJson
      .mockResolvedValueOnce(validResponse) // chunk 1
      .mockResolvedValueOnce(validResponse) // chunk 2
      .mockResolvedValueOnce(validResponse) // chunk 3
      .mockResolvedValueOnce(validResponse) // chunk 4
      .mockResolvedValueOnce(validResponse); // rerank
    const transcript = makeTranscript(7000);
    const result = await service.extract({
      transcript,
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 2,
      minSec: 20,
      maxSec: 60,
    });
    // 7000 words at chunkSize=2500 step=2200 → 4 chunks; +1 rerank = 5
    expect(chatJson).toHaveBeenCalledTimes(5);
    expect(result.highlights).toHaveLength(2);
  });

  it('emits progress per chunk and once for rerank', async () => {
    chatJson.mockResolvedValue(validResponse);
    const transcript = makeTranscript(5000);
    const events: { chunkIndex: number; chunkTotal: number; phase: string }[] = [];
    service.onProgress((p) => events.push(p));
    await service.extract({
      transcript,
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 2,
      minSec: 20,
      maxSec: 60,
    });
    // 5000 words → 3 chunks (0, 2200, 4400) + 1 rerank
    expect(events.length).toBe(4);
    expect(events[0]).toMatchObject({ chunkIndex: 1, chunkTotal: 3, phase: 'chunk' });
    expect(events[3]).toMatchObject({ chunkIndex: 1, chunkTotal: 1, phase: 'rerank' });
  });

  it('throws MissingApiKeyError when apiKey is empty', async () => {
    await expect(
      service.extract({
        transcript: makeTranscript(100),
        audioPath: '/x.mp4',
        apiKey: '',
        model: 'm',
        count: 2,
        minSec: 20,
        maxSec: 60,
      }),
    ).rejects.toThrow(/OpenRouter API key is not set/i);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('rejects when the LLM returns a malformed payload', async () => {
    chatJson.mockResolvedValue({ highlights: [{ start_sec: 'not a number' }] });
    await expect(
      service.extract({
        transcript: makeTranscript(100),
        audioPath: '/x.mp4',
        apiKey: 'k',
        model: 'm',
        count: 2,
        minSec: 20,
        maxSec: 60,
      }),
    ).rejects.toThrow();
  });

  it('cancel() aborts in-flight LLM calls', async () => {
    let abortedSignal: AbortSignal | null = null;
    chatJson.mockImplementation(
      (opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortedSignal = opts.signal ?? null;
          opts.signal?.addEventListener('abort', () => {
            reject(new Error('AbortError: aborted by caller'));
          });
        }),
    );
    const promise = service.extract({
      transcript: makeTranscript(100),
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 2,
      minSec: 20,
      maxSec: 60,
    });
    // Wait for the call to start
    await new Promise((r) => setTimeout(r, 0));
    service.cancel();
    await expect(promise).rejects.toThrow(/abort/i);
    expect(abortedSignal).not.toBeNull();
  });
});
