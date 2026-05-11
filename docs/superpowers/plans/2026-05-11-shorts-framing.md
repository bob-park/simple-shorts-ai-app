# Shorts Framing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 240px top and bottom black bars around the rendered short, drawing the highlight title in the top bar and existing word-level subtitles in the bottom bar — both through one ASS file via libass.

**Architecture:** A new shared module `src/shared/shortLayout.ts` exposes the canvas constants (1080×1920 output, 240/240 bars, 1080×1440 video region) and the crop aspect numerator/denominator (3/4, was 9/16). `RenderService`, `SendcmdGenerator`, and `SubtitleGenerator` all read from it. The ffmpeg vf chain gains `,pad=1080:1920:0:240:black` after the scale step. The `subtitles` filter is always applied (the ASS file is always written) so the title — added as a full-duration Dialogue line under a new `Title` style — is rendered on every clip.

**Tech Stack:** TypeScript, Vitest, ffmpeg (`crop` / `scale` / `pad` / `subtitles` / `sendcmd` filters), libass (ASS file format).

**Spec:** `docs/superpowers/specs/2026-05-11-shorts-framing-design.md`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/shared/shortLayout.ts` | Single source of truth for output canvas + crop aspect constants. | **CREATE** |
| `src/main/services/SendcmdGenerator.ts` | Emit sendcmd file for face-tracking crop. | MODIFY: replace hardcoded `9/16` with `VIDEO_CROP_NUM/VIDEO_CROP_DEN` from shortLayout; update error message. |
| `src/main/services/SendcmdGenerator.test.ts` | Tests for SendcmdGenerator. | MODIFY: update cropW (607 → 810) / maxX (1313 → 1110) expected values; update error-message regex (`9:16` → `3:4`). |
| `src/main/services/SubtitleGenerator.ts` | Build the ASS file content for the `subtitles` filter. | MODIFY: add `titleText` parameter to `buildAssFile`; add `Title` style row; emit full-duration `Title` Dialogue line; remove empty-string early returns; change Default `MarginV` 200 → 120. |
| `src/main/services/SubtitleGenerator.test.ts` | Tests for SubtitleGenerator. | MODIFY: thread `titleText` arg through every `buildAssFile` call; rewrite the two "returns empty string" tests; add Title-style and Title-dialogue assertions; assert MarginV=120 for Default. |
| `src/main/services/RenderService.ts` | Build ffmpeg argv per clip; orchestrate sendcmd + ASS writes. | MODIFY: use shortLayout constants in crop/scale/pad expressions; append `pad=1080:1920:0:240:black` to vf chain; rename `maybeWriteSubtitles` → `writeAssFile` and always call it; always append `subtitles=` to vf chain. Keep retry-without-subtitles fallback. |
| `src/main/services/RenderService.test.ts` | Tests for RenderService. | MODIFY: update every vf-chain expected string to include `scale=1080:1440,pad=1080:1920:0:240:black`; change `crop=ih*9/16` → `crop=ih*3/4`; add assertions that ASS is always written and `subtitles=` always present; keep semantic of `RenderClipResult.subtitles=null` when `cueCount===0`. |

No other files are touched. The Highlight schema and the LLM prompts are unchanged — the existing `Highlight.title` is passed through to the ASS writer.

---

### Task 1: Add layout constants and thread through SendcmdGenerator

**Files:**
- Create: `src/shared/shortLayout.ts`
- Modify: `src/main/services/SendcmdGenerator.ts`
- Modify: `src/main/services/SendcmdGenerator.test.ts`

- [ ] **Step 1: Create the new constants module**

Create `src/shared/shortLayout.ts` with this exact content:

```ts
/**
 * Output canvas + crop-aspect constants for the rendered 9:16 short.
 *
 * The short has 240px black bars at top and bottom (for the title and the
 * burned-in subtitle), so the inner video region is 1080×1440 (3:4 aspect)
 * even though the final canvas is 1080×1920. Source video is cropped to
 * `ih * VIDEO_CROP_NUM / VIDEO_CROP_DEN : ih` (= 3:4 when num/den = 3/4)
 * and scaled into the inner region, then padded out to 1080×1920.
 *
 * Single source of truth — imported by RenderService (argv builder) and
 * SendcmdGenerator (cropW calculation for face tracking).
 */
export const SHORT_LAYOUT = {
  outputWidth: 1080,
  outputHeight: 1920,
  topBarHeight: 240,
  bottomBarHeight: 240,
  videoHeight: 1440, // outputHeight - topBarHeight - bottomBarHeight
} as const;

/** crop = ih * VIDEO_CROP_NUM / VIDEO_CROP_DEN : ih. 3/4 today (was 9/16). */
export const VIDEO_CROP_NUM = 3;
export const VIDEO_CROP_DEN = 4;
```

- [ ] **Step 2: Update SendcmdGenerator.test.ts expectations BEFORE touching the implementation**

Open `src/main/services/SendcmdGenerator.test.ts` and apply these exact edits — they recalculate cropW from 9:16 to 3:4 expectations. Run the unmodified file's tests after each edit to confirm only the targeted tests fail.

Calculations (for source 1920×1080):
- New cropW = `floor(1080 * 3/4) = 810` (was 607)
- New halfCrop = `810 / 2 = 405` (was 303.5)
- New maxX = `1920 - 810 = 1110` (was 1313)

Edit #1 — "interpolates 30 fps lines..." test, replace the inline comment + assertions for first and trailing lines:

```ts
    // First line: alpha = 0 → exact frame 0.
    expect(lines[0]!.t).toBeCloseTo(0, 5);
    // crop_w = floor(1080 * 3/4) = 810. round(960 - 405) = 555.
    expect(lines[0]!.x).toBe(555);
    // Trailing line: exact frame 1. round(1200 - 405) = 795.
    expect(lines[15]!.t).toBeCloseTo(0.5, 5);
    expect(lines[15]!.x).toBe(795);
