# M8: Subtitle Burn-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Burn TikTok-style word-grouped subtitles into each rendered short. For each highlight, slice the M4 transcript words by the clip's `[start_sec, end_sec]` window, group into 2-word cues, and emit an ASS (Advanced SubStation Alpha) file styled by `settings.subtitles` (font, size, fill/outline color, position). The render pipeline appends `subtitles=filename=…` to the existing M7 ffmpeg filter chain so libass burns the captions in during the same single-pass render. Honors `settings.subtitles.enabled` — disabled = no ASS file written, no filter appended (preserves M7 behavior).

**Architecture:** Adds a pure `SubtitleGenerator` (analog of M7's `SendcmdGenerator`) that takes the transcript words + clip window + style options and returns ASS file content as a string. `RenderService.render()` accepts new optional `transcriptWords` + `subtitleOptions`; per clip it filters words to the clip range, calls the generator, writes `<outputDir>/short_N.ass`, and appends the subtitles filter to whichever filter chain (tracked or center-crop) is being built. The IPC handler in `main.ts` reads the same sibling `<audioPath>.transcript.json` it already reads in M5 (well, M5 reads it for highlights — M8 also wants the words array) and passes the words + the user's `settings.subtitles` config through. UI: per-clip `RenderClipResult.subtitles` field surfaces "✏️ 자막 N개 cue" in `RenderCard`.

**Tech Stack:** Pure-TypeScript ASS generation (no new npm deps; ffmpeg's libass already handles rendering). Color conversion `#RRGGBB` → ASS `&HBBGGRR`. ASS resolution pinned to 1080×1920 (matches the M7 scale output). Existing `Word` type from `src/shared/transcript.ts` is the input; existing `settings.subtitles` zod from M2 (`fontFamily`, `fontSize`, `fillColor`, `outlineColor`, `position`, `enabled`) supplies the style. No filter changes when `subtitles.enabled === false`.

---

## File Structure

```
src/
├── shared/
│   └── render.ts                          # MODIFY: extend RenderClipResult.subtitles field
├── main/
│   ├── main.ts                            # MODIFY: pass transcript.words + settings.subtitles to render()
│   └── services/
│       ├── SubtitleGenerator.ts           # NEW: pure word→ASS file content
│       ├── SubtitleGenerator.test.ts      # NEW: vitest pure tests
│       ├── RenderService.ts               # MODIFY: optional subtitle gen + write + filter append
│       └── RenderService.test.ts          # MODIFY: existing 10 stay green; +3 new subtitle tests
└── renderer/
    └── components/newjob/RenderCard.tsx   # MODIFY: per-clip "✏️ 자막 N개 cue" note
```

**Decomposition rationale:**

- `SubtitleGenerator` is pure (string in, string out) — same shape as M7's `SendcmdGenerator`, easy to unit-test exhaustively. Handles word grouping, ASS timestamp formatting, color conversion, and position mapping all in one file but with separate exported helpers.
- `RenderService` extends rather than restructures: a new `subtitleOptions` parameter is wholly opt-in; existing 10 tests (6 from M6 + 3 from M7 + 1 portrait fallback) keep passing because the new code path is gated on `subtitleOptions != null`.
- `RenderClipResult.subtitles` mirrors the `tracking` field shape (`{ cues: number; assPath: string } | null | undefined`) so the UI rendering logic in `RenderCard` follows the same conditional pattern as the tracking note.
- No new IPC method needed — the existing `render:run` handler just reads more from disk and passes more args to the service.

---

## Tasks

### Task 1: Extend RenderClipResult with optional subtitles field

**Files:**
- Modify: `src/shared/render.ts`

The UI will display "subtitles applied: N cues" per clip. Add the optional field to the existing schema (mirrors the `tracking` field added in M7).

- [ ] **Step 1: Add the field**

Open `src/shared/render.ts`. Find the `RenderClipResultSchema` definition. After the `tracking` field (added in M7) and BEFORE the closing `})`, add:

```ts
  /**
   * If subtitles were enabled and at least one cue landed in the clip window:
   * the cue count and the persisted .ass file path. Absent when subtitles
   * were disabled in settings OR no transcript words fell inside the clip
   * range (silent clip).
   */
  subtitles: z
    .object({
      cues: z.number().int().nonnegative(),
      assPath: z.string().min(1),
    })
    .nullish(),
```

(`.nullish()` matches `tracking`'s pattern — accepts both `null` and `undefined` for backward compat with existing test fixtures.)

- [ ] **Step 2: Format + verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/shared/render.ts
yarn lint && yarn typecheck && yarn test 2>&1 | tail -5
```

Expected: lint clean (only known `__dirname` warning), typecheck clean, all 124 tests pass (existing fixtures don't include `subtitles` — `.nullish()` makes that fine).

- [ ] **Step 3: Commit**

```bash
git add src/shared/render.ts
git commit -m "feat(m8): add optional subtitles field to RenderClipResult schema"
```

---

### Task 2: SubtitleGenerator pure logic (TDD)

**Files:**
- Create: `src/main/services/SubtitleGenerator.ts`
- Create: `src/main/services/SubtitleGenerator.test.ts`

Pure function: takes transcript words + a clip window + style options, returns ASS file content as a string. Filters words to the clip range, rebases timestamps to clip-relative, groups into 2-word cues, emits a complete ASS file.

- [ ] **Step 1: Write the failing tests**

Create `src/main/services/SubtitleGenerator.test.ts` with EXACTLY this content:

```ts
import { describe, expect, it } from 'vitest';

import type { Word } from '@shared/transcript';
import { buildAssFile, hexToAssColor } from './SubtitleGenerator';

const STYLE = {
  fontFamily: 'Pretendard',
  fontSize: 64,
  fillColor: '#FFFFFF',
  outlineColor: '#000000',
  position: 'bottom' as const,
};

function w(text: string, start: number, end: number): Word {
  return { text, start, end };
}

describe('hexToAssColor', () => {
  it('converts #RRGGBB hex to ASS &H00BBGGRR format (BGR with no alpha)', () => {
    expect(hexToAssColor('#FFFFFF')).toBe('&H00FFFFFF');
    expect(hexToAssColor('#000000')).toBe('&H00000000');
    expect(hexToAssColor('#FF0000')).toBe('&H000000FF'); // red → BGR=0000FF
    expect(hexToAssColor('#00FF00')).toBe('&H0000FF00'); // green
    expect(hexToAssColor('#0000FF')).toBe('&H00FF0000'); // blue → BGR=FF0000
  });

  it('uppercases and accepts lowercase hex input', () => {
    expect(hexToAssColor('#abcdef')).toBe('&H00EFCDAB');
  });

  it('throws on malformed input', () => {
    expect(() => hexToAssColor('FFFFFF')).toThrow(/invalid color/i); // no #
    expect(() => hexToAssColor('#FFF')).toThrow(/invalid color/i); // 3-digit not supported
    expect(() => hexToAssColor('#GGGGGG')).toThrow(/invalid color/i);
  });
});

describe('buildAssFile', () => {
  it('returns empty string when no words fall inside the clip window', () => {
    const words = [w('hello', 0, 0.5), w('world', 0.5, 1.0)];
    const result = buildAssFile(words, 10, 20, STYLE);
    expect(result).toBe('');
  });

  it('returns empty string when given an empty words array', () => {
    expect(buildAssFile([], 0, 30, STYLE)).toBe('');
  });

  it('emits a complete ASS file with [Script Info], [V4+ Styles], [Events] sections', () => {
    const words = [w('hello', 0, 0.5), w('world', 0.5, 1.0)];
    const result = buildAssFile(words, 0, 5, STYLE);
    expect(result).toContain('[Script Info]');
    expect(result).toContain('PlayResX: 1080');
    expect(result).toContain('PlayResY: 1920');
    expect(result).toContain('[V4+ Styles]');
    expect(result).toContain('Style: Default,Pretendard,64,');
    expect(result).toContain('[Events]');
    expect(result).toMatch(/Dialogue: 0,/);
  });

  it('groups words into 2-per-cue chunks', () => {
    // 4 words → 2 cues (w0+w1, w2+w3)
    const words = [
      w('one', 0, 0.5),
      w('two', 0.5, 1.0),
      w('three', 1.0, 1.5),
      w('four', 1.5, 2.0),
    ];
    const result = buildAssFile(words, 0, 5, STYLE);
    const dialogues = result.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(2);
    expect(dialogues[0]).toContain('one two');
    expect(dialogues[1]).toContain('three four');
  });

  it('handles odd word counts — last cue is single-word', () => {
    const words = [w('one', 0, 0.5), w('two', 0.5, 1.0), w('three', 1.0, 1.5)];
    const result = buildAssFile(words, 0, 5, STYLE);
    const dialogues = result.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(2);
    expect(dialogues[0]).toContain('one two');
    expect(dialogues[1]).toContain('three');
  });

  it('rebases word timestamps to clip-relative ASS time format H:MM:SS.cc', () => {
    // Word at source-time 5.25 → 5.5 should appear as 0:00:00.25 → 0:00:00.50 when clip starts at 5.0
    const words = [w('hi', 5.25, 5.5)];
    const result = buildAssFile(words, 5, 10, STYLE);
    const dialogue = result.split('\n').find((l) => l.startsWith('Dialogue:'))!;
    expect(dialogue).toContain('0,0:00:00.25,0:00:00.50,Default,hi');
  });

  it('applies position=bottom → ASS Alignment 2', () => {
    const words = [w('hi', 0, 0.5)];
    const result = buildAssFile(words, 0, 5, { ...STYLE, position: 'bottom' });
    const styleLine = result.split('\n').find((l) => l.startsWith('Style:'))!;
    // Format row order: Name, Fontname, Fontsize, PrimaryColour, OutlineColour,
    // BorderStyle, Outline, Alignment, MarginV, Encoding → Alignment is column 8 (index 7).
    const cols = styleLine.replace(/^Style:\s*/, '').split(',');
    expect(cols[7]).toBe('2');
  });

  it('applies position=middle → ASS Alignment 5', () => {
    const words = [w('hi', 0, 0.5)];
    const result = buildAssFile(words, 0, 5, { ...STYLE, position: 'middle' });
    const styleLine = result.split('\n').find((l) => l.startsWith('Style:'))!;
    const cols = styleLine.replace(/^Style:\s*/, '').split(',');
    expect(cols[7]).toBe('5');
  });

  it('clamps cue end to clip end when a word straddles the boundary', () => {
    // word ends at 6.5 but clip ends at 6.0 → cue end should be 6.0 (= 1.0 clip-relative)
    const words = [w('hi', 5.5, 6.5)];
    const result = buildAssFile(words, 5, 6, STYLE);
    const dialogue = result.split('\n').find((l) => l.startsWith('Dialogue:'))!;
    expect(dialogue).toContain('0,0:00:00.50,0:00:01.00,Default,hi');
  });

  it('applies a minimum cue duration of 0.30s for very short stutters', () => {
    // word "uh" lasts 0.05s — should be padded to at least 0.30s for readability
    const words = [w('uh', 0, 0.05)];
    const result = buildAssFile(words, 0, 5, STYLE);
    const dialogue = result.split('\n').find((l) => l.startsWith('Dialogue:'))!;
    expect(dialogue).toContain('0,0:00:00.00,0:00:00.30,Default,uh');
  });

  it('escapes ASS-significant characters in word text', () => {
    // ASS uses { for override tags; literal { needs to be escaped as \{
    // Newlines in word text would break the Dialogue line.
    const words = [w('a{b}', 0, 0.5), w('c\nd', 0.5, 1.0)];
    const result = buildAssFile(words, 0, 5, STYLE);
    const dialogue = result.split('\n').find((l) => l.startsWith('Dialogue:'))!;
    // Both words on one line (cue groups them); { escaped, \n replaced with space.
    expect(dialogue).toContain('a\\{b\\} c d');
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/SubtitleGenerator.test.ts
```

Expected: cannot find SubtitleGenerator module.

- [ ] **Step 3: Implement `src/main/services/SubtitleGenerator.ts` with EXACTLY this content**

```ts
import type { Word } from '@shared/transcript';

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  /** `#RRGGBB`. Converted to ASS `&H00BBGGRR` internally. */
  fillColor: string;
  /** `#RRGGBB`. */
  outlineColor: string;
  position: 'bottom' | 'middle';
}

const WORDS_PER_CUE = 2;
const MIN_CUE_DURATION_SEC = 0.3;
const PLAY_RES_X = 1080;
const PLAY_RES_Y = 1920;
const OUTLINE_WIDTH = 3;
const MARGIN_V = 200;

/**
 * Build a complete .ass file content string (libass-compatible) from a list
 * of word-timed transcript entries. Filters to the clip window, groups into
 * 2-word cues, rebases timestamps clip-relative, and emits one Dialogue line
 * per cue. Returns an empty string when no words fall in the window so the
 * caller can skip writing the file + appending the subtitles filter.
 */
export function buildAssFile(
  words: Word[],
  clipStartSec: number,
  clipEndSec: number,
  style: SubtitleStyle,
): string {
  const inWindow = words.filter((w) => w.start < clipEndSec && w.end > clipStartSec);
  if (inWindow.length === 0) return '';

  const cues: { startSec: number; endSec: number; text: string }[] = [];
  for (let i = 0; i < inWindow.length; i += WORDS_PER_CUE) {
    const group = inWindow.slice(i, i + WORDS_PER_CUE);
    const startRel = Math.max(0, group[0]!.start - clipStartSec);
    const endRel = Math.min(clipEndSec - clipStartSec, group[group.length - 1]!.end - clipStartSec);
    const duration = Math.max(MIN_CUE_DURATION_SEC, endRel - startRel);
    cues.push({
      startSec: startRel,
      endSec: startRel + duration,
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
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Text',
  ].join('\n');

  const dialogues = cues
    .map((c) => `Dialogue: 0,${formatAssTime(c.startSec)},${formatAssTime(c.endSec)},Default,${c.text}`)
    .join('\n');

  return `${header}\n${dialogues}\n`;
}

/**
 * Convert #RRGGBB hex into ASS color literal &H00BBGGRR (alpha=00=opaque,
 * channels in BGR order).
 */
export function hexToAssColor(hex: string): string {
  const m = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(hex);
  if (!m) {
    throw new Error(`Invalid color: ${hex} (expected #RRGGBB)`);
  }
  const [, r, g, b] = m;
  return `&H00${b!.toUpperCase()}${g!.toUpperCase()}${r!.toUpperCase()}`;
}

function formatAssTime(sec: number): string {
  const totalCs = Math.round(sec * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  // ASS uses {...} as override-tag delimiters; literal braces must be escaped.
  // Newlines in the source word text would corrupt the Dialogue line.
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, ' ');
}
```

- [ ] **Step 4: Run — should pass 13/13**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/SubtitleGenerator.test.ts
```

If a test fails:
- "applies position=bottom → ASS Alignment 2": the regex matches "Alignment" as part of the format header line; the actual style line has the value. The current Style line format is `Style: Default,Font,Size,FillColor,OutlineColor,BorderStyle,Outline,Alignment,MarginV,Encoding` — alignment is the 8th column. Verify the implementation puts `2` (or `5`) in position 8.
- Time format edge case: 1.005s should round to `0:00:01.01` (not `0:00:01.00` or `0:00:01.51`). The `Math.round(sec * 100)` handles this correctly.

- [ ] **Step 5: Format + commit**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/main/services/SubtitleGenerator.ts src/main/services/SubtitleGenerator.test.ts
git add src/main/services/SubtitleGenerator.ts src/main/services/SubtitleGenerator.test.ts
git commit -m "feat(m8): add SubtitleGenerator pure logic for ASS file generation"
```

---

### Task 3: Extend RenderService with optional subtitle generation (TDD)

**Files:**
- Modify: `src/main/services/RenderService.ts`
- Modify: `src/main/services/RenderService.test.ts`

Per clip in the render loop:
1. If `subtitleOptions != null` AND `transcriptWords` provided → call `buildAssFile(words, h.start_sec, h.end_sec, subtitleOptions)`.
2. If non-empty result → write `${outputDir}/short_N.ass`, append `,subtitles=filename=<path>` to the existing filter chain. Result records `subtitles: { cues, assPath }`.
3. If empty (no words in window) OR `subtitleOptions` is null → no .ass file, no filter append. Result records `subtitles: null`.

This is additive over both M6 (center crop) and M7 (sendcmd tracked) filter chains — both append the subtitle filter at the end.

- [ ] **Step 1: Add 3 new test cases to `src/main/services/RenderService.test.ts`**

After the existing `'falls back to center crop when buildSendcmd throws (portrait source)'` test (last test in the `'RenderService with tracker'` describe block), append a new describe block:

```ts
const SUBTITLE_OPTS = {
  fontFamily: 'Pretendard',
  fontSize: 64,
  fillColor: '#FFFFFF',
  outlineColor: '#000000',
  position: 'bottom' as const,
};

function fakeWords(specs: { text: string; start: number; end: number }[]) {
  return specs;
}

describe('RenderService with subtitles', () => {
  let run: ReturnType<typeof vi.fn>;
  let runner: { run: typeof run };

  beforeEach(() => {
    run = vi.fn();
    runner = { run };
  });

  it('writes .ass file and appends subtitles= to filter chain when options provided + words in window', async () => {
    const writeFile = vi.fn(async () => undefined);
    const fs = { writeFile };
    const service = new RenderService(runner as never, { fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 30)],
      transcriptWords: fakeWords([
        { text: 'hello', start: 0, end: 0.5 },
        { text: 'world', start: 0.5, end: 1.0 },
      ]),
      subtitleOptions: SUBTITLE_OPTS,
    });
    h._resolve();
    const result = await promise;

    // .ass file written
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0]).toBe('/tmp/out/short_1.ass');
    const assContent = writeFile.mock.calls[0]![1] as string;
    expect(assContent).toContain('Dialogue:');
    expect(assContent).toContain('hello world');

    // ffmpeg filter chain ends with subtitles=filename=<path>
    const args: string[] = run.mock.calls[0]![0].args;
    const vfIndex = args.indexOf('-vf');
    expect(args[vfIndex + 1]).toContain('crop=ih*9/16:ih,scale=1080:1920,subtitles=filename=/tmp/out/short_1.ass');

    // RenderClipResult.subtitles populated
    expect(result.results[0]!.subtitles).toEqual({ cues: 1, assPath: '/tmp/out/short_1.ass' });
  });

  it('skips ass writing + filter when subtitleOptions is undefined', async () => {
    const writeFile = vi.fn(async () => undefined);
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

    expect(writeFile).not.toHaveBeenCalled();
    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=ih*9/16:ih,scale=1080:1920');
    expect(result.results[0]!.subtitles).toBeNull();
  });

  it('skips ass writing when no transcript words fall inside the clip window', async () => {
    const writeFile = vi.fn(async () => undefined);
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

    expect(writeFile).not.toHaveBeenCalled();
    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=ih*9/16:ih,scale=1080:1920');
    expect(result.results[0]!.subtitles).toBeNull();
  });
});
```

- [ ] **Step 2: Run — should fail (3 new tests)**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/RenderService.test.ts
```

Expected: 10 existing pass, 3 new fail.

- [ ] **Step 3: Modify `src/main/services/RenderService.ts`**

a) Add the import at the top (alongside the existing imports):

```ts
import type { Word } from '@shared/transcript';

import { buildAssFile, type SubtitleStyle } from './SubtitleGenerator';
```

b) Find the `RenderOptions` interface. Add two new optional fields:

```ts
export interface RenderOptions {
  sourcePath: string;
  outputDir: string;
  highlights: Highlight[];
  /** Whisper word-level timings, used to generate subtitle .ass files. */
  transcriptWords?: Word[];
  /** When provided AND words fall in the clip window, subtitles are burned in. */
  subtitleOptions?: SubtitleStyle;
}
```

c) Find the per-clip loop body in `render()`. Currently it computes `args` based on `trackingInfo`:

```ts
const args =
  trackingInfo !== null
    ? buildTrackedArgs(opts.sourcePath, h, outputPath, trackingInfo.cmdPath)
    : buildCenterArgs(opts.sourcePath, h, outputPath);
```

Replace with:

```ts
const baseArgs =
  trackingInfo !== null
    ? buildTrackedArgs(opts.sourcePath, h, outputPath, trackingInfo.cmdPath)
    : buildCenterArgs(opts.sourcePath, h, outputPath);
const subtitlesInfo = await this.maybeWriteSubtitles(opts, h, clipIndex);
const args = subtitlesInfo
  ? appendSubtitleFilter(baseArgs, subtitlesInfo.assPath)
  : baseArgs;
```

d) Find the `buildClipResult` call after `await handle.done`. Currently:

