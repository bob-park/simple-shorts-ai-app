import type { Word } from '@shared/transcript';
import type { TitleFontWeight } from '@shared/settings';
import { SHORT_LAYOUT } from '@shared/shortLayout';

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  /** `#RRGGBB`. Converted to ASS `&H00BBGGRR` internally. */
  fillColor: string;
  /** `#RRGGBB`. */
  outlineColor: string;
  position: 'bottom' | 'middle';
  /** Title text size, in libass-canvas px (1080×1920). */
  titleFontSize: number;
  /** CSS-like numeric weight ('400'–'900') written into the Title ASS style Bold field;
   *  libass matches the closest available font weight. */
  titleFontWeight: TitleFontWeight;
}

const WORDS_PER_CUE = 2;
const MIN_CUE_DURATION_SEC = 0.3;
const PLAY_RES_X = 1080;
const PLAY_RES_Y = 1920;
const OUTLINE_WIDTH = 3;

/** Compute MarginV that vertically centers a single text line of size `fontSize`
 *  inside a bar of height `barHeight`. libass interprets MarginV as the distance
 *  from the screen edge (top for Alignment=8, bottom for Alignment=2) to the
 *  edge of the text bounding box, so `(barHeight - fontSize) / 2` puts the
 *  text's center on the bar's center. Clamped to 0 to avoid negatives when a
 *  user pushes the font size past the bar height. */
function centeredMarginV(barHeight: number, fontSize: number): number {
  return Math.max(0, Math.round((barHeight - fontSize) / 2));
}

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
  titleFontSize: 72,
  titleFontWeight: '700',
};

/**
 * Build a complete .ass file content string (libass-compatible). Always
 * non-empty: emits a `Title` style + a full-clip-duration Dialogue line
 * carrying `titleText` (rendered in the top black bar), and a `Default`
 * style + per-cue word-level subtitles (rendered in the bottom black bar)
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
  // Vertically center text inside the matching black bar. For Alignment=2
  // (bottom-anchored), MarginV is measured from the screen bottom up; for
  // Alignment=8 (top-anchored), from the screen top down. `position='middle'`
  // uses Alignment=5 (canvas center) and ignores MarginV — we emit 0.
  const defaultMarginV = style.position === 'middle'
    ? 0
    : centeredMarginV(SHORT_LAYOUT.bottomBarHeight, style.fontSize);
  const titleMarginV = centeredMarginV(SHORT_LAYOUT.topBarHeight, style.titleFontSize);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${PLAY_RES_X}`,
    `PlayResY: ${PLAY_RES_Y}`,
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, BorderStyle, Outline, Alignment, MarginV, Encoding',
    `Style: Default,${style.fontFamily},${style.fontSize},${fillAss},${outlineAss},0,1,${OUTLINE_WIDTH},${alignment},${defaultMarginV},1`,
    // Title row colors are pinned (white-on-black). The user-configurable
    // fillColor / outlineColor only apply to word subtitles, which sit on
    // the (also-black) bottom bar. Outline=0 since text is already on solid
    // black; Alignment=8 means top-center (libass numpad layout). Bold is a
    // CSS-like numeric weight (400-900) so libass picks the closest face.
    `Style: Title,${style.fontFamily},${style.titleFontSize},&H00FFFFFF,&H00000000,${style.titleFontWeight},1,0,8,${titleMarginV},1`,
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