```

Edit #2 — "linearly interpolates cx between keyframes" test, replace the midpoint comment + assertion:

```ts
    // Midpoint (alpha = 7/15) cx ≈ 960 + 240 * 7/15 = 1072 → round(1072 - 405) = 667.
    expect(lines[7]!.x).toBe(667);
```

Edit #3 — "emits exactly one line for a single keyframe" test, replace the single-line x assertion:

```ts
    expect(lines[0]!.x).toBe(555);
```

Edit #4 — "clamps interpolated steps at sourceWidth - cropW..." test, replace the inline comment + the clamped value used in every assertion:

```ts
    // crop_w = 810, max x = 1920 - 810 = 1110.
    // Interpolating cx 1900 → 2000 should clamp every step at 1110.
```

And in the for-loop body change `expect(line.x).toBe(1313);` to `expect(line.x).toBe(1110);`.

Edit #5 — "throws when source aspect ratio is already vertical" test, update the throw regex:

```ts
    expect(() => buildSendcmd(portrait, 0)).toThrow(/already 3:4 or taller/i);
```

(The portrait fixture sourceWidth=1000, sourceHeight=2000 still triggers the throw: cropW = floor(2000 * 3/4) = 1500 > 1000.)

- [ ] **Step 3: Run the test file and confirm the targeted tests fail (and only those)**

Run: `yarn test src/main/services/SendcmdGenerator.test.ts`

Expected: the five tests touched in Step 2 fail with the new expected values (e.g., `Expected: 555, Received: 657`). The other sendcmd tests (empty frames, dt=0, clamps at 0, multi-pair time rebase) continue to pass — they don't assert on absolute cropW.

If any unrelated test fails, stop and re-read the edits — there was an unintended side effect.

- [ ] **Step 4: Update SendcmdGenerator.ts to use the new constants**

Open `src/main/services/SendcmdGenerator.ts`. Replace the existing top-of-file import block + the `cropW` computation + throw with:

```ts
import { VIDEO_CROP_DEN, VIDEO_CROP_NUM } from '@shared/shortLayout';
import type { TrackResult } from '@shared/track';

const EMIT_FPS = 30;
```

(Note: the existing `import type { TrackResult }` line should remain; the new `VIDEO_CROP_*` import goes above it for the standard ordering, or wherever the existing prettier/eslint config places it. The `const EMIT_FPS = 30;` line already exists — don't duplicate it.)

Inside `buildSendcmd`, replace:

```ts
  const cropW = Math.floor((track.sourceHeight * 9) / 16);
  if (cropW > track.sourceWidth) {
    throw new Error(
      `SendcmdGenerator: source is already 9:16 or taller (sourceWidth=${track.sourceWidth}, ` +
        `sourceHeight=${track.sourceHeight}, cropW=${cropW})`,
    );
  }
```

with:

```ts
  const cropW = Math.floor((track.sourceHeight * VIDEO_CROP_NUM) / VIDEO_CROP_DEN);
  if (cropW > track.sourceWidth) {
    throw new Error(
      `SendcmdGenerator: source is already ${VIDEO_CROP_NUM}:${VIDEO_CROP_DEN} or taller ` +
        `(sourceWidth=${track.sourceWidth}, sourceHeight=${track.sourceHeight}, cropW=${cropW})`,
    );
  }
