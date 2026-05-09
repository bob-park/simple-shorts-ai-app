import { z } from 'zod';

/** One sampled keyframe in source pixel coordinates. */
export const TrackFrameSchema = z.object({
  /** Seconds from the start of the source video (NOT clip-relative). */
  t: z.number().nonnegative(),
  /** Face center x in source pixels. */
  cx: z.number().nonnegative(),
  /** Face center y in source pixels. */
  cy: z.number().nonnegative(),
});
export type TrackFrame = z.infer<typeof TrackFrameSchema>;

/**
 * Result of a `track_faces` RPC call. `frames` is empty when no face was ever
 * detected in the requested window — the caller should fall back to center
 * crop in that case.
 */
export const TrackResultSchema = z.object({
  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),
  frames: z.array(TrackFrameSchema),
});
export type TrackResult = z.infer<typeof TrackResultSchema>;
