# Force YouTube Downloads to h264 / mp4

**Status:** Design approved 2026-05-10
**Scope:** Single constant change in `src/main/services/YouTubeService.ts` plus one new unit test.

## Problem

`YouTubeService.download` currently uses the format selector `'bv*+ba/b'` — best video stream + best audio stream, any container. YouTube increasingly serves video as VP9 or AV1 inside `.webm`. Downstream pipeline stages on macOS suffer:

- **ffmpeg render**: VP9/AV1 have **no VideoToolbox hardware decoder on macOS**, so every frame is software-decoded. h264 in mp4 is hardware-decoded and dramatically faster on Apple Silicon.
- **Highlight render glitches**: The user reports broken segments in `.webm` source renders. The non-contiguous `select` filter chain (M10 montage) is more sensitive to keyframe layout in VP9 than in h264.
- **File extension consistency**: Sources land as `.webm` and confuse downstream tools that infer codec from extension.

The existing comment on `FORMAT_SELECTOR` documented why mp4 wasn't pinned: forcing only the *container* to mp4 risks "AV1 codec inside mp4 wrapper", which fails QuickTime playback. The fix is to pin both the codec and the container.

## Goal

Make YouTube downloads land as h264 (`avc1`) video + AAC (`m4a`) audio in an mp4 container, so:

1. macOS hardware-decodes the source in every downstream pass.
2. The file extension on disk is always `.mp4`.
3. The "AV1-in-mp4" hazard is avoided because the codec is constrained.
4. End-to-end pipeline (download → STT → highlight → render) is faster overall on Apple Silicon.

## Non-goals

- No change to render output codec / container (already h264/mp4 via the existing render arg builders).
- No change to STT, LLM extraction, face tracking, or sendcmd logic.
- No change to `--ffmpeg-location`, `--print-to-file`, progress template, or any other `download()` flag.
- No re-encoding of already-downloaded `.webm` files. This change affects future downloads only.

## Design

### Format selector

Replace the constant:

```ts
const FORMAT_SELECTOR = 'bv*[vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/b';
```

Fallback chain (yt-dlp evaluates left to right):

1. `bv*[vcodec^=avc1]+ba[ext=m4a]` — best avc1 (h264) video stream merged with best m4a (AAC) audio stream. yt-dlp's natural merge target for this codec pair is mp4, so the resulting file is `<title>.mp4`.
2. `b[ext=mp4]` — pre-merged single mp4 stream. Lower quality but no merge needed. Catches videos where avc1 is unavailable in adaptive form but exists as a complete file.
3. `b` — best of anything. Last-resort fallback for the rare video YouTube serves only as VP9/AV1 (typically very new uploads or specific rights restrictions). Behavior matches today's selector for these.

### JSDoc rewrite

Replace the existing `FORMAT_SELECTOR` comment block. New text:

```
Pin to h264 (avc1) video + AAC (m4a) audio. yt-dlp merges this codec
pair to mp4 natively, which yields three wins on Apple Silicon:

- macOS VideoToolbox hardware-decodes h264. VP9/AV1 (the typical webm
  payload) have no VT decoder, so every downstream ffmpeg/cv2 pass is
  software-decoded — much slower on the M-series chips we ship to.
- The codec is constrained to avc1, so we don't risk the "AV1 inside
  mp4 wrapper" QuickTime hazard that motivated the previous unpinned
  selector.
- File extension on disk is always .mp4, which matches downstream
  tooling expectations.

Trade-off: YouTube caps avc1 at 1080p, so a 4K source downgrades to
1080p. The pipeline final output is 1080×1920 (9:16 short), so this
is invisible to end users. Fallbacks cover the rare video without an
avc1 stream.
```

### Edge cases

- **No avc1 stream**: yt-dlp falls back to `b[ext=mp4]` then `b`. The result behaves like today's downloads in those cases. The `--print-to-file after_move` hook still emits the actual filepath, so `capturedPath` keeps working regardless of extension.
- **Merge requires ffmpeg**: yt-dlp invokes ffmpeg to mux avc1+m4a into mp4. We already pass `--ffmpeg-location` in packaged mode (M12 fix), so the bundled ffmpeg is used. Dev mode relies on PATH ffmpeg as before.
- **OUTFILE path with `.mp4` extension**: no parser change — the after_move hook produces an absolute path with whatever extension yt-dlp chose. Same handling.
- **Existing webm files on disk**: untouched. Resume detection (M12 follow-up) keys on `videoId` and meta files, not extension.

### Performance trade-offs

- **Download size**: avc1 at 1080p is roughly 30–50 % larger than VP9 at the same resolution. Slight increase in network time and disk usage.
- **Render speed**: hardware decode is many times faster on M-series. The render stage is the dominant pipeline cost, so total wall time drops noticeably.
- **Quality**: avc1 1080p vs VP9 1080p is visually indistinguishable at typical bitrates, and the difference is invisible after the 9:16 crop and re-encode.

## Testing

Add one unit test to `src/main/services/YouTubeService.test.ts`, alongside the existing `download()` tests:

```ts
it('pins format to h264 (avc1) + m4a in mp4 with sensible fallbacks', () => {
  service.download('https://youtu.be/abc', '/tmp/V', { videoId: 'abc' });
  const args = spawn.mock.calls[0]?.[1] as string[];
  const fmtIdx = args.indexOf('--format');
  expect(fmtIdx).toBeGreaterThanOrEqual(0);
  expect(args[fmtIdx + 1]).toBe('bv*[vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/b');
});
```

Existing tests are unaffected. They assert structural args (`--output`, `--print-to-file`, `--newline`, `--progress-template`) and OUTFILE handling, none of which change.

Manual verification (post-merge):

1. Run `yarn dev`, paste a known-good YouTube URL, download.
2. Confirm the file lands as `<title>.mp4` (not `.webm`).
3. Run highlight extraction → render. Confirm render wall-time is noticeably faster than a prior `.webm` source render of comparable length.
4. Confirm rendered short plays normally (no glitched segments at boundaries).

## Rollback

Single-file revert restores the prior `bv*+ba/b` selector. Already-downloaded `.mp4` files keep working in all downstream stages (they're treated identically to `.webm` sources by ffmpeg / cv2). No data migration needed.