```

No other changes inside `buildSendcmd`. `halfCrop`, `pixelFromCx`, the interpolation loop, the trailing emit, all stay verbatim.

- [ ] **Step 5: Run the test file and confirm all tests pass**

Run: `yarn test src/main/services/SendcmdGenerator.test.ts`

Expected: every test in the file passes.

- [ ] **Step 6: Run typecheck**

Run: `yarn typecheck`

Expected: exit code 0. The `@shared/shortLayout` path alias should resolve (the codebase already uses `@shared/*` in other imports, so the alias is already configured).

- [ ] **Step 7: Commit**

```bash
git add src/shared/shortLayout.ts src/main/services/SendcmdGenerator.ts src/main/services/SendcmdGenerator.test.ts
git commit -m "$(cat <<'EOF'
feat(layout): introduce shortLayout constants + switch sendcmd to 3:4 crop

Adds src/shared/shortLayout.ts as the single source of truth for the
1080x1920 output canvas, the 240/240 black-bar heights, the 1080x1440
inner video region, and the crop aspect numerator/denominator (3/4).

SendcmdGenerator now reads VIDEO_CROP_NUM/DEN from shortLayout instead
of hardcoding 9/16. For 1920x1080 source the trackable x-range goes from
1313 to 1110 (cropW 607 → 810) — slightly narrower but still ample for
typical YouTube content, with the upside that more of the source frame
is visible after the wider crop.

Tests updated for the new cropW expectations and error message.

Spec at docs/superpowers/specs/2026-05-11-shorts-framing-design.md.
EOF
)"
```

---

### Task 2: SubtitleGenerator — integrate title rendering

**Files:**
- Modify: `src/main/services/SubtitleGenerator.ts`
- Modify: `src/main/services/SubtitleGenerator.test.ts`

- [ ] **Step 1: Rewrite the existing test file to thread `titleText` through every call**

Open `src/main/services/SubtitleGenerator.test.ts`. Apply these edits — they replace assertions and add new tests for title handling. The two "returns empty string" tests are removed (the new buildAssFile is never empty).

Edit #1 — top of `describe('buildAssFile', ...)`. Replace the two "returns empty string" `it(...)` blocks with two new test blocks that capture the new always-non-empty behavior, plus add a Title-style assertion test. Replace:

```ts
  it('returns empty string when no words fall inside the clip window', () => {
    const words = [w('hello', 0, 0.5), w('world', 0.5, 1.0)];
    const result = buildAssFile(words, 10, 20, STYLE);
    expect(result).toBe('');
  });

  it('returns empty string when given an empty words array', () => {
    expect(buildAssFile([], 0, 30, STYLE)).toBe('');
  });
```

with:

```ts
  it('returns a title-only ASS when no words fall inside the clip window', () => {
    const words = [w('hello', 0, 0.5), w('world', 0.5, 1.0)];
    const result = buildAssFile(words, 10, 20, STYLE, '제목');
    // Non-empty and contains Title style + Title Dialogue but no Default Dialogue.
    expect(result).not.toBe('');
    expect(result).toContain('Style: Title,');
    const dialogues = result.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(1);
    expect(dialogues[0]).toContain(',Title,제목');
  });

  it('returns a title-only ASS when given an empty words array', () => {
    const result = buildAssFile([], 0, 30, STYLE, '제목');
    expect(result).not.toBe('');
    expect(result).toContain('Style: Title,');
    const dialogues = result.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(1);
    expect(dialogues[0]).toContain(',Title,제목');
    // Title spans full clip duration (0 → 30s).
    expect(dialogues[0]).toContain('0,0:00:00.00,0:00:30.00,Title,');
  });
```

Edit #2 — update every remaining `buildAssFile(...)` call in the file to pass `'TestTitle'` as the new 5th argument. The currently-existing tests are:

- "emits a complete ASS file with [Script Info], [V4+ Styles], [Events] sections" — `buildAssFile(words, 0, 5, STYLE)` → `buildAssFile(words, 0, 5, STYLE, 'TestTitle')`
- "groups words into 2-per-cue chunks" — same
- "handles odd word counts" — same
- "rebases word timestamps to clip-relative..." — same
- "applies position=bottom → ASS Alignment 2" — same
- "applies position=middle → ASS Alignment 5" — same
- "clamps cue end to clip end when a word straddles the boundary" — same
- "applies a minimum cue duration of 0.30s..." — same
- "escapes ASS-significant characters..." — same

And inside the "groups words into 2-per-cue chunks" / "handles odd word counts" tests, the dialogue counter must now filter to **Default** style only (the Title dialogue would otherwise inflate the count). Replace `result.split('\n').filter((l) => l.startsWith('Dialogue:'))` with `result.split('\n').filter((l) => l.startsWith('Dialogue:') && l.includes(',Default,'))`.

Edit #3 — update the "emits a complete ASS file" test to also assert the Title style is present:

```ts
    expect(result).toContain('Style: Default,Pretendard,64,');
    expect(result).toContain('Style: Title,Pretendard,');
```

Edit #4 — add a new test asserting the Default `MarginV` change. Insert after the existing "applies position=middle" test:

```ts
  it('places Default style baseline inside the bottom bar (MarginV=120)', () => {
    const words = [w('hi', 0, 0.5)];
    const result = buildAssFile(words, 0, 5, STYLE, 'TestTitle');
    const defaultLine = result.split('\n').find((l) => l.startsWith('Style: Default,'))!;
    const cols = defaultLine.replace(/^Style:\s*/, '').split(',');
    // Format row: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BorderStyle,Outline,Alignment,MarginV,Encoding
    // MarginV is column 9 (index 8). Changed from 200 → 120 to land inside the 240px bottom bar.
    expect(cols[8]).toBe('120');
  });
```

Edit #5 — add a new test for the Title style row's specifics. Insert after the test added in Edit #4:

```ts
  it('emits a Title style row aligned to top-center with MarginV=140 and no outline', () => {
    const result = buildAssFile([], 0, 30, STYLE, 'TestTitle');
    const titleLine = result.split('\n').find((l) => l.startsWith('Style: Title,'))!;
    const cols = titleLine.replace(/^Style:\s*/, '').split(',');
    // Format row order is the same as Default.
    // Name=Title, Fontname=Pretendard (from STYLE.fontFamily), Fontsize=64,
    // PrimaryColour=&H00FFFFFF (white), OutlineColour=&H00000000,
    // BorderStyle=1, Outline=0, Alignment=8 (top-center), MarginV=140.
    expect(cols[0]).toBe('Title');
    expect(cols[1]).toBe('Pretendard');
    expect(cols[2]).toBe('64');
    expect(cols[3]).toBe('&H00FFFFFF');
    expect(cols[6]).toBe('0'); // outline width 0
    expect(cols[7]).toBe('8'); // top-center alignment
    expect(cols[8]).toBe('140');
  });
```

Edit #6 — add a test asserting the title text is ASS-escaped:

```ts
  it('escapes ASS-significant characters in the title text', () => {
    const result = buildAssFile([], 0, 5, STYLE, 'a{b}\\c');
    const titleDialogue = result
      .split('\n')
      .find((l) => l.startsWith('Dialogue:') && l.includes(',Title,'))!;
    // { and } escaped to \{ \}; backslash escaped to \\.
    expect(titleDialogue).toContain(',Title,a\\{b\\}\\\\c');
  });
```

(The double-escaped `\\\\` in the JS string literal expands to two literal backslashes in the comparison string — matching `\\` in the ASS file, which is the escape sequence for a literal `\`.)

- [ ] **Step 2: Run the test file and confirm the new tests fail with the expected mismatch**

Run: `yarn test src/main/services/SubtitleGenerator.test.ts`

Expected: many tests fail. Specifically:
- The two replaced "title-only" tests fail because `buildAssFile` doesn't accept a 5th arg yet (TypeScript error or runtime "Title" not in output)
- The new MarginV / Title-style / title-escape tests fail similarly
- Existing tests fail because they now pass `'TestTitle'` as a 5th arg that the impl ignores

If tests *pass*, the test rewrite missed an assertion — re-read the edits.

- [ ] **Step 3: Update SubtitleGenerator.ts — add titleText param + Title style + Title Dialogue + MarginV change**

Open `src/main/services/SubtitleGenerator.ts`. Apply the following edits exactly.

Edit #1 — change the `MARGIN_V` constant value. Replace:

```ts
const MARGIN_V = 200;
```

with:

```ts
/** Default style baseline distance from frame bottom, in 1920-canvas px.
 *  120 places the bottom-aligned subtitle inside the 240px bottom bar. */