```ts
results.push(
  this.buildClipResult(
    clipIndex,
    h,
    'done',
    outputPath,
    undefined,
    trackingInfo
      ? { frames: trackingInfo.frameCount, trackPath: trackingInfo.trackPath }
      : null,
  ),
);
```

Replace with:

```ts
results.push(
  this.buildClipResult(
    clipIndex,
    h,
    'done',
    outputPath,
    undefined,
    trackingInfo
      ? { frames: trackingInfo.frameCount, trackPath: trackingInfo.trackPath }
      : null,
    subtitlesInfo ? { cues: subtitlesInfo.cueCount, assPath: subtitlesInfo.assPath } : null,
  ),
);
```

e) Add the new helper method `maybeWriteSubtitles` (place it next to `maybeTrackAndPersist`):

```ts
private async maybeWriteSubtitles(
  opts: RenderOptions,
  h: Highlight,
  clipIndex: number,
): Promise<{ assPath: string; cueCount: number } | null> {
  if (!opts.subtitleOptions || !opts.transcriptWords) return null;
  const assContent = buildAssFile(
    opts.transcriptWords,
    h.start_sec,
    h.end_sec,
    opts.subtitleOptions,
  );
  if (assContent === '') return null; // no words in window
  const assPath = join(opts.outputDir, `short_${clipIndex}.ass`);
  await this.fs.writeFile(assPath, assContent, 'utf8');
  // Cue count = number of Dialogue lines (one per cue).
  const cueCount = (assContent.match(/^Dialogue:/gm) ?? []).length;
  return { assPath, cueCount };
}
```

