import { z } from 'zod';

/** One time range in source video time. */
export const HighlightSegmentSchema = z
  .object({
    start_sec: z.number().nonnegative(),
    end_sec: z.number().nonnegative(),
  })
  .refine((v) => v.end_sec > v.start_sec, {
    message: 'end_sec must be greater than start_sec',
    path: ['end_sec'],
  });
export type HighlightSegment = z.infer<typeof HighlightSegmentSchema>;

/**
 * One highlight clip the LLM picked out of the transcript. Composed of one or
 * more non-contiguous time ranges (segments) — the renderer concatenates them
 * into a single mp4 via ffmpeg's `select` filter. Single-range highlights are
 * just `segments.length === 1` — degenerate case, same render path.
 */
export const HighlightSchema = z.object({
  /** 1+ time ranges in source video time. Sorted chronologically by start_sec. */
  segments: z.array(HighlightSegmentSchema).min(1),
  title: z.string().min(1),
  /** One-line hook describing why this clip would grab a viewer. */
  hook: z.string().min(1),
});
export type Highlight = z.infer<typeof HighlightSchema>;

/** Persisted alongside the source video as `<videoStem>.highlights.json`. */
export const HighlightSetSchema = z.object({
  /** ISO 8601 timestamp the LLM call completed. */
  generatedAt: z.string().min(1),
  /** Model identifier reported by the LLM sidecar (e.g. 'gemma-3-4b'). */
  model: z.string().min(1),
  /** Absolute path of the source video this set was generated from. */
  audioPath: z.string().min(1),
  highlights: z.array(HighlightSchema),
});
export type HighlightSet = z.infer<typeof HighlightSetSchema>;
