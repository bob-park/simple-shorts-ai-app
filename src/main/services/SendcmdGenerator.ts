import type { TrackResult } from '@shared/track';

/**
 * Build the contents of an ffmpeg sendcmd file that drives a named `crop@c`
 * filter to follow the tracked face center over time.
 *
 * Time values in the output are clip-relative (rebased by `clipStartSec`)
 * because sendcmd's leading numeric column is the filter graph's time, not
 * the source video's time. Pixel `x` is clamped to `[0, sourceWidth - cropW]`
 * so the crop box never escapes the source frame. Returns an empty string
 * when frames is empty so the caller can fall back to the M6 center crop.
 */
export function buildSendcmd(track: TrackResult, clipStartSec: number): string {
  if (track.frames.length === 0) return '';
  const cropW = Math.floor((track.sourceHeight * 9) / 16);
  if (cropW > track.sourceWidth) {
    throw new Error(
      `SendcmdGenerator: source is already 9:16 or taller (sourceWidth=${track.sourceWidth}, ` +
        `sourceHeight=${track.sourceHeight}, cropW=${cropW})`,
    );
  }
  const maxX = track.sourceWidth - cropW;
  const lines: string[] = [];
  for (const frame of track.frames) {
    const tRel = Math.max(0, frame.t - clipStartSec);
    const xRaw = Math.round(frame.cx - cropW / 2);
    const xClamped = Math.min(maxX, Math.max(0, xRaw));
    lines.push(`${tRel} crop@c x ${xClamped};`);
  }
  return lines.join('\n');
}