f) Update the `buildClipResult` method signature to accept the new optional `subtitles` parameter:

```ts
private buildClipResult(
  index: number,
  h: Highlight,
  status: RenderClipResult['status'],
  outputPath?: string,
  error?: string,
  tracking?: RenderClipResult['tracking'],
  subtitles?: RenderClipResult['subtitles'],
): RenderClipResult {
  return {
    index,
    title: h.title,
    startSec: h.start_sec,
    endSec: h.end_sec,
    status,
    outputPath,
    error,
    tracking,
    subtitles,
  };
}
```

g) Add the `appendSubtitleFilter` free function below `buildTrackedArgs` at the bottom of the file:

```ts
function appendSubtitleFilter(args: readonly string[], assPath: string): string[] {
  const out = [...args];
  const vfIndex = out.indexOf('-vf');
  if (vfIndex === -1) return out;
  out[vfIndex + 1] = `${out[vfIndex + 1]},subtitles=filename=${assPath}`;
  return out;
}
```

- [ ] **Step 4: Run — should pass 13/13**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/RenderService.test.ts
```

Expected: 13 passed (10 existing + 3 new).

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/services/RenderService.ts src/main/services/RenderService.test.ts
git add src/main/services/RenderService.ts src/main/services/RenderService.test.ts
git commit -m "feat(m8): extend RenderService with optional subtitle generation + filter append"
```

