import type { HighlightSegment } from '@shared/highlight';
import type { TrackResult } from '@shared/track';
import type { Word } from '@shared/transcript';
import { describe, expect, it } from 'vitest';

import { rebaseTrackingFrames, rebaseTranscriptWords } from './MontageHelpers';

describe('rebaseTrackingFrames', () => {
  it('concatenates per-segment frames into one montage-relative array', () => {
    const segments: HighlightSegment[] = [
      { start_sec: 10, end_sec: 13 }, // duration 3
      { start_sec: 100, end_sec: 102 }, // duration 2
    ];
    const perSeg: TrackResult[] = [
      {
        sourceWidth: 1920,
        sourceHeight: 1080,
        frames: [
          { t: 10, cx: 100, cy: 100 },
          { t: 12, cx: 200, cy: 200 },
        ],
      },
      {
        sourceWidth: 1920,
        sourceHeight: 1080,
        frames: [
          { t: 100, cx: 300, cy: 300 },
          { t: 101, cx: 400, cy: 400 },
        ],
      },
    ];
    const frames = rebaseTrackingFrames(segments, perSeg);
    expect(frames).toEqual([
      { t: 0, cx: 100, cy: 100 }, // segment 0: t=10 → 0
      { t: 2, cx: 200, cy: 200 }, // segment 0: t=12 → 2
      { t: 3, cx: 300, cy: 300 }, // segment 1: t=100 → 3 (cumulative)
      { t: 4, cx: 400, cy: 400 }, // segment 1: t=101 → 4
    ]);
  });

  it('returns empty array if any segment has empty frames (caller falls back to center crop)', () => {
    const segments: HighlightSegment[] = [
      { start_sec: 10, end_sec: 13 },
      { start_sec: 100, end_sec: 102 },
    ];
    const perSeg: TrackResult[] = [
      { sourceWidth: 1920, sourceHeight: 1080, frames: [{ t: 10, cx: 100, cy: 100 }] },
      { sourceWidth: 1920, sourceHeight: 1080, frames: [] },
    ];
    expect(rebaseTrackingFrames(segments, perSeg)).toEqual([]);
  });

  it('handles a single segment as a degenerate case', () => {
    const segments: HighlightSegment[] = [{ start_sec: 5, end_sec: 8 }];
    const perSeg: TrackResult[] = [{ sourceWidth: 1920, sourceHeight: 1080, frames: [{ t: 5, cx: 50, cy: 50 }] }];
    expect(rebaseTrackingFrames(segments, perSeg)).toEqual([{ t: 0, cx: 50, cy: 50 }]);
  });
});

describe('rebaseTranscriptWords', () => {
  function w(text: string, start: number, end: number): Word {
    return { text, start, end };
  }

  it('filters and rebases words for a multi-segment montage', () => {
    const segments: HighlightSegment[] = [
      { start_sec: 10, end_sec: 13 }, // duration 3
      { start_sec: 100, end_sec: 102 }, // duration 2
    ];
    const sourceWords: Word[] = [
      w('skip', 0, 1), // outside both
      w('hello', 10.5, 11.0), // segment 0 → t=0.5..1.0
      w('world', 12.0, 12.5), // segment 0 → t=2.0..2.5
      w('skip', 50, 51), // outside
      w('next', 100.0, 101.5), // segment 1 → t=3.0..4.5
    ];
    const rebased = rebaseTranscriptWords(segments, sourceWords);
    expect(rebased).toEqual([
      { text: 'hello', start: 0.5, end: 1.0 },
      { text: 'world', start: 2.0, end: 2.5 },
      { text: 'next', start: 3.0, end: 4.5 },
    ]);
  });

  it('clamps words that straddle segment boundaries', () => {
    const segments: HighlightSegment[] = [{ start_sec: 10, end_sec: 13 }];
    const sourceWords: Word[] = [
      w('straddleStart', 9.5, 10.5), // visible portion 10.0..10.5 → t=0..0.5
      w('straddleEnd', 12.5, 13.5), // visible portion 12.5..13.0 → t=2.5..3.0
    ];
    const rebased = rebaseTranscriptWords(segments, sourceWords);
    expect(rebased).toEqual([
      { text: 'straddleStart', start: 0, end: 0.5 },
      { text: 'straddleEnd', start: 2.5, end: 3.0 },
    ]);
  });

  it('returns empty array when no words fall in any segment', () => {
    const segments: HighlightSegment[] = [{ start_sec: 100, end_sec: 110 }];
    const sourceWords: Word[] = [w('skip', 0, 1)];
    expect(rebaseTranscriptWords(segments, sourceWords)).toEqual([]);
  });
});
