import { VIDEO_CROP_DEN, VIDEO_CROP_NUM } from '@shared/shortLayout';
import type { TrackResult } from '@shared/track';

const EMIT_FPS = 30;

/**
 * Build the contents of an ffmpeg sendcmd file that drives a named `crop@c`
 * filter to follow the tracked face center over time.
 *
 * Tracking keyframes arrive at ~2 fps (face_tracker samples every 0.5 s).
 * Emitting one sendcmd line per keyframe makes the crop snap to a new x
 * twice per second, which reads as a half-second step jump on screen.
 * Instead, between every adjacent pair of keyframes we linearly interpolate
 * cx and t at EMIT_FPS, so the crop appears to glide continuously. The final
 * keyframe is appended verbatim so the curve ends on the actual measurement.
 *
 * Time values are clip-relative (rebased by `clipStartSec`) because sendcmd's
 * leading numeric column is the filter graph's time, not the source video's
 * time. Pixel `x` is clamped to `[0, sourceWidth - cropW]` per emitted step
 * so the crop box never escapes the source frame.
 *
 * Returns an empty string when frames is empty so the caller can fall back
 * to the M6 center crop.
 */
export function buildSendcmd(track: TrackResult, clipStartSec: number): string {
  if (track.frames.length === 0) return '';
  const cropW = Math.floor((track.sourceHeight * VIDEO_CROP_NUM) / VIDEO_CROP_DEN);
  if (cropW > track.sourceWidth) {
    throw new Error(
      `SendcmdGenerator: source is already ${VIDEO_CROP_NUM}:${VIDEO_CROP_DEN} or taller ` +
        `(sourceWidth=${track.sourceWidth}, sourceHeight=${track.sourceHeight}, cropW=${cropW})`,
    );
  }
  const maxX = track.sourceWidth - cropW;
  const halfCrop = cropW / 2;
  const pixelFromCx = (cx: number): number => {
    const xRaw = Math.round(cx - halfCrop);
    return Math.min(maxX, Math.max(0, xRaw));
  };

  const lines: string[] = [];
  for (let i = 0; i < track.frames.length - 1; i++) {
    const a = track.frames[i]!;
    const b = track.frames[i + 1]!;
    const dt = b.t - a.t;
    if (dt <= 0) continue; // defensive — sampler is monotonic
    const steps = Math.floor(dt * EMIT_FPS);
    if (steps === 0) continue; // pair closer than 1/EMIT_FPS — trailing emit covers the last frame; the upstream sampler always spaces keyframes far apart enough that this is unreachable in practice
    for (let s = 0; s < steps; s++) {
      const alpha = s / steps;
      const t = a.t + (b.t - a.t) * alpha;
      const cx = a.cx + (b.cx - a.cx) * alpha;
      lines.push(`${t - clipStartSec} crop@c x ${pixelFromCx(cx)};`);
    }
  }
  const last = track.frames[track.frames.length - 1]!;
  lines.push(`${last.t - clipStartSec} crop@c x ${pixelFromCx(last.cx)};`);
  return lines.join('\n');
}