---

### Task 4: Wire transcript.words + settings.subtitles in main.ts

**Files:**
- Modify: `src/main/main.ts`

The `render:run` IPC handler currently reads `<audioPath>.highlights.json` (M6) and uses `settings.paths.outputs` (M6). For M8 it ALSO needs to read `<audioPath>.transcript.json` (already exists from M4) for the words array, and pass `settings.subtitles` through (already in M2 settings) — but only when `settings.subtitles.enabled === true`.

- [ ] **Step 1: Read the current main.ts**

Open `src/main/main.ts` and locate the existing `render:run` IPC handler. It currently reads `highlights.json`, validates with `HighlightSetSchema.parse`, and calls `service.render({ sourcePath, outputDir, highlights })`.

- [ ] **Step 2: Update the handler**

Find the existing handler block:

```ts
const highlightSet = HighlightSetSchema.parse(JSON.parse(raw));

const settings = settingsStore.get();
const sourceStem = basename(audioPath, extname(audioPath));
const outputDir = join(settings.paths.outputs, sourceStem);
await fsPromises.mkdir(outputDir, { recursive: true });

const service = getRenderService();
return await service.render({
  sourcePath: audioPath,
  outputDir,
  highlights: highlightSet.highlights,
});
```

Replace with:

```ts
const highlightSet = HighlightSetSchema.parse(JSON.parse(raw));

const settings = settingsStore.get();
const sourceStem = basename(audioPath, extname(audioPath));
const outputDir = join(settings.paths.outputs, sourceStem);
await fsPromises.mkdir(outputDir, { recursive: true });

// Subtitles are sourced from the sibling transcript.json. If subtitles are
// disabled in settings OR the transcript file is missing, we render without
// subtitles (the M7 behaviour). Read errors are non-fatal — render proceeds.
let transcriptWords: Word[] | undefined;
if (settings.subtitles.enabled) {
  try {
    const transcriptRaw = await fsPromises.readFile(`${audioPath}.transcript.json`, 'utf8');
    const transcript = TranscriptSchema.parse(JSON.parse(transcriptRaw));
    transcriptWords = transcript.words;
  } catch {
    // No transcript or unreadable — silently render without subtitles.
    transcriptWords = undefined;
  }
}

const service = getRenderService();
return await service.render({
  sourcePath: audioPath,
  outputDir,
  highlights: highlightSet.highlights,
  transcriptWords,
  subtitleOptions:
    settings.subtitles.enabled && transcriptWords
      ? {
          fontFamily: settings.subtitles.fontFamily,
          fontSize: settings.subtitles.fontSize,
          fillColor: settings.subtitles.fillColor,
          outlineColor: settings.subtitles.outlineColor,
          position: settings.subtitles.position,
        }
      : undefined,
});
```