const MARGIN_V = 120;
/** Title style baseline distance from frame top, in 1920-canvas px.
 *  140 places the top-aligned title near the vertical center of the 240px top bar. */
const TITLE_MARGIN_V = 140;
const TITLE_FONT_SIZE = 64;
```

Edit #2 — update `buildAssFile` signature and body. Replace the entire function body (the existing JSDoc above it stays in place; we'll update it in the next edit) with:

```ts
export function buildAssFile(
  words: Word[],
  clipStartSec: number,
  clipEndSec: number,
  style: SubtitleStyle,
  titleText: string,
): string {
  const inWindow = words.filter((w) => w.start < clipEndSec && w.end > clipStartSec);

  const cues: { startSec: number; endSec: number; text: string }[] = [];
  for (let i = 0; i < inWindow.length; i += WORDS_PER_CUE) {
    const group = inWindow.slice(i, i + WORDS_PER_CUE);
    const startRel = Math.max(0, group[0]!.start - clipStartSec);
    const endRel = Math.min(clipEndSec - clipStartSec, group[group.length - 1]!.end - clipStartSec);
    const endSec = Math.max(endRel, MIN_CUE_DURATION_SEC);
    cues.push({
      startSec: startRel,
      endSec,
      text: group.map((g) => escapeAssText(g.text)).join(' '),
    });
  }

  const alignment = style.position === 'middle' ? 5 : 2;
  const fillAss = hexToAssColor(style.fillColor);
  const outlineAss = hexToAssColor(style.outlineColor);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${PLAY_RES_X}`,
    `PlayResY: ${PLAY_RES_Y}`,
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Alignment, MarginV, Encoding',
    `Style: Default,${style.fontFamily},${style.fontSize},${fillAss},${outlineAss},1,${OUTLINE_WIDTH},${alignment},${MARGIN_V},1`,
    `Style: Title,${style.fontFamily},${TITLE_FONT_SIZE},&H00FFFFFF,&H00000000,1,0,8,${TITLE_MARGIN_V},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Text',
  ].join('\n');

  const clipDurationSec = Math.max(0, clipEndSec - clipStartSec);
  const titleDialogue = `Dialogue: 0,${formatAssTime(0)},${formatAssTime(clipDurationSec)},Title,${escapeAssText(titleText)}`;

  const subtitleDialogues = cues
    .map((c) => `Dialogue: 0,${formatAssTime(c.startSec)},${formatAssTime(c.endSec)},Default,${c.text}`)
    .join('\n');

  const body = subtitleDialogues.length > 0 ? `${titleDialogue}\n${subtitleDialogues}` : titleDialogue;
  return `${header}\n${body}\n`;
}
```

Edit #3 — update the JSDoc above `buildAssFile` to reflect the new behavior. Replace:

```ts
/**
 * Build a complete .ass file content string (libass-compatible) from a list
 * of word-timed transcript entries. Filters to the clip window, groups into
 * 2-word cues, rebases timestamps clip-relative, and emits one Dialogue line
 * per cue. Returns an empty string when no words fall in the window so the
 * caller can skip writing the file + appending the subtitles filter.
 */
```

with:

```ts
/**
 * Build a complete .ass file content string (libass-compatible). Always
 * non-empty: emits a `Title` style + a full-clip-duration Dialogue line
 * carrying `titleText` (rendered in the 240px top bar), and a `Default`
 * style + per-cue word-level subtitles (rendered in the 240px bottom bar)
 * when `words` contains entries inside `[clipStartSec, clipEndSec]`.
 *
 * Word cues group into 2-word chunks, rebase timestamps clip-relative, and
 * are clamped to `[0, clipEndSec - clipStartSec]`. Very short stutter words
 * are padded to `MIN_CUE_DURATION_SEC` for readability.
 */
```

- [ ] **Step 4: Run the test file and confirm all tests pass**

Run: `yarn test src/main/services/SubtitleGenerator.test.ts`

Expected: every test in the file passes.

- [ ] **Step 5: Run typecheck**

Run: `yarn typecheck`

Expected: exit code 0. Other callers of `buildAssFile` (only `RenderService.maybeWriteSubtitles`) will fail typecheck because they don't pass the 5th arg yet — that's expected. **STOP** if any non-RenderService file errors; investigate before continuing. The expected RenderService error is fixed in Task 3.

If RenderService is the only file with errors, proceed to commit.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/SubtitleGenerator.ts src/main/services/SubtitleGenerator.test.ts
git commit -m "$(cat <<'EOF'
feat(subtitles): bake the highlight title into the ASS file

buildAssFile now always returns a non-empty ASS containing:

  - a `Title` style row (top-center, alignment=8, fontsize=64, outline=0,
    MarginV=140, white-on-black) + a single Dialogue line spanning the
    full clip duration carrying the highlight title
  - the existing `Default` style with MarginV changed 200 → 120 so the
    word-level subtitle now lands inside the 240px bottom bar (the
    previous 200 was tuned for the full-bleed 9:16 layout)
  - word-cue Dialogue lines, unchanged

The title is ASS-escaped via the same `escapeAssText` helper used for
word text. Long titles wrap automatically via the existing WrapStyle=2.

RenderService still needs to pass the title through — typecheck will
error there until Task 3 lands. Intentional.

Spec at docs/superpowers/specs/2026-05-11-shorts-framing-design.md.
EOF
)"
```

---

### Task 3: RenderService — framed pipeline (pad + always-on ASS)

**Files:**
- Modify: `src/main/services/RenderService.ts`
- Modify: `src/main/services/RenderService.test.ts`

- [ ] **Step 1: Update RenderService.test.ts vf-chain expected strings**

Open `src/main/services/RenderService.test.ts`. Every place that asserts on the `-vf` argv slot currently expects a string ending in `crop=ih*9/16:ih,scale=1080:1920` (center-crop case) or `crop@c=ih*9/16:ih:0:0,scale=1080:1920` (sendcmd case). The new expectations include the wider crop, the new scale target, and the pad filter. Apply the global pattern below as a search-and-replace, then verify each occurrence.

