import { z } from 'zod';

export const SegmentSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const WordSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
});
export type Word = z.infer<typeof WordSchema>;

export const TranscriptSchema = z.object({
  /** Total audio duration in seconds (from yt-dlp/whisper). */
  duration: z.number().nonnegative(),
  /** Detected or specified language (BCP47 / ISO 639). May be empty. */
  language: z.string(),
  segments: z.array(SegmentSchema),
  words: z.array(WordSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;
