import { describe, expect, it } from 'vitest';

import { planChunks } from './ChunkPlanner';

function fakeWords(count: number, startSec = 0): { start: number; end: number; text: string }[] {
  // Each fake word is 0.4s long, contiguous starting at startSec.
  return Array.from({ length: count }, (_, i) => ({
    start: startSec + i * 0.4,
    end: startSec + (i + 1) * 0.4,
    text: `w${i}`,
  }));
}

describe('planChunks', () => {
  it('returns a single chunk when word count is below the threshold', () => {
    const words = fakeWords(1500);
    const plan = planChunks(words, { threshold: 4000, chunkSize: 2500, overlap: 300 });
    expect(plan.chunks).toHaveLength(1);
    expect(plan.needsRerank).toBe(false);
    expect(plan.chunks[0]!.words).toHaveLength(1500);
    expect(plan.chunks[0]!.startSec).toBe(0);
    expect(plan.chunks[0]!.endSec).toBeCloseTo(1500 * 0.4);
  });

  it('splits words into overlapping chunks when above threshold', () => {
    const words = fakeWords(7000);
    const plan = planChunks(words, { threshold: 4000, chunkSize: 2500, overlap: 300 });
    expect(plan.needsRerank).toBe(true);
    // 7000 words at 2500-step with 300 overlap → starts at 0, 2200, 4400, 6600 (last is short)
    expect(plan.chunks).toHaveLength(4);
    expect(plan.chunks[0]!.words[0]!.text).toBe('w0');
    expect(plan.chunks[1]!.words[0]!.text).toBe('w2200');
    expect(plan.chunks[2]!.words[0]!.text).toBe('w4400');
    expect(plan.chunks[3]!.words[0]!.text).toBe('w6600');
  });

  it('chunk start/end seconds match the wrapped word range', () => {
    const words = fakeWords(7000);
    const plan = planChunks(words, { threshold: 4000, chunkSize: 2500, overlap: 300 });
    expect(plan.chunks[1]!.startSec).toBeCloseTo(2200 * 0.4);
    expect(plan.chunks[1]!.endSec).toBeCloseTo(Math.min(2200 + 2500, 7000) * 0.4);
  });

  it('returns an empty chunk list when given no words', () => {
    const plan = planChunks([], { threshold: 4000, chunkSize: 2500, overlap: 300 });
    expect(plan.chunks).toHaveLength(0);
    expect(plan.needsRerank).toBe(false);
  });

  it('clamps overlap so that chunk step is always positive', () => {
    // overlap >= chunkSize would loop forever — planner should guard.
    expect(() => planChunks(fakeWords(5000), { threshold: 1, chunkSize: 100, overlap: 100 })).toThrow(
      /overlap must be smaller than chunkSize/i,
    );
  });
});
