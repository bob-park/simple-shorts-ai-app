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
  /**
   * If face tracking was attempted: number of keyframes used and the path of
   * the persisted track JSON. Absent when tracker was not provided OR when no
   * faces were detected (caller used the M6 center-crop fallback).
   */
  tracking: z
    .object({
      frames: z.number().int().nonnegative(),
      trackPath: z.string().min(1),
    })
    .nullish(),
  /**
   * If subtitles were enabled and at least one cue landed in the clip window:
   * the cue count and the persisted .ass file path. Absent when subtitles
   * were disabled in settings OR no transcript words fell inside the clip
   * range (silent clip).
   */
  subtitles: z
    .object({
      cues: z.number().int().nonnegative(),
      assPath: z.string().min(1),
    })
    .nullish(),
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
