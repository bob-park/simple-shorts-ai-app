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
export function buildAssFile(words: Word[], clipStartSec: number, clipEndSec: number, style: SubtitleStyle): string {
  const inWindow = words.filter((w) => w.start < clipEndSec && w.end > clipStartSec);
  if (inWindow.length === 0) return '';

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
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '00')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  // ASS uses {...} as override-tag delimiters; literal braces must be escaped.
  // Newlines in the source word text would corrupt the Dialogue line.
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, ' ');
}
