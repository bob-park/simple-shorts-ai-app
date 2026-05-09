import { z } from 'zod';

/**
 * One highlight clip the LLM picked out of the transcript. Time fields are
 * seconds from the start of the source video (the same timeline used by the
 * Transcript word array).
 */
export const HighlightSchema = z
  .object({
    start_sec: z.number().nonnegative(),
    end_sec: z.number().nonnegative(),
    title: z.string().min(1),
    /** One-line hook describing why this clip would grab a viewer. */
    hook: z.string().min(1),
  })
  .refine((v) => v.end_sec > v.start_sec, {
    message: 'end_sec must be greater than start_sec',
    path: ['end_sec'],
  });
export type Highlight = z.infer<typeof HighlightSchema>;

/** Persisted alongside the source video as `<videoStem>.highlights.json`. */
export const HighlightSetSchema = z.object({
  /** ISO 8601 timestamp the LLM call completed. */
  generatedAt: z.string().min(1),
  /** Model id passed to OpenRouter, e.g. 'anthropic/claude-sonnet-4.5'. */
  model: z.string().min(1),
  /** Absolute path of the source video this set was generated from. */
  audioPath: z.string().min(1),
  highlights: z.array(HighlightSchema),
});
export type HighlightSet = z.infer<typeof HighlightSetSchema>;
