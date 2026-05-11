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
/** Default style baseline distance from frame bottom, in 1920-canvas px.
 *  120 places the bottom-aligned subtitle inside the 240px bottom bar. */
const MARGIN_V = 120;
/** Title style baseline distance from frame top, in 1920-canvas px.
 *  140 places the top-aligned title near the vertical center of the 240px top bar. */
const TITLE_MARGIN_V = 140;
/** Title text size, in libass-canvas px. Matched to Default fontsize so
 *  the bar visually carries the same weight as the word subtitle line. */
const TITLE_FONT_SIZE = 64;

/**
 * Fallback style used when the caller of `buildAssFile` doesn't supply
 * subtitle options (i.e., word-level subtitles disabled in Settings).
 * Only the Title row consumes `fontFamily` from this style; word cues
 * are skipped, so the Default-row fields are inert placeholders here.
 */
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily: 'Pretendard',
  fontSize: 64,
  fillColor: '#FFFFFF',
  outlineColor: '#000000',
  position: 'bottom',
};

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
    // Title row colors are pinned (white-on-black). The user-configurable
    // fillColor / outlineColor only apply to word subtitles, which sit on
    // the (also-black) bottom bar. Outline=0 since text is already on solid
    // black; Alignment=8 means top-center (libass numpad layout).
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

  const body = cues.length > 0 ? `${titleDialogue}\n${subtitleDialogues}` : titleDialogue;
  return `${header}\n${body}\n`;
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
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '00')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  // ASS uses {...} as override-tag delimiters; literal braces must be escaped.
  // Newlines in the source word text would corrupt the Dialogue line.
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, ' ');
}
