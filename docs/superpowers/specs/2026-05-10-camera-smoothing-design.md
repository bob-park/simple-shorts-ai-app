# Camera Smoothing — Interpolated 30fps Sendcmd Emit

**Status:** Design approved 2026-05-10
**Scope:** Single-file change in `src/main/services/SendcmdGenerator.ts` plus its unit tests.

## Problem

The dynamic 9:16 crop currently jumps to a new x-position every ~0.5 seconds because:

- `face_tracker.py` samples at 2 fps over each segment, applies a Gaussian smoothing window, and returns one `(t, cx, cy)` keyframe per sample.
- `SendcmdGenerator.buildSendcmd` emits exactly one `${t} crop@c x ${px};` line per keyframe.
- ffmpeg's `sendcmd` treats each line as an instant set, so the crop box snaps to a new x at every keyframe and holds it until the next.

The user's reported symptom is the visible "텔렁텔렁" (clunky/staircase) jump every half-second. Position values themselves are reasonable; only the discontinuous emit pattern needs to change.

## Goal

Produce a sendcmd file dense enough that the crop box appears to move continuously between keyframes, without changing the upstream tracking, smoothing, or sampling behavior.

## Non-goals

- No change to face detection or sampling rate.
- No change to the Gaussian smoothing kernel.
- No new physics simulation (spring/damper). That option is documented as a future enhancement (see "Alternatives considered").
- No new function arguments or service-level config. The emit rate is a constant.

## Design

### Approach

Inside `buildSendcmd`, for every adjacent pair of keyframes, linearly interpolate `cx` and `t` and emit one sendcmd line per interpolated step at a fixed emit rate (default 30 fps). Append the final keyframe verbatim so the curve ends on the real measurement.

### Components

`src/main/services/SendcmdGenerator.ts` (modified):

- New module constant: `EMIT_FPS = 30`.
- `buildSendcmd(track, clipStartSec)` — same signature, same return type. Interior changes only.

### Algorithm

```
const EMIT_FPS = 30
const emitInterval = 1 / EMIT_FPS

if (frames.length === 0) return ''

cropW = floor(sourceHeight * 9 / 16)
if (cropW > sourceWidth) throw  // unchanged

maxX = sourceWidth - cropW

function pixelFromCx(cx):
  return clamp(round(cx - cropW / 2), 0, maxX)

lines = []
for i in 0 .. frames.length - 2:
  a = frames[i]
  b = frames[i + 1]
  dt = b.t - a.t
  if dt <= 0:
    continue   // defensive; sampler is monotonic, but skip rather than emit junk
  steps = floor(dt * EMIT_FPS)
  for s in 0 .. steps - 1:
    alpha = s / steps
    t  = a.t  + (b.t  - a.t)  * alpha
    cx = a.cx + (b.cx - a.cx) * alpha
    lines.push(`${t - clipStartSec} crop@c x ${pixelFromCx(cx)};`)

last = frames[frames.length - 1]
lines.push(`${last.t - clipStartSec} crop@c x ${pixelFromCx(last.cx)};`)

return lines.join('\n')
```

Key properties:

- For two keyframes 0.5 s apart at 30 fps, `steps = 15`, so 15 interpolated lines plus the trailing final keyframe ≈ 16 lines per gap. A 60-second clip with ~120 keyframes produces ~1800 lines — small, parses instantly in ffmpeg.
- The first keyframe is implicitly emitted as the `s = 0` step of pair (0, 1) — its line carries `alpha = 0`, which is exactly `frames[0]`.
- The last keyframe is appended explicitly to ensure the camera ends on the actual measured position even if `dt * EMIT_FPS` doesn't divide evenly.
- `cy` is sampled into `TrackResult.frames` but never used by `buildSendcmd` today. That stays out of scope — vertical-axis tracking is a separate feature.

### Edge cases

- `frames.length === 0` → return `''` (caller falls back to center crop). **Unchanged.**
- `frames.length === 1` → loop body doesn't execute; only the trailing single-line emit fires. One line out.
- `dt <= 0` between any pair (defensive — the sampler is monotonic) → skip that pair's interpolation.
- Source already 9:16 or taller (`cropW > sourceWidth`) → throw, **unchanged.**
- Clamp logic (`pixelFromCx`) runs per interpolated step, not just per keyframe, so a face moving toward an edge still produces sensible clamped values throughout the interval.

### Data flow

```
sidecar face_tracker.py
  └─ Track frames at 2 fps + Gaussian smooth
        └─ TrackResult.frames = [{t, cx, cy}, ...]   ← unchanged
              └─ RenderService.maybeTrackAndPersist
                    └─ buildSendcmd(track, clipStartSec)   ← THIS CHANGES
                          └─ short_<i>.cmd (now ~30 lines/sec instead of ~2)
                                └─ ffmpeg `sendcmd=f=...,crop@c=...`
                                      └─ Continuous-feeling crop motion
```

## Testing

Add to `src/main/services/SendcmdGenerator.test.ts`:

- **Two keyframes, 0.5s apart**: assert line count is `~16` (`floor(0.5 * 30)` interpolated + 1 final), spot-check a midpoint line for linearly interpolated x.
- **Single keyframe**: assert exactly 1 line emitted, x equals `pixelFromCx(frame.cx)`.
- **Zero frames**: assert empty string (regression guard for center-crop fallback).
- **Clamp on interpolated step**: keyframes whose interpolated midpoints would exceed `maxX`; assert the emitted x in those midpoint lines equals `maxX` (or 0).
- **Existing test updates**: any test asserting line count must be re-baselined (we now emit many more lines per gap).

Visual verification of "smoothness" requires a real video and human eyes — not codifiable as a unit test. The user will eyeball the next render after the change.

## Performance

- Sendcmd file size for a 60s short: ~1800 lines (~50 KB). Negligible compared to the source video.
- ffmpeg's sendcmd parser is line-oriented and cheap. No measurable impact on render wall time.
- TypeScript-side computation is O(N · steps) where N ≈ keyframes — for a typical 60s short this is ~1800 multiplications and clamps, well under a millisecond.

## Alternatives considered

1. **Spring-damper physics simulation** (current target → simulated camera position with stiffness/damping). More cinematic ease-in/out, but introduces tuning surface (stiffness, damping, mass) that needs iteration on real footage. Park as future work; revisit if A still feels mechanical.
2. **Wider Gaussian smoothing window** (e.g., 11–15 samples instead of 5) on top of interpolation. Makes the camera lazier. Easy to add later as a follow-up if the user wants more lag — does not conflict with this design.
3. **Bezier / cubic interpolation between keyframes** instead of linear. Smoother acceleration but visually indistinguishable from linear at 30 fps when the keyframe interval is only 0.5s. Not worth the complexity.

## Rollback

Single-file revert restores the original step-jump behavior. No data format change, no migration.
