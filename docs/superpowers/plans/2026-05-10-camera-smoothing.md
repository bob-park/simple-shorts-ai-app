# Camera Smoothing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the half-second step jumps in the dynamic 9:16 crop by emitting linearly interpolated sendcmd lines at 30 fps between tracking keyframes.

**Architecture:** Single-file change in `src/main/services/SendcmdGenerator.ts`. The `buildSendcmd` function currently emits one `crop@c x <px>;` line per tracking keyframe (one every ~0.5 s). Update it to interpolate `cx` and `t` between adjacent keyframes at a fixed `EMIT_FPS = 30`, append the final keyframe verbatim, and clamp each interpolated step the same way single-keyframe emits are clamped today. Tracking, smoothing, render-arg builders, and ffmpeg invocation are unchanged.

**Tech Stack:** TypeScript, Vitest (Electron-Node test harness). Pure-function `buildSendcmd` consumed by `RenderService` → ffmpeg `sendcmd=f=…,crop@c=…`.

**Spec:** `docs/superpowers/specs/2026-05-10-camera-smoothing-design.md`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/main/services/SendcmdGenerator.ts` | Build the contents of an ffmpeg sendcmd file from a `TrackResult`. | MODIFY: add 30 fps interpolation between adjacent keyframes; trailing emit for the last keyframe. |
| `src/main/services/SendcmdGenerator.test.ts` | Unit tests for the above. | MODIFY: rewrite to reflect interpolated line counts; add midpoint-linearity and interpolated-clamp tests; keep single-frame, empty-frames, and vertical-source-throws coverage. |

No other files need to change. The function's signature and module exports stay identical, so `RenderService.ts` does not need to be touched.

---

### Task 1: Interpolated 30 fps emit

**Files:**
- Modify: `src/main/services/SendcmdGenerator.ts`
- Modify: `src/main/services/SendcmdGenerator.test.ts`

- [ ] **Step 1: Replace the test file with the new suite**

The existing 3-frame test asserts `lines.toHaveLength(3)`, which will block the new behavior. Replace the entire file with the suite below — it covers every spec test plus the existing single-frame / empty / throw / clamp guards.

```ts
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
});
```

- [ ] **Step 2: Run the test file to confirm the new tests fail**

Run: `yarn test src/main/services/SendcmdGenerator.test.ts`

Expected: The "interpolates 30 fps lines…", "linearly interpolates cx…", "rebases time… across multiple keyframe pairs", and the two clamp-on-interpolated-steps tests **fail**, because the current implementation emits one line per keyframe (length 2 for two keyframes, not 16). The single-frame, empty-frames, and vertical-throws tests should still pass.

If the failing tests pass at this point, do **not** proceed — the test rewrite missed the new behavior. Re-read Step 1 against the spec.

- [ ] **Step 3: Replace `buildSendcmd` with the interpolated implementation**

Overwrite `src/main/services/SendcmdGenerator.ts` with:

```ts
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
  const cropW = Math.floor((track.sourceHeight * 9) / 16);
  if (cropW > track.sourceWidth) {
    throw new Error(
      `SendcmdGenerator: source is already 9:16 or taller (sourceWidth=${track.sourceWidth}, ` +
        `sourceHeight=${track.sourceHeight}, cropW=${cropW})`,
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
```

- [ ] **Step 4: Run the test file to confirm all tests pass**

Run: `yarn test src/main/services/SendcmdGenerator.test.ts`

Expected: All 8 tests pass.

- [ ] **Step 5: Run typecheck + the full test suite to confirm no regression**

Run: `yarn typecheck && yarn test`

Expected: Typecheck exits 0. The full vitest run passes — no other test file in the repo asserts on `buildSendcmd` line counts (verified by `grep -rn "buildSendcmd" src/main` returning only `SendcmdGenerator.ts`, `SendcmdGenerator.test.ts`, and `RenderService.ts` which only checks for the substring `sendcmd` in args, not line counts).

- [ ] **Step 6: Manual visual verification**

Run: `yarn dev`

In the app, render against any source longer than ~30 seconds that has at least one face-tracked highlight (the `short_<i>.cmd` file under the output dir should exist and not be empty). Watch the produced `short_<i>.mp4` and confirm the camera glides smoothly instead of stepping every half second. If you have an old render from before this change saved (for example under `~/Downloads/shorts/result/<title>/`), play them side by side.

If smoothness is unsatisfactory after this change, do **not** commit — bump `EMIT_FPS` to 60 in `SendcmdGenerator.ts`, re-run the suite, and re-render. The line count will roughly double; tests using `toHaveLength(16)` will need to become `toHaveLength(31)`. (Skip this loop if 30 fps already looks right.)

- [ ] **Step 7: Commit**

```bash
git add src/main/services/SendcmdGenerator.ts src/main/services/SendcmdGenerator.test.ts
git commit -m "$(cat <<'EOF'
fix: interpolate sendcmd at 30 fps so dynamic crop glides instead of stepping

face_tracker samples at 2 fps and emits one tracking keyframe every ~0.5s.
The previous SendcmdGenerator wrote one ffmpeg sendcmd line per keyframe,
so the crop@c filter snapped to a new x twice per second — visible as a
half-second step jump in the rendered shorts.

Linearly interpolate cx and t between adjacent keyframes at EMIT_FPS = 30
and append the last keyframe verbatim. Clamp runs per emitted step so a
face moving toward an edge still produces sensible bounded x values.

Sendcmd file grows from ~2 lines/sec to ~30 lines/sec — negligible parse
cost, no measurable render-wall-time impact. Spec at
docs/superpowers/specs/2026-05-10-camera-smoothing-design.md.
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Algorithm (pseudocode in spec) → Step 3 implementation matches one-to-one (constant `EMIT_FPS = 30`, per-pair `dt <= 0` skip, `steps = floor(dt * EMIT_FPS)`, alpha-based linear interpolation, trailing keyframe append, per-step clamp via `pixelFromCx`).
- Empty frames → `''` → Step 1 test + Step 3 early return.
- Single keyframe → 1 line → Step 1 test + Step 3 trailing-emit fallthrough.
- 9:16-or-taller throw unchanged → Step 1 test + Step 3 throw.
- Two-keyframe / 0.5 s test with line count 16 + midpoint check → Step 1 first two tests.
- Multi-pair time rebase → Step 1 third test (line count 31).
- Clamp on interpolated step → Step 1 fifth and sixth tests.
- Re-baselined existing 3-frame test (the spec called this out as needing update) → done in Step 1.

All spec testing-section requirements covered.

**2. Placeholder scan:** no `TBD`, no "implement later", no vague "handle edge cases" — every step has concrete code, exact commands, or precise expected outcomes.

**3. Type consistency:** `buildSendcmd(track: TrackResult, clipStartSec: number): string` is the same signature as the current export. The single import site (`RenderService.ts`) keeps working without modification because the return type, exported name, and runtime contract (string output, throws on vertical source, empty-string on empty frames) all stay identical.