- [ ] **Step 3: Add the imports**

Find the existing imports at the top. Add:

```ts
import { TranscriptSchema, type Word } from '@shared/transcript';
```

(`TranscriptSchema` is already imported in main.ts from M5's transcript validation work — if it's already there, just add the `, type Word` to the existing import. Check first.)

- [ ] **Step 4: Format + verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/main/main.ts
yarn lint && yarn typecheck && yarn test 2>&1 | tail -8
```

Expected: lint 0 errors, typecheck 0 errors, all tests pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(m8): pass transcript words + settings.subtitles to render service"
```

---

### Task 5: Surface per-clip subtitles status in RenderCard

**Files:**
- Modify: `src/renderer/components/newjob/RenderCard.tsx`

Show a small note next to each `done` clip indicating subtitle status (mirroring the M7 tracking note pattern).

- [ ] **Step 1: Add the subtitle note**

In `src/renderer/components/newjob/RenderCard.tsx`, find the `props.status === 'done'` block. Locate the existing tracking note lines:

```tsx
{r.status === 'done' && r.tracking ? (
  <p className="text-body-sm text-slate mt-xs">🎯 얼굴 추적 {r.tracking.frames}프레임</p>
) : null}
{r.status === 'done' && r.tracking === null ? (
  <p className="text-body-sm text-slate mt-xs">⊕ 중앙 크롭 폴백 (얼굴 미감지)</p>
) : null}
```

