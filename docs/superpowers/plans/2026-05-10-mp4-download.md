# Force YouTube Downloads to h264 / mp4 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin YouTube downloads to h264 (avc1) video + AAC (m4a) audio so they land as `.mp4` and gain macOS VideoToolbox hardware decode in every downstream pass.

**Architecture:** Single constant change in `src/main/services/YouTubeService.ts` — replace the `FORMAT_SELECTOR` string with one that constrains both codec and container, with two fallbacks for the rare video that lacks an avc1 stream. Update the JSDoc to reflect the new rationale. Add one unit test that asserts the new selector reaches yt-dlp via `spawn` args. Downstream stages (STT, LLM extraction, render, face tracking) are codec-agnostic and require no change.

**Tech Stack:** TypeScript, Vitest. Pure-config change to a `download()` argv builder consumed by Electron main → yt-dlp subprocess.

**Spec:** `docs/superpowers/specs/2026-05-10-mp4-download-design.md`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/main/services/YouTubeService.ts` | Build the yt-dlp argv for download + parse its output. | MODIFY: replace `FORMAT_SELECTOR` constant value, replace its JSDoc with the new rationale. |
| `src/main/services/YouTubeService.test.ts` | Unit tests for `YouTubeService`. | MODIFY: add one new test asserting the `--format` arg is the new pinned selector. Existing tests are untouched. |

No other files change. The selector string is the only externally-observable contract.

---

### Task 1: Pin downloads to h264 / mp4

**Files:**
- Modify: `src/main/services/YouTubeService.ts:57-64`
- Modify: `src/main/services/YouTubeService.test.ts` (add one test)

- [ ] **Step 1: Add the new failing test in `src/main/services/YouTubeService.test.ts`**

Insert this `it(...)` block inside the existing `describe('YouTubeService.download', ...)` block, immediately after the existing "spawns yt-dlp with the %(ext)s template…" test (the test that already inspects `spawn.mock.calls[0]?.[1]`):

```ts
it('pins format to h264 (avc1) + m4a in mp4 with sensible fallbacks', () => {
  service.download('https://youtu.be/abc', '/tmp/V', { videoId: 'abc' });
  const args = spawn.mock.calls[0]?.[1] as string[];
  const fmtIdx = args.indexOf('--format');
  expect(fmtIdx).toBeGreaterThanOrEqual(0);
  expect(args[fmtIdx + 1]).toBe('bv*[vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/b');
});
```

(The `service`, `spawn`, and `child` test fixtures are already set up in the existing `beforeEach`. No new imports needed.)

- [ ] **Step 2: Run only the new test file to confirm it fails**

Run: `yarn test src/main/services/YouTubeService.test.ts`

Expected: the new test fails with an assertion mismatch — the current selector is `'bv*+ba/b'`, not the new pinned string. All other tests in the file continue to pass (the new test is additive; no existing assertions are broken because none of them inspect the `--format` value).

If any **other** test fails at this point, stop — the test rewrite has unintended side effects and needs to be revisited before touching the implementation.

- [ ] **Step 3: Replace the `FORMAT_SELECTOR` constant and its JSDoc in `src/main/services/YouTubeService.ts`**

Find this block (lines 57–64 of the current file):

```ts
/**
 * Best video + best audio. We deliberately don't pin the container to mp4 —
 * YouTube increasingly serves AV1/VP9 in webm or mp4, and forcing mp4 either
 * triggers a remux (slow, lossy) or produces "mp4 wrapper, AV1 codec inside"
 * which fails on QuickTime. Letting yt-dlp pick the native format means the
 * file extension always matches the actual codec/container.
 */
const FORMAT_SELECTOR = 'bv*+ba/b';
```

Replace with exactly this:

```ts
/**
 * Pin to h264 (avc1) video + AAC (m4a) audio. yt-dlp merges this codec
 * pair to mp4 natively, which yields three wins on Apple Silicon:
 *
 * - macOS VideoToolbox hardware-decodes h264. VP9/AV1 (the typical webm
 *   payload) have no VT decoder, so every downstream ffmpeg/cv2 pass is
 *   software-decoded — much slower on the M-series chips we ship to.
 * - The codec is constrained to avc1, so we don't risk the "AV1 inside
 *   mp4 wrapper" QuickTime hazard that motivated the previous unpinned
 *   selector.
 * - File extension on disk is always .mp4, which matches downstream
 *   tooling expectations.
 *
 * Fallback chain (yt-dlp evaluates left to right):
 *   1. bv*[vcodec^=avc1]+ba[ext=m4a]  — adaptive avc1 video + m4a audio
 *   2. b[ext=mp4]                     — pre-merged single mp4 stream
 *   3. b                              — best of anything (rare videos
 *      with only VP9/AV1 fall back to the prior behavior here)
 *
 * Trade-off: YouTube caps avc1 at 1080p, so a 4K source downgrades to
 * 1080p. The pipeline final output is 1080×1920 (9:16 short), so this
 * is invisible to end users.
 */
