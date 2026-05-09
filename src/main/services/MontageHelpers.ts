import type { HighlightSegment } from '@shared/highlight';
import type { TrackFrame, TrackResult } from '@shared/track';
import type { Word } from '@shared/transcript';

/**
 * Concatenate per-segment tracking results into a single frame array with
 * montage-relative timestamps. Returns empty array if ANY segment has zero
 * frames — caller (RenderService) falls back to center crop in that case.
 */
export function rebaseTrackingFrames(segments: HighlightSegment[], perSegmentResults: TrackResult[]): TrackFrame[] {
  if (perSegmentResults.some((r) => r.frames.length === 0)) return [];
  const out: TrackFrame[] = [];
  let cumulativeMontageTime = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const result = perSegmentResults[i]!;
    for (const f of result.frames) {
      out.push({
        t: cumulativeMontageTime + (f.t - seg.start_sec),
        cx: f.cx,
        cy: f.cy,
      });
    }
    cumulativeMontageTime += seg.end_sec - seg.start_sec;
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