After those two lines, add:

```tsx
{r.status === 'done' && r.subtitles ? (
  <p className="text-body-sm text-slate mt-xs">✏️ 자막 {r.subtitles.cues}개 cue</p>
) : null}
```

(No "subtitles disabled" note — when the user has subtitles off in settings, silence in the UI is the right signal. The note only appears when subtitles were actually applied.)

- [ ] **Step 2: Format + verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/renderer/components/newjob/RenderCard.tsx
yarn lint && yarn typecheck && yarn test 2>&1 | tail -5
```

Expected: all green. Existing tests don't pass `subtitles` so the note doesn't render — no regression.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/newjob/RenderCard.tsx
git commit -m "feat(m8): show subtitle cue count per clip in RenderCard"
```

---

### Task 6: DoD verification + README + finalize branch

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Run all DoD checks**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn typecheck && yarn lint && yarn test && yarn build
cd sidecar && uv run pytest && cd ..
```

Expected: all green. Vitest count is 124 (M7 baseline) + 13 SubtitleGenerator + 3 RenderService = 140. Pytest 24 (unchanged from M7).

- [ ] **Step 2: Manual integration check (real ffmpeg + libass + real video)**

In one terminal:

```bash
yarn dev
```

In the app:
1. **Settings** — confirm `subtitles.enabled = true` (default). Optionally tweak `fontFamily` (default Pretendard — must be installed system-wide for the chosen font), `fontSize`, `fillColor`/`outlineColor`.
2. NewJob page — paste a short Korean or English talking-head URL, walk preview → 다운로드 → STT 시작 → 하이라이트 추출 → 숏츠 만들기.
3. When done, each clip card should now show "✏️ 자막 N개 cue" alongside the existing "🎯 얼굴 추적 N프레임".
4. Click 폴더 열기. Open a short_N.mp4 in QuickTime — captions should appear at the bottom (or middle, depending on settings) with words grouped 2-at-a-time, color matching settings.
5. Toggle `subtitles.enabled = false` in settings → render again → confirm no captions appear and no .ass file is written.
6. Verify the sidecar files: `${outputDir}/short_1.ass` should exist next to the .mp4 (when subtitles enabled).

If captions appear but the font is wrong (defaults to Arial-style), the requested `fontFamily` isn't installed system-wide. libass falls back silently. Acceptable for M8; M9 can add a font availability check.

If captions never appear despite `enabled=true`, check that the sibling `<audioPath>.transcript.json` exists (was created by M4 STT). The IPC handler silently skips subtitles if the transcript can't be read.

If something is broken, fix and re-test BEFORE continuing.

- [ ] **Step 3: Update README status**

Edit `README.md` `## Status`:

