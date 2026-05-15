import { z } from 'zod';

export const TranscribeProgressSchema = z.object({
  jobId: z.string().min(1),
  /**
   * Which phase this progress belongs to. `model-download` = first-run
   * Whisper model fetch (processed/total are BYTES). `transcribe` = the
   * actual transcription (processed/total are SECONDS). Absent is treated
   * as `transcribe` for back-compat with older sidecars.
   */
  phase: z.enum(['model-download', 'transcribe']).optional(),
  /** Bytes downloaded (model-download) or seconds processed (transcribe). */
  processed: z.number().nonnegative(),
  /** Total bytes (model-download) or total seconds (transcribe); 0 if unknown. */
  total: z.number().nonnegative(),
});
export type TranscribeProgress = z.infer<typeof TranscribeProgressSchema>;

export type TranscribeStatus =
  | 'idle'
  | 'starting'
  | 'downloading-model'
  | 'transcribing'
  | 'done'
  | 'canceled'
  | 'error';