**Search-and-replace within `RenderService.test.ts`:**

Replace every occurrence of:
```
crop=ih*9/16:ih,scale=1080:1920
```
with:
```
crop=ih*3/4:ih,scale=1080:1440,pad=1080:1920:0:240:black
```

And every occurrence of:
```
crop@c=ih*9/16:ih:0:0,scale=1080:1920
```
with:
```
crop@c=ih*3/4:ih:0:0,scale=1080:1440,pad=1080:1920:0:240:black
```

These two patterns appear in:
- "builds ffmpeg args with select-filter cuts..." (one match)
- "uses sendcmd args when tracker returns frames..." (one match — the `crop@c=` form)
- "falls back to center crop when tracker returns empty frames" (one match)
- "falls back to center crop when tracker.track throws" (one match)
- "falls back to center crop when buildSendcmd throws" (one match)
- "writes .ass file and appends subtitles= to filter chain..." (the `subtitles=...` line; the leading part now contains the new pad)
- "skips ass writing + filter when subtitleOptions is undefined" (this test will need a fuller rewrite — see Edit #2)
- "skips ass writing when no transcript words fall inside the clip window" (rewrite — Edit #3)
- "retries clip without subtitles filter when ffmpeg lacks libass" (the retry args)
- "multi-segment highlight builds select filter with multiple between() ranges"

After this textual swap, several tests now describe behavior that has changed (the always-on ASS). Apply the targeted rewrites below.

Edit #2 — Rewrite "builds ffmpeg args with select-filter cuts...". The current expectation does not include `,subtitles=...` because no subtitleOptions are passed; but the new behavior ALWAYS adds subtitles, even title-only. Update:

Old assertion:
```ts
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "select='between(t,5,35)',setpts=N/FRAME_RATE/TB,crop=ih*9/16:ih,scale=1080:1920",
    );
```
New assertion:
```ts
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "select='between(t,5,35)',setpts=N/FRAME_RATE/TB,crop=ih*3/4:ih,scale=1080:1440,pad=1080:1920:0:240:black,subtitles=filename='/tmp/out/short_1.ass'",
    );
```

This test no longer passes `transcriptWords` or `subtitleOptions` — that's still OK; the ASS file still gets written (title-only) and the subtitles filter still applies. Update the test's `service.render({...})` call to use the **constructor-injected** fs mock so the ASS write is observable. The current test creates the service with no `fs` injection:

```ts
    service = new RenderService(runner as never);
```

Change `beforeEach` to inject a fake fs everywhere in this top-level `describe('RenderService', ...)` block:

```ts
  let run: ReturnType<typeof vi.fn>;
  let runner: { run: typeof run };
  let writeFile: ReturnType<typeof vi.fn>;
  let service: RenderService;

  beforeEach(() => {
    run = vi.fn();
    runner = { run };
    writeFile = vi.fn(async (_path: string, _content: string, _enc?: string) => undefined);
    service = new RenderService(runner as never, { fs: { writeFile } as never });
  });
```

And in the "builds ffmpeg args..." test, after `await promise;`, add:

```ts
    // ASS file always written (title-only when no transcript words / options provided)
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0]).toBe('/tmp/out/short_1.ass');
    expect(writeFile.mock.calls[0]![1] as string).toContain('Style: Title,');
```

Edit #3 — Rewrite "skips ass writing + filter when subtitleOptions is undefined" → "writes title-only ass when subtitleOptions undefined". The "skip" semantics are gone. Replace the entire test body with:

```ts
  it('writes title-only ass + subtitles filter when subtitleOptions is undefined', async () => {
    const writeFile = vi.fn(async (_path: string, _content: string, _enc?: string) => undefined);
    const fs = { writeFile };
    const service = new RenderService(runner as never, { fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 30)],
      transcriptWords: fakeWords([{ text: 'hi', start: 0, end: 0.5 }]),
      // subtitleOptions intentionally omitted
    });
    h._resolve();
    const result = await promise;

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0]).toBe('/tmp/out/short_1.ass');
    const ass = writeFile.mock.calls[0]![1] as string;
    expect(ass).toContain('Style: Title,');
    // No Default-style Dialogue (no subtitleOptions → no word cues are emitted by RenderService)
    expect(ass).not.toContain(',Default,');

    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "select='between(t,0,30)',setpts=N/FRAME_RATE/TB,crop=ih*3/4:ih,scale=1080:1440,pad=1080:1920:0:240:black,subtitles=filename='/tmp/out/short_1.ass'",
    );
    // RenderClipResult.subtitles → null because no word cues were emitted.
    expect(result.results[0]!.subtitles).toBeNull();
  });
```

Edit #4 — Rewrite "skips ass writing when no transcript words fall inside the clip window" → "writes title-only ass when no words in window":

```ts
  it('writes title-only ass when no transcript words fall inside the clip window', async () => {
    const writeFile = vi.fn(async (_path: string, _content: string, _enc?: string) => undefined);
    const fs = { writeFile };
    const service = new RenderService(runner as never, { fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 100, 130)],
      transcriptWords: fakeWords([{ text: 'hi', start: 0, end: 0.5 }]), // outside [100, 130]
      subtitleOptions: SUBTITLE_OPTS,
    });
    h._resolve();
    const result = await promise;

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0]).toBe('/tmp/out/short_1.ass');
    const ass = writeFile.mock.calls[0]![1] as string;
    expect(ass).toContain('Style: Title,');
    expect(ass).not.toContain(',Default,'); // no word cues fell in window

    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "select='between(t,100,130)',setpts=N/FRAME_RATE/TB,crop=ih*3/4:ih,scale=1080:1440,pad=1080:1920:0:240:black,subtitles=filename='/tmp/out/short_1.ass'",
    );
    expect(result.results[0]!.subtitles).toBeNull();
  });
```

Edit #5 — Update "retries clip without subtitles filter when ffmpeg lacks libass...". The retry args should now be the new framed chain *without* `,subtitles=...`. And the second clip's ASS is now ALSO written (title-only) — but its filter chain has no subtitles= because the service flag is set after the first failure. The test expectation that clip2's .ass is NOT written needs to flip:

In the test body, **remove** these two assertions:
```ts
    expect(writePaths).toContain('/tmp/out/short_1.ass');
    expect(writePaths).not.toContain('/tmp/out/short_2.ass');
```

And **replace** with:
```ts
    // Both clips' ASS files are written (we don't gate writing on the libass
    // flag — only the filter application). The harmless leftovers are fine.
    expect(writePaths).toContain('/tmp/out/short_1.ass');
    expect(writePaths).toContain('/tmp/out/short_2.ass');
```

The retry args expectations (the two `expect(retryArgs...)` / `expect(clip2Args...)` blocks) get the chain swap from the search-and-replace at the top of this step.

Edit #6 — Update "writes .ass file and appends subtitles=..." test. The `subtitles` field expectation when one word cue is in window stays unchanged (`{ cues: 1, assPath: ... }`); the vf chain gets the swap.

Edit #7 — For the multi-segment test, the swap takes care of the vf chain. No other change needed.

- [ ] **Step 2: Run the test file and confirm tests fail with the new expected strings**

Run: `yarn test src/main/services/RenderService.test.ts`

Expected: most tests fail with mismatches on the vf-chain string and on the ASS file write count. The "ASS file always written" assertions also fail because the current implementation gates the write. This is the failing-test state for TDD.

- [ ] **Step 3: Update RenderService.ts — use shortLayout constants, add pad, always write ASS**

Open `src/main/services/RenderService.ts`. Apply these edits.

Edit #1 — add the import for the layout constants. Add to the top of the file's import block:

```ts
import { SHORT_LAYOUT, VIDEO_CROP_DEN, VIDEO_CROP_NUM } from '@shared/shortLayout';
```

Edit #2 — replace the bottom three argv-builder functions (`buildVfChain`, `buildCenterArgs`, `buildTrackedArgs`). Replace:

```ts
function buildVfChain(segments: HighlightSegment[], cropClause: string): string {
  return `select='${buildSelectExpr(segments)}',setpts=N/FRAME_RATE/TB,${cropClause},scale=1080:1920`;
}

function buildAfChain(segments: HighlightSegment[]): string {
  return `aselect='${buildSelectExpr(segments)}',asetpts=N/SR/TB`;
}

function buildCenterArgs(sourcePath: string, segments: HighlightSegment[], outputPath: string): string[] {
  return [
    '-y',
    '-i',
    sourcePath,
    '-vf',
    buildVfChain(segments, 'crop=ih*9/16:ih'),
    '-af',
    buildAfChain(segments),
    ...COMMON_ENCODE_ARGS,
    outputPath,
  ];
}

function buildTrackedArgs(
  sourcePath: string,
  segments: HighlightSegment[],
  outputPath: string,
  cmdPath: string,
): string[] {
  const cropClause = `sendcmd=f=${cmdPath},crop@c=ih*9/16:ih:0:0`;
  return [
    '-y',
    '-i',
    sourcePath,
    '-vf',
    buildVfChain(segments, cropClause),
    '-af',
    buildAfChain(segments),
    ...COMMON_ENCODE_ARGS,
    outputPath,
  ];
}
```

with:

```ts
const CROP_CENTER_EXPR = `crop=ih*${VIDEO_CROP_NUM}/${VIDEO_CROP_DEN}:ih`;
const CROP_TRACKED_RHS = `crop@c=ih*${VIDEO_CROP_NUM}/${VIDEO_CROP_DEN}:ih:0:0`;
const SCALE_EXPR = `scale=${SHORT_LAYOUT.outputWidth}:${SHORT_LAYOUT.videoHeight}`;
const PAD_EXPR = `pad=${SHORT_LAYOUT.outputWidth}:${SHORT_LAYOUT.outputHeight}:0:${SHORT_LAYOUT.topBarHeight}:black`;

function buildVfChain(segments: HighlightSegment[], cropClause: string): string {
  return `select='${buildSelectExpr(segments)}',setpts=N/FRAME_RATE/TB,${cropClause},${SCALE_EXPR},${PAD_EXPR}`;
}

function buildAfChain(segments: HighlightSegment[]): string {
  return `aselect='${buildSelectExpr(segments)}',asetpts=N/SR/TB`;
}

function buildCenterArgs(sourcePath: string, segments: HighlightSegment[], outputPath: string): string[] {
  return [
    '-y',
    '-i',
    sourcePath,
    '-vf',
    buildVfChain(segments, CROP_CENTER_EXPR),
    '-af',
    buildAfChain(segments),
    ...COMMON_ENCODE_ARGS,
    outputPath,
  ];
}

function buildTrackedArgs(
  sourcePath: string,
  segments: HighlightSegment[],
  outputPath: string,
  cmdPath: string,
): string[] {
  const cropClause = `sendcmd=f=${cmdPath},${CROP_TRACKED_RHS}`;
  return [
    '-y',
    '-i',
    sourcePath,
    '-vf',
    buildVfChain(segments, cropClause),
    '-af',
    buildAfChain(segments),
    ...COMMON_ENCODE_ARGS,
    outputPath,
  ];
}
```

Edit #3 — refactor the subtitle-writing path. Inside `render()`, replace the existing subtitle block:

```ts
      const subtitlesInfo =
        opts.subtitleOptions && opts.transcriptWords && !this.subtitlesUnavailable
          ? await this.maybeWriteSubtitles(opts, h, clipIndex, durationSec)
          : null;
      const args = subtitlesInfo ? appendSubtitleFilter(baseArgs, subtitlesInfo.assPath) : baseArgs;
```

with:

```ts
      // ASS file is always written — it carries the title-bar text even when
      // no transcript words / no subtitleOptions are provided.
      const assInfo = await this.writeAssFile(opts, h, clipIndex, durationSec);
      const args = this.subtitlesUnavailable
        ? baseArgs
        : appendSubtitleFilter(baseArgs, assInfo.assPath);
      // For the user-facing RenderClipResult.subtitles field, only report a
      // populated subtitles record when at least one word cue was emitted —
      // a title-only ASS still has cueCount=0 and shouldn't appear as
      // "subtitles were rendered" from the user's perspective.
      const reportedSubtitles = assInfo.cueCount > 0 ? assInfo : null;
```

And update the subsequent `results.push(...)` calls inside the same try / catch / retry-fallback so they pass `reportedSubtitles` instead of `subtitlesInfo`. Specifically:

- The success-path `results.push(this.buildClipResult(...))` — pass `reportedSubtitles` as the 6th positional arg (or whatever your impl uses for the subtitles field). Keep existing tracking arg.
- The retry-without-subtitles path — pass `null` for subtitles (matches current behavior; in this path the .ass file was still written but the filter isn't applied).
- The failed path — already passes nothing/null.

The complete replacement block (replace from `try {` through the matching `} finally`):

```ts
      try {
        await handle.done;
        results.push(
          this.buildClipResult(
            clipIndex,
            h,
            'done',
            outputPath,
            undefined,
            trackingInfo ? { frames: trackingInfo.frameCount, trackPath: trackingInfo.trackPath } : null,
            reportedSubtitles,
          ),
        );
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        if (this.canceled || /canceled/i.test(message)) {
          results.push(this.buildClipResult(clipIndex, h, 'canceled', undefined, 'Render canceled'));
        } else if (!this.subtitlesUnavailable && /No such filter: ['"]subtitles['"]/.test(message)) {
          this.subtitlesUnavailable = true;
          this.activeHandle = null;
          const retryHandle = this.runner.run({ args: baseArgs, durationSec });
          this.activeHandle = retryHandle;
          retryHandle.onProgress((fraction) => {
            for (const cb of this.progressHandlers) {
              cb({ clipIndex, clipTotal: total, fraction });
            }
          });
          try {
            await retryHandle.done;
            results.push(
              this.buildClipResult(
                clipIndex,
                h,
                'done',
                outputPath,
                undefined,
                trackingInfo ? { frames: trackingInfo.frameCount, trackPath: trackingInfo.trackPath } : null,
                null,
              ),
            );
          } catch (retryErr: unknown) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            results.push(this.buildClipResult(clipIndex, h, 'failed', undefined, retryMsg));
          }
        } else {
          results.push(this.buildClipResult(clipIndex, h, 'failed', undefined, message));
        }
      } finally {
        this.activeHandle = null;
      }
```

(The only substantive change in this block vs the prior implementation is the existing `subtitlesInfo` references become `reportedSubtitles`, plus the retry-detection guard now also checks `!this.subtitlesUnavailable` so we don't enter the retry path twice on the same clip.)

Edit #4 — rename `maybeWriteSubtitles` → `writeAssFile` and make it always produce a result. Replace the existing method:

```ts
  private async maybeWriteSubtitles(
    opts: RenderOptions,
    h: Highlight,
    clipIndex: number,
    montageDuration: number,
  ): Promise<{ assPath: string; cueCount: number } | null> {
    if (!opts.subtitleOptions || !opts.transcriptWords) return null;
    const rebased = rebaseTranscriptWords(h.segments, opts.transcriptWords);
    if (rebased.length === 0) return null;
    const assContent = buildAssFile(rebased, 0, montageDuration, opts.subtitleOptions);
    if (assContent === '') return null;
    const assPath = join(opts.outputDir, `short_${clipIndex}.ass`);
    await this.fs.writeFile(assPath, assContent, 'utf8');
    const cueCount = (assContent.match(/^Dialogue:/gm) ?? []).length;
    return { assPath, cueCount };
  }
```

with:

```ts
  /** Default subtitle style used when the caller doesn't pass `subtitleOptions`.
   *  Only the Title style row consumes these fields in the title-only path —
   *  values are harmless placeholders for Default since no word cues exist. */
  private static readonly DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
    fontFamily: 'Pretendard',
    fontSize: 64,
    fillColor: '#FFFFFF',
    outlineColor: '#000000',
    position: 'bottom',
  };

  private async writeAssFile(
    opts: RenderOptions,
    h: Highlight,
    clipIndex: number,
    montageDuration: number,
  ): Promise<{ assPath: string; cueCount: number }> {
    const style = opts.subtitleOptions ?? RenderService.DEFAULT_SUBTITLE_STYLE;
    const words = opts.subtitleOptions && opts.transcriptWords
      ? rebaseTranscriptWords(h.segments, opts.transcriptWords)
      : [];
    const assContent = buildAssFile(words, 0, montageDuration, style, h.title);
    const assPath = join(opts.outputDir, `short_${clipIndex}.ass`);
    await this.fs.writeFile(assPath, assContent, 'utf8');
    // Count Default-style Dialogue lines only — the Title Dialogue line is
    // always present and not user-visible "subtitle cue" data.
    const cueCount = (assContent.match(/^Dialogue:.*,Default,/gm) ?? []).length;
    return { assPath, cueCount };
  }
```

(Note: the new `cueCount` regex matches Default-style Dialogue rows only, so the title line does not inflate the count and the existing `subtitles: { cues: 1, assPath }` test assertion continues to hold for the one-word case.)

Edit #5 — update the import of `SubtitleStyle` at the top of the file if it's not already imported. Look for `import { type SubtitleStyle, buildAssFile } from './SubtitleGenerator';` — that line should already exist. No change.

Edit #6 — the `subtitlesUnavailable` instance field stays. No change.

- [ ] **Step 4: Run the test file**

Run: `yarn test src/main/services/RenderService.test.ts`

Expected: every test passes.

If a test fails with a vf-chain string mismatch, recheck the search-and-replace in Step 1 — there may be an unhandled location.

If "RenderClipResult.subtitles" assertions fail, recheck Edit #3 in Step 3 — the `reportedSubtitles` calculation should produce `null` when `cueCount === 0` and the populated object when `cueCount > 0`.

- [ ] **Step 5: Run typecheck + the full suite**

Run: `yarn typecheck && yarn test`

Expected: typecheck exits 0; every test in every file passes.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/RenderService.ts src/main/services/RenderService.test.ts
git commit -m "$(cat <<'EOF'
feat(render): frame the short with 240px top/bottom black bars

The vf chain now ends with scale=1080:1440,pad=1080:1920:0:240:black —
the source is cropped 3:4 (wider than the prior 9:16), scaled into the
1080x1440 inner region, then padded out to the 1080x1920 canvas with
240px black bars top and bottom.

The ASS file is now always written (carries the title) and the
subtitles= filter is always applied; the existing libass-fallback path
still degrades cleanly to bare framed video when subtitles= is
unavailable. RenderClipResult.subtitles continues to be null when no
word cues are emitted, even though the .ass file is on disk — the
field describes user-meaningful subtitle state, not internal artifacts.

The renamed writeAssFile method always returns a result; the
maybeWriteSubtitles name implied optionality that no longer exists.

Spec at docs/superpowers/specs/2026-05-11-shorts-framing-design.md.
EOF
)"
```

---

### Task 4: Push and verify manually

This task is **for the user, not an autonomous subagent**. Document it in the report and skip execution.

- [ ] **Step 1: Push to remote**

```bash
git push origin master
```

- [ ] **Step 2: Run the dev app**

```bash
yarn dev
```

- [ ] **Step 3: Paste a YouTube URL, run download → transcribe → highlight → render**

The render should produce `short_1.mp4`, `short_2.mp4`, etc. under the configured output directory.

- [ ] **Step 4: Open the rendered mp4 in QuickTime and verify**

1. **Top 240px:** solid black bar with the highlight title centered in white. Korean characters render correctly.
2. **Middle 1080×1440:** video content with no horizontal black bands. The source has been cropped 3:4 and scaled up.
3. **Bottom 240px:** solid black bar with the word-level subtitle in white (when subtitles are enabled in Settings).
4. **Face-tracked clip:** the inner video glides horizontally with the speaker; no half-second step jumps.

- [ ] **Step 5: Disable subtitles in Settings and re-render**

Top bar still shows title. Bottom bar is solid black with no text.

- [ ] **Step 6: Pick a highlight with a long title (~50+ chars) and re-render**

Title wraps to 2 lines within the 240px top bar. Lines may visually overflow at 3+ lines — acceptable for v1 per the spec.

If any of (4)–(6) fail or look visually wrong, do NOT close the spec — re-open it and treat as a v2 follow-up.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Where implemented |
|---|---|
| New `src/shared/shortLayout.ts` module + constants | Task 1, Step 1 |
| `SendcmdGenerator` uses constants, error message updated | Task 1, Step 4 |
| `SendcmdGenerator` tests reflect new cropW / maxX | Task 1, Step 2 |
| `buildAssFile` gains `titleText` arg | Task 2, Step 3, Edit #2 |
| Title style row (alignment=8, MarginV=140, fontsize=64, outline=0, white) | Task 2, Step 3, Edit #2 |
| Full-duration Title Dialogue line | Task 2, Step 3, Edit #2 |
| Default `MarginV: 200 → 120` | Task 2, Step 3, Edit #1 |
| Empty-string early return removed | Task 2, Step 3, Edit #2 (no `return ''` lines) |
| `SubtitleGenerator` tests for title style + dialogue + escape + MarginV | Task 2, Step 1, Edits #4–6 |
| Default style `MarginV=120` tested | Task 2, Step 1, Edit #4 |
| `RenderService.buildVfChain` appends scale=1080:1440 + pad=1080:1920 | Task 3, Step 3, Edit #2 |
| `RenderService.buildCenterArgs` / `buildTrackedArgs` use new crop expr | Task 3, Step 3, Edit #2 |
| `RenderService` always writes ASS via `writeAssFile` | Task 3, Step 3, Edits #3 + #4 |
| `RenderService` always appends `subtitles=` (except libass fallback) | Task 3, Step 3, Edit #3 |
| `RenderClipResult.subtitles=null` when cueCount=0 preserved | Task 3, Step 3, Edit #3 (`reportedSubtitles` logic) |
| Libass-unavailable fallback preserved | Task 3, Step 3, Edit #3 (retry block kept verbatim except null subtitles arg) |
| `RenderService` tests for new chain + always-ASS + null-subtitles-when-zero-cues | Task 3, Step 1, Edits #2–6 |
| Manual verification checklist | Task 4, Steps 4–6 |

All spec requirements are covered.

**2. Placeholder scan:**

No "TBD", "TODO", "implement later", or "handle edge cases" anywhere in the plan. Every step has the literal code to write, the literal search-and-replace pattern, or the literal command to run.

**3. Type / name consistency:**

- The new `writeAssFile` method name is used consistently across Edit #3 (call site) and Edit #4 (definition).
- `cueCount` field name is consistent: emitted by `writeAssFile`, consumed by `reportedSubtitles` calculation, asserted in tests.
- `RenderClipResult.subtitles` field uses `{ cues: number, assPath: string }` — the existing shape, unchanged.
- `Highlight.title` field name matches the existing schema (asserted via the `fakeHighlight` test helper which sets `title: \`H${i}\``).
- `SHORT_LAYOUT.outputHeight` / `topBarHeight` etc. are referenced consistently between `shortLayout.ts` definition and `RenderService.ts` usage.
- `VIDEO_CROP_NUM` / `VIDEO_CROP_DEN` are referenced consistently between `shortLayout.ts`, `SendcmdGenerator.ts`, and `RenderService.ts`.

No inconsistencies.

---

## Rollback

Each of Task 1, Task 2, Task 3 is one self-contained commit. If a regression is found post-merge, `git revert <hash>` on the offending commit. No data migration; existing rendered shorts on disk are untouched.