```markdown
## Status

- ✅ M1: Project Skeleton
- ✅ M2: Settings page
- ✅ M3: YouTube preview + download
- ✅ M4: Python sidecar + STT
- ✅ M5: LLM highlight extraction
- ✅ M6: First end-to-end render
- ✅ M7: Smart face tracking — MediaPipe per-clip face tracking, Gaussian-smoothed sendcmd-driven dynamic crop, auto-fallback to center on detection failure.
- ✅ M8: Subtitle burn-in — word-grouped TikTok-style ASS captions, libass-rendered in the same single-pass ffmpeg run, styled by Settings.
- ⏳ M9: History persistence (next)
```

- [ ] **Step 4: Commit + push branch**

```bash
yarn prettier --write README.md
git add README.md
git commit -m "docs(m8): mark milestone 8 complete in README"
git push -u origin m8-subtitle-burnin
```

- [ ] **Step 5: Merge to master + tag**

(Done by the controller via `superpowers:finishing-a-development-branch` skill — see DoD below.)

---

## Definition of Done (M8)

All of these must be true:

1. `yarn typecheck`, `yarn lint` (only known `__dirname` warning), `yarn test`, `yarn build` all exit 0.
2. `cd sidecar && uv run pytest` reports all sidecar tests passing (24, unchanged from M7).
3. `yarn test` includes new test files: `SubtitleGenerator.test.ts` (13) + 3 new RenderService tests (existing 10 still pass). Total expected: 124 prior + 16 new = 140. No regressions.
4. Manual integration: real `yarn dev` run renders shorts with burned-in word-grouped captions matching the user's color/font/position settings. Toggling `subtitles.enabled = false` produces clips with no captions and no .ass file.
5. Branch `m8-subtitle-burnin` pushed to origin.
6. After review, branch merged to master with `--no-ff` and tagged `m8-complete` on master.

