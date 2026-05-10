import type { HighlightSegment } from '@shared/highlight';
import type { TrackFrame, TrackResult } from '@shared/track';
import type { Word } from '@shared/transcript';

/**
 * Concatenate per-segment tracking results into a single frame array with
 * montage-relative timestamps.
 *
 * Empty segments (zero detections in their window — common for short
 * camera-angle changes / B-roll) are filled with synthetic anchor frames
 * at the segment boundaries. Position priority: nearest neighbor segment's
 * last known face → frame center fallback. This way a whole highlight
 * isn't forced into center-crop just because one short cut had no face.
 *
 * Returns empty array only if ALL segments have zero frames — caller
 * (RenderService) falls back to center crop in that case.
 */
export function rebaseTrackingFrames(segments: HighlightSegment[], perSegmentResults: TrackResult[]): TrackFrame[] {
  if (perSegmentResults.every((r) => r.frames.length === 0)) return [];

  const sourceWidth = perSegmentResults.find((r) => r.sourceWidth > 0)?.sourceWidth ?? 0;
  const sourceHeight = perSegmentResults.find((r) => r.sourceHeight > 0)?.sourceHeight ?? 0;
  const centerCx = sourceWidth / 2;
  const centerCy = sourceHeight / 2;

  function fallbackPosition(emptyIdx: number): { cx: number; cy: number } {
    for (let j = emptyIdx - 1; j >= 0; j--) {
      const last = perSegmentResults[j]!.frames.at(-1);
      if (last) return { cx: last.cx, cy: last.cy };
    }
    for (let j = emptyIdx + 1; j < perSegmentResults.length; j++) {
      const first = perSegmentResults[j]!.frames[0];
      if (first) return { cx: first.cx, cy: first.cy };
    }
    return { cx: centerCx, cy: centerCy };
  }

  const out: TrackFrame[] = [];
  let cumulativeMontageTime = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const result = perSegmentResults[i]!;
    const segDuration = seg.end_sec - seg.start_sec;
    if (result.frames.length === 0) {
      const { cx, cy } = fallbackPosition(i);
      out.push({ t: cumulativeMontageTime, cx, cy });
      out.push({ t: cumulativeMontageTime + segDuration, cx, cy });
    } else {
      for (const f of result.frames) {
        out.push({
          t: cumulativeMontageTime + (f.t - seg.start_sec),
          cx: f.cx,
          cy: f.cy,
        });
      }
    }
    cumulativeMontageTime += segDuration;
  }
  return out;
}

/**
 * Filter source-time transcript words to those overlapping any highlight
 * segment, then rebase their timestamps to montage-relative time. Words
 * straddling a segment boundary are clamped to the visible portion.
 */
export function rebaseTranscriptWords(segments: HighlightSegment[], sourceWords: Word[]): Word[] {
  const out: Word[] = [];
  let cumulativeMontageTime = 0;
  for (const seg of segments) {
    const segWords = sourceWords.filter((w) => w.start < seg.end_sec && w.end > seg.start_sec);
    for (const w of segWords) {
      const clampedStart = Math.max(w.start, seg.start_sec);
      const clampedEnd = Math.min(w.end, seg.end_sec);
      out.push({
        text: w.text,
        start: cumulativeMontageTime + (clampedStart - seg.start_sec),
        end: cumulativeMontageTime + (clampedEnd - seg.start_sec),
      });
    }
    cumulativeMontageTime += seg.end_sec - seg.start_sec;
  }
  return out;
}
