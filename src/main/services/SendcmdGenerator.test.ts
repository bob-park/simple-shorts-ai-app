import type { TrackResult } from '@shared/track';
import { describe, expect, it } from 'vitest';

import { buildSendcmd } from './SendcmdGenerator';

function track(frames: { t: number; cx: number; cy: number }[]): TrackResult {
  return { sourceWidth: 1920, sourceHeight: 1080, frames };
}

describe('buildSendcmd', () => {
  it('emits one crop@c x line per frame, time rebased to clip-relative', () => {
    // Source-time frames at 5.0 / 5.5 / 6.0; clip starts at 5.0.
    const out = buildSendcmd(
      track([
        { t: 5.0, cx: 960, cy: 540 },
        { t: 5.5, cx: 970, cy: 545 },
        { t: 6.0, cx: 980, cy: 550 },
      ]),
      5.0,
    );
    const lines = out.split('\n').filter((l) => l.trim());
    // Three frames → three sendcmd entries.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^0(?:\.0+)?\s+crop@c x \d+/);
    expect(lines[1]).toMatch(/^0\.5\s+crop@c x \d+/);
    expect(lines[2]).toMatch(/^1(?:\.0+)?\s+crop@c x \d+/);
  });

  it('computes crop x as clamp(cx - cropW/2, 0, sourceWidth - cropW)', () => {
    // crop_w = 1080 * 9/16 = 607.5 → use 607 (rounded down)
    // For cx = 960 (centered): x = 960 - 607/2 = 960 - 303 = 657 (rounded)
    const out = buildSendcmd(track([{ t: 0, cx: 960, cy: 540 }]), 0);
    expect(out).toMatch(/crop@c x 657/);
  });

  it('clamps crop x at 0 when cx is at the left edge', () => {
    const out = buildSendcmd(track([{ t: 0, cx: 50, cy: 540 }]), 0);
    expect(out).toMatch(/crop@c x 0/);
  });

  it('clamps crop x at sourceWidth - cropW when cx is at the right edge', () => {
    // crop_w = 607, source_width = 1920 → max x = 1920 - 607 = 1313
    const out = buildSendcmd(track([{ t: 0, cx: 1900, cy: 540 }]), 0);
    expect(out).toMatch(/crop@c x 1313/);
  });

  it('returns an empty string for empty frames (caller falls back to center)', () => {
    const out = buildSendcmd(track([]), 0);
    expect(out).toBe('');
  });

  it('throws when source aspect ratio is already vertical (cropW > sourceWidth)', () => {
    // 1080×1920 source: crop_w would be 1920 * 9/16 = 1080, equals source width
    // → still works (max x = 0). But 1000×2000: crop_w = 1125, > 1000 → throw.
    const portrait: TrackResult = {
      sourceWidth: 1000,
      sourceHeight: 2000,
      frames: [{ t: 0, cx: 500, cy: 1000 }],
    };
    expect(() => buildSendcmd(portrait, 0)).toThrow(/already 9:16 or taller/i);
  });
});