## What's NOT in M8 (intentionally deferred)

- **Per-word highlight color** ("karaoke-style" colored current word vs whole cue): M8 emits one Dialogue line per cue with a single style. M9 could add ASS `\\K` karaoke effects.
- **Font availability check**: libass silently falls back to Arial/default if the requested `fontFamily` isn't installed. M9 could surface a settings-time warning.
- **Subtitle preview in Settings**: no live preview of how the chosen color/size will look. Could be a Settings polish in M9.
- **Per-cue manual editing**: no UI to edit the .ass file before render. Power-user feature, not in scope.
- **Multiple subtitle tracks** (e.g., translated captions): single track only.
- **Word-level vs phrase-level toggle in Settings**: hardcoded to 2-word cues based on user's M8-design choice. Could be exposed as a setting in M9.
- **Speaker diarization color coding**: single style per video. Multi-speaker color coding requires speaker labels Whisper doesn't expose.
- **Subtitle test in pytest**: pure-TypeScript path; no Python side change. Sidecar pytest count stays at 24.
- **Filter path escaping**: `subtitles=filename=<path>` is appended raw. If the user's `outputs` folder contains a literal `,` or `:` (filter separator/argument delimiters in ffmpeg), the filter chain would break. Acceptable for M8 because settings.paths.outputs typically lives under `~/Documents` or similar; M9/M10 should add proper ffmpeg filter escaping (`\,` → `\\,`, etc.) before bundling.

## Notes for the implementing agent

- Start the milestone branch BEFORE Task 1 (already done by the plan author at write time — confirm `git branch --show-current` shows `m8-subtitle-burnin` before starting).
- The bob-park ESLint config bans `../*` parent imports — use `@renderer/*`, `@shared/*` aliases.
- libass renders ASS files at the resolution declared in `PlayResX`/`PlayResY` and scales to the output frame. Pinning to 1080×1920 (matching the M7 scale output) means the user's `fontSize: 64` is "64 pixels at 1080p height" which is roughly 3.3% of the frame — reasonable default for vertical video.
- The subtitles filter is appended at the END of the existing filter chain (after scale) so libass renders into the final 1080×1920 frame, NOT into the source's coordinate space. Filter order matters here.
- The `appendSubtitleFilter` helper does a string concat into the existing `-vf` argument — there's only one `-vf` slot in our args, so this is safe.
- `escapeAssText` handles ASS's `{...}` override syntax + literal newlines in word text. It does NOT do anything fancy for unicode characters — Korean / Japanese / emoji should pass through as-is and render fine via libass + system font.
- The minimum cue duration of 0.30s is a readability heuristic, not a hard requirement. Whisper sometimes emits 0.05s words for sub-second utterances; 0.30s gives the eye a chance to register. Tunable later.
- Time format `H:MM:SS.cc` is centiseconds, not milliseconds — `Math.round(sec * 100)` then split. Matches libass parser.
