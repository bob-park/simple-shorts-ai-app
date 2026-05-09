import { describe, expect, it } from 'vitest';

import { planChunks } from './ChunkPlanner';

function fakeSegments(count: number, startSec = 0): { start: number; end: number; text: string }[] {
  // Each fake segment is 5s long, contiguous starting at startSec.
  return Array.from({ length: count }, (_, i) => ({
    start: startSec + i * 5,
    end: startSec + (i + 1) * 5,
    text: `seg${i}`,
  }));
}

describe('planChunks (segment-based)', () => {
  it('returns a single chunk when segment count is below the threshold', () => {
    const segs = fakeSegments(50);
    const plan = planChunks(segs, { threshold: 150, chunkSize: 100, overlap: 10 });
    expect(plan.chunks).toHaveLength(1);
    expect(plan.needsRerank).toBe(false);
    expect(plan.chunks[0]!.segments).toHaveLength(50);
    expect(plan.chunks[0]!.firstIndex).toBe(0);
    expect(plan.chunks[0]!.startSec).toBe(0);
    expect(plan.chunks[0]!.endSec).toBe(50 * 5);
  });

  it('splits into overlapping chunks when above threshold and tracks firstIndex globally', () => {
    const segs = fakeSegments(280);
    const plan = planChunks(segs, { threshold: 150, chunkSize: 100, overlap: 10 });
    expect(plan.needsRerank).toBe(true);
    // step = 90; starts at 0, 90, 180, 270 (last is short)
    expect(plan.chunks).toHaveLength(4);
    expect(plan.chunks[0]!.firstIndex).toBe(0);
    expect(plan.chunks[1]!.firstIndex).toBe(90);
    expect(plan.chunks[2]!.firstIndex).toBe(180);
    expect(plan.chunks[3]!.firstIndex).toBe(270);
  });

  it('chunk start/end seconds match the wrapped segment range', () => {
    const segs = fakeSegments(280);
    const plan = planChunks(segs, { threshold: 150, chunkSize: 100, overlap: 10 });
    // Chunk 1: indices 90..189 → startSec=90*5=450, endSec=Math.min(190,280)*5=950
    expect(plan.chunks[1]!.startSec).toBe(450);
    expect(plan.chunks[1]!.endSec).toBe(950);
  });

  it('returns an empty chunk list when given no segments', () => {
    const plan = planChunks([], { threshold: 150, chunkSize: 100, overlap: 10 });
    expect(plan.chunks).toHaveLength(0);
    expect(plan.needsRerank).toBe(false);
  });

  it('clamps overlap so that chunk step is always positive', () => {
    expect(() => planChunks(fakeSegments(200), { threshold: 1, chunkSize: 100, overlap: 100 })).toThrow(
      /overlap must be smaller than chunkSize/i,
    );
  });
});
