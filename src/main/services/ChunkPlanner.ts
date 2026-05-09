import type { Segment } from '@shared/transcript';

export interface ChunkPlannerOptions {
  /** Above this segment count, split into multiple chunks + final rerank. */
  threshold: number;
  /** Segments per chunk when splitting. */
  chunkSize: number;
  /**
   * Overlap (in segments) between adjacent chunks. Helps the LLM not chop a
   * highlight across a chunk boundary.
   */
  overlap: number;
}

export interface ChunkPlan {
  /** Whether the orchestrator needs a final rerank LLM call. */
  needsRerank: boolean;
  chunks: ChunkRange[];
}

export interface ChunkRange {
  /** 1-based index of this chunk in the plan, useful for progress reporting. */
  index: number;
  /** Slice of the source segments array. */
  segments: Segment[];
  /** Global index of segments[0] in the source array — used for index rebasing. */
  firstIndex: number;
  /** Convenience: first segment's start time (seconds). */
  startSec: number;
  /** Convenience: last segment's end time (seconds). */
  endSec: number;
}

/**
 * Decides how to feed a transcript segments list to the LLM.
 *
 * - If `segments.length < threshold`, returns one chunk and skips the rerank.
 * - Otherwise walks the segments array in `chunkSize` windows that step
 *   forward by `chunkSize - overlap` each iteration.
 *
 * Pure function — no IO, no side effects.
 */
export function planChunks(segments: Segment[], opts: ChunkPlannerOptions): ChunkPlan {
  if (opts.overlap >= opts.chunkSize) {
    throw new Error(
      `ChunkPlanner: overlap must be smaller than chunkSize (got overlap=${opts.overlap}, chunkSize=${opts.chunkSize})`,
    );
  }
  if (segments.length === 0) return { needsRerank: false, chunks: [] };
  if (segments.length < opts.threshold) {
    return {
      needsRerank: false,
      chunks: [
        {
          index: 1,
          segments,
          firstIndex: 0,
          startSec: segments[0]!.start,
          endSec: segments[segments.length - 1]!.end,
        },
      ],
    };
  }
  const step = opts.chunkSize - opts.overlap;
  const chunks: ChunkRange[] = [];
  let i = 0;
  while (i < segments.length) {
    const slice = segments.slice(i, i + opts.chunkSize);
    if (slice.length === 0) break;
    chunks.push({
      index: chunks.length + 1,
      segments: slice,
      firstIndex: i,
      startSec: slice[0]!.start,
      endSec: slice[slice.length - 1]!.end,
    });
    i += step;
  }
  return { needsRerank: true, chunks };
}
