import { z } from 'zod';

export const TranscribeProgressSchema = z.object({
  jobId: z.string().min(1),
  /** Seconds of audio processed so far. */
  processed: z.number().nonnegative(),
  /** Total duration in seconds. May be 0 if unknown. */
  total: z.number().nonnegative(),
});
export type TranscribeProgress = z.infer<typeof TranscribeProgressSchema>;

export type TranscribeStatus = 'idle' | 'starting' | 'transcribing' | 'done' | 'canceled' | 'error';
