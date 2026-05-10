import type { TrackResult } from '@shared/track';
import { describe, expect, it } from 'vitest';

import { buildSendcmd } from './SendcmdGenerator';

function track(frames: { t: number; cx: number; cy: number }[]): TrackResult {
  return { sourceWidth: 1920, sourceHeight: 1080, frames };
}

function parseLines(out: string): { t: number; x: number }[] {
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const m = l.match(/^([\d.]+)\s+crop@c x (\d+);$/);
      if (!m) throw new Error(`unparseable sendcmd line: ${l}`);
      return { t: Number(m[1]), x: Number(m[2]) };
    });
}

describe('buildSendcmd', () => {
  it('interpolates 30 fps lines between adjacent keyframes plus a trailing line', () => {
    // Two keyframes 0.5s apart → floor(0.5 * 30) = 15 interpolated + 1 trailing = 16 lines.
    const out = buildSendcmd(
      track([
        { t: 0, cx: 960, cy: 540 },
        { t: 0.5, cx: 1200, cy: 540 },
      ]),
      0,
    );
    const lines = parseLines(out);
    expect(lines).toHaveLength(16);
    // First line: alpha = 0 → exact frame 0.
    expect(lines[0]!.t).toBeCloseTo(0, 5);
    // crop_w = floor(1080 * 9/16) = 607. round(960 - 303.5) = 657.
    expect(lines[0]!.x).toBe(657);
    // Trailing line: exact frame 1. round(1200 - 303.5) = 897.
    expect(lines[15]!.t).toBeCloseTo(0.5, 5);
    expect(lines[15]!.x).toBe(897);
  });

  it('linearly interpolates cx between keyframes (monotonic + midpoint check)', () => {
    const out = buildSendcmd(
      track([
        { t: 0, cx: 960, cy: 540 },
        { t: 0.5, cx: 1200, cy: 540 },
      ]),
      0,
    );
    const lines = parseLines(out);
    // x values must be monotonically non-decreasing as cx grows.
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]!.x).toBeGreaterThanOrEqual(lines[i - 1]!.x);
    }
    // Midpoint (alpha = 7/15) cx ≈ 960 + 240 * 7/15 = 1072 → round(1072 - 303.5) = 769.
    expect(lines[7]!.x).toBe(769);
  });

  it('rebases time to clip-relative across multiple keyframe pairs', () => {
    // Source-time frames at 5.0 / 5.5 / 6.0; clip starts at 5.0.
    // Two pairs × 15 interpolated + 1 trailing = 31 lines.
    const out = buildSendcmd(
      track([
        { t: 5.0, cx: 960, cy: 540 },
        { t: 5.5, cx: 970, cy: 540 },
        { t: 6.0, cx: 980, cy: 540 },
      ]),
      5.0,
    );
    const lines = parseLines(out);
    expect(lines).toHaveLength(31);
    expect(lines[0]!.t).toBeCloseTo(0, 5);
    expect(lines[lines.length - 1]!.t).toBeCloseTo(1.0, 5);
  });

  it('emits exactly one line for a single keyframe (no pairs to interpolate)', () => {
    const out = buildSendcmd(track([{ t: 0, cx: 960, cy: 540 }]), 0);
    const lines = parseLines(out);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.x).toBe(657);
  });

  it('returns an empty string for empty frames (caller falls back to center)', () => {
    const out = buildSendcmd(track([]), 0);
    expect(out).toBe('');
  });

  it('clamps interpolated steps at sourceWidth - cropW when cx is past the right edge', () => {
    // crop_w = 607, max x = 1920 - 607 = 1313.
    // Interpolating cx 1900 → 2000 should clamp every step at 1313.
    const out = buildSendcmd(
      track([
        { t: 0, cx: 1900, cy: 540 },
        { t: 0.5, cx: 2000, cy: 540 },
      ]),
      0,
    );
    const lines = parseLines(out);
    expect(lines).toHaveLength(16);
    for (const line of lines) {
      expect(line.x).toBe(1313);
    }
  });

  it('clamps interpolated steps at 0 when cx is at the left edge', () => {
    const out = buildSendcmd(
      track([
        { t: 0, cx: 50, cy: 540 },
        { t: 0.5, cx: 60, cy: 540 },
      ]),
      0,
    );
    const lines = parseLines(out);
    expect(lines).toHaveLength(16);
    for (const line of lines) {
      expect(line.x).toBe(0);
    }
  });

  it('throws when source aspect ratio is already vertical (cropW > sourceWidth)', () => {
    const portrait: TrackResult = {
      sourceWidth: 1000,
      sourceHeight: 2000,
      frames: [{ t: 0, cx: 500, cy: 1000 }],
    };
    expect(() => buildSendcmd(portrait, 0)).toThrow(/already 9:16 or taller/i);
  });

  it('skips a pair with duplicate timestamps (dt = 0) and still emits correctly', () => {
    const out = buildSendcmd(
      track([
        { t: 0, cx: 960, cy: 540 },
        { t: 0, cx: 800, cy: 540 }, // same timestamp — dt = 0, this pair is skipped
        { t: 0.5, cx: 900, cy: 540 },
      ]),
      0,
    );
    const lines = parseLines(out);
    // pair[0,1] skipped (dt=0); pair[1,2] emits 15 interpolated + trailing 1 = 16 lines.
    expect(lines).toHaveLength(16);
  });
});
