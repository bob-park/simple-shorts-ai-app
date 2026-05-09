import type { Word } from '@shared/transcript';

export interface ChunkPlannerOptions {
  /** Above this word count, split into multiple chunks + final rerank. */
  threshold: number;
  /** Words per chunk when splitting. */
  chunkSize: number;
  /**
   * Overlap (in words) between adjacent chunks. Helps the LLM not chop a
   * highlight in half at a chunk boundary.
   */
  overlap: number;
}

export interface ChunkPlan {
  /** Whether the orchestrator needs a final rerank LLM call. */
  needsRerank: boolean;
  chunks: ChunkRange[];
}

export interface ChunkRange {
  /** 1-based index, useful for progress reporting. */
  index: number;
  /** Slice of the source words array (start..end exclusive). */
  words: Word[];
  /** Convenience: first word's start time (seconds). */
  startSec: number;
  /** Convenience: last word's end time (seconds). */
  endSec: number;
}

/**
 * Decides how to feed a transcript word list to the LLM.
 *
 * - If `words.length < threshold`, returns one chunk and skips the rerank step.
 * - Otherwise, walks the word array in `chunkSize` windows that step forward
 *   by `chunkSize - overlap` each iteration, so adjacent chunks overlap by
 *   `overlap` words.
 *
 * Pure function — no IO, no side effects.
 */
export function planChunks(words: Word[], opts: ChunkPlannerOptions): ChunkPlan {
  if (opts.overlap >= opts.chunkSize) {
    throw new Error(
      `ChunkPlanner: overlap must be smaller than chunkSize (got overlap=${opts.overlap}, chunkSize=${opts.chunkSize})`,
    );
  }
  if (words.length === 0) return { needsRerank: false, chunks: [] };
  if (words.length < opts.threshold) {
    return {
      needsRerank: false,
      chunks: [
        {
          index: 1,
          words,
          startSec: words[0]!.start,
          endSec: words[words.length - 1]!.end,
        },
      ],
    };
  }
  const step = opts.chunkSize - opts.overlap;
  const chunks: ChunkRange[] = [];
  let i = 0;
  while (i < words.length) {
    const slice = words.slice(i, i + opts.chunkSize);
    if (slice.length === 0) break;
    chunks.push({
      index: chunks.length + 1,
      words: slice,
      startSec: slice[0]!.start,
      endSec: slice[slice.length - 1]!.end,
    });
    i += step;
  }
  return { needsRerank: true, chunks };
}
