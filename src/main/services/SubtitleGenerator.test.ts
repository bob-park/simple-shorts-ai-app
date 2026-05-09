import type { Word } from '@shared/transcript';
import { describe, expect, it } from 'vitest';

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
    const words = [w('one', 0, 0.5), w('two', 0.5, 1.0), w('three', 1.0, 1.5), w('four', 1.5, 2.0)];
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
