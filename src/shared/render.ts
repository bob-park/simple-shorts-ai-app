import { z } from 'zod';

/**
 * One clip's final on-disk result. The renderer uses this to display per-clip
 * status; the array is returned in the same order as the input highlights.
 */
export const RenderClipResultSchema = z.object({
  /** 1-based index into the input highlights array. */
  index: z.number().int().positive(),
  /** Highlight title (echoed for convenience). */
  title: z.string().min(1),
  /** Original highlight start, seconds. */
  startSec: z.number().nonnegative(),
  /** Original highlight end, seconds. */
  endSec: z.number().nonnegative(),
  /** Discriminates success vs failure for this specific clip. */
  status: z.enum(['done', 'failed', 'canceled']),
  /** Absolute path of the produced .mp4 (only when status==='done'). */
  outputPath: z.string().optional(),
  /** Human-readable error (only when status==='failed' or 'canceled'). */
  error: z.string().optional(),
});
export type RenderClipResult = z.infer<typeof RenderClipResultSchema>;

export const RenderResultSchema = z.object({
  /** Absolute path of the per-job output directory. */
  outputDir: z.string().min(1),
  results: z.array(RenderClipResultSchema),
});
export type RenderResult = z.infer<typeof RenderResultSchema>;

/** Per-clip progress the IPC layer streams to the renderer. */
export const RenderProgressSchema = z.object({
  /** 1-based clip index. */
  clipIndex: z.number().int().positive(),
  /** Total number of clips in the job. */
  clipTotal: z.number().int().positive(),
  /** 0..1 fraction of the current clip processed (parsed from ffmpeg). */
  fraction: z.number().min(0).max(1),
});
export type RenderProgress = z.infer<typeof RenderProgressSchema>;

export type RenderStatus = 'missing-prereq' | 'idle' | 'rendering' | 'done' | 'canceled' | 'error';