const FORMAT_SELECTOR = 'bv*[vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/b';
```

Do not modify anything else in the file. The `download()` method and all other constants/exports stay as-is.

- [ ] **Step 4: Run the test file to confirm all tests pass**

Run: `yarn test src/main/services/YouTubeService.test.ts`

Expected: every test in the file passes — the new "pins format to h264…" test plus all pre-existing `download()` and `fetchMeta()` tests.

- [ ] **Step 5: Run typecheck + the full test suite to confirm no regression**

Run: `yarn typecheck && yarn test`

Expected: typecheck exits 0; the full vitest suite passes. There is no other call site that reads `FORMAT_SELECTOR` (confirm with `grep -rn "FORMAT_SELECTOR" src/main` — only the one definition and one usage inside `download()` exist).

- [ ] **Step 6: Manual verification (post-merge, by the user)**

This step is **for the user, not an autonomous subagent**. Document it in the report and skip execution:

1. Run `yarn dev` (or install the next packaged build).
2. Paste a YouTube URL, download.
3. Confirm the file lands as `<title>.mp4` (not `.webm`).
4. Run highlight extraction → render. Confirm render wall-time is noticeably faster than a prior `.webm`-source render of comparable length.
5. Confirm the rendered short plays normally with no glitched segment boundaries.

If any of (3)–(5) fail, do not commit and re-open the spec — the format selector may need a different fallback strategy.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/YouTubeService.ts src/main/services/YouTubeService.test.ts
git commit -m "$(cat <<'EOF'
fix(yt-dlp): pin YouTube downloads to h264 (avc1) + m4a in mp4

YouTube increasingly serves video as VP9/AV1 in webm. macOS has no
VideoToolbox decoder for either, so every downstream ffmpeg/cv2 pass
software-decodes the source — slow on M-series chips and the dominant
cost in render and face tracking.

Pin the selector to avc1 video + m4a audio so yt-dlp merges to mp4
natively. Hardware decode kicks in everywhere downstream. Fallback
chain (b[ext=mp4], then b) covers the rare video without an avc1
stream — behavior on those is unchanged from the prior selector.

Trade-off: avc1 caps at 1080p on YouTube. The pipeline output is
1080×1920 (9:16), so 4K sources downgrade transparently.

Spec at docs/superpowers/specs/2026-05-10-mp4-download-design.md.
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Format selector replacement → Step 3 (exact string matches the spec).
- Fallback chain documented → Step 3 JSDoc + Step 1 test asserts the exact selector string (which encodes the chain).
- JSDoc rewrite explaining VideoToolbox + AV1-in-mp4 + extension consistency → Step 3.
- Edge cases:
  - "No avc1 stream" → covered by the `b[ext=mp4]/b` fallback in the new selector. No code path change needed since yt-dlp's selector engine handles this. The JSDoc explicitly calls out the fallback behavior. Spec also notes that `--print-to-file after_move` keeps working regardless of extension, which is true because the existing test in YouTubeService.test.ts already exercises a non-mp4 extension via the `/tmp/My Video.mp4` fixture (the implementation reads the file path back from yt-dlp, not from the extension).
  - "Merge requires ffmpeg" → already handled by the existing `--ffmpeg-location` arg (M12 fix). No change to that wiring. No new task needed.
  - "OUTFILE path with .mp4 extension" → no parser change needed (the existing post-exit handler reads the printed path verbatim).
  - "Existing webm files on disk untouched" → enforced by the fact that this change affects future downloads only (no migration code).
- Performance trade-offs (download size, render speed, quality) → Step 3 JSDoc captures the user-visible trade-off (1080p cap). Detailed numbers stay in the spec — no implementation needed.
- Testing → Step 1 implements the unit test from the spec verbatim. Step 6 covers the manual verification checklist.
- Rollback → "Single-file revert" is implicit; the commit is a single self-contained change.

All spec requirements covered.

**2. Placeholder scan:** no `TBD`, no "implement later", no vague "handle edge cases" — every step has concrete code, an exact string, or a precise expected outcome.

**3. Type consistency:** the constant `FORMAT_SELECTOR` keeps the same type (`string`), name, and module-private export status. The single internal call site in `download()` (currently `args.push(..., FORMAT_SELECTOR, ...)`) needs no change. The test asserts on the runtime string value via `spawn.mock.calls[0]?.[1]`, which already passes the constant through unchanged.
