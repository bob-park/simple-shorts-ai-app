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

  it('emits a complete ASS file with [Script Info], [V4+ Styles], [Events] sections', () => {
    const words = [w('hello', 0, 0.5), w('world', 0.5, 1.0)];
    const result = buildAssFile(words, 0, 5, STYLE, 'TestTitle');
    expect(result).toContain('[Script Info]');
    expect(result).toContain('PlayResX: 1080');
    expect(result).toContain('PlayResY: 1920');
    expect(result).toContain('[V4+ Styles]');
    expect(result).toContain('Style: Default,Pretendard,64,');
    expect(result).toContain('Style: Title,Pretendard,');
    expect(result).toContain('[Events]');
    expect(result).toMatch(/Dialogue: 0,/);
  });

  it('groups words into 2-per-cue chunks', () => {
    // 4 words → 2 cues (w0+w1, w2+w3)
    const words = [w('one', 0, 0.5), w('two', 0.5, 1.0), w('three', 1.0, 1.5), w('four', 1.5, 2.0)];
    const result = buildAssFile(words, 0, 5, STYLE, 'TestTitle');
    const dialogues = result.split('\n').filter((l) => l.startsWith('Dialogue:') && l.includes(',Default,'));
    expect(dialogues).toHaveLength(2);
    expect(dialogues[0]).toContain('one two');
    expect(dialogues[1]).toContain('three four');
  });

  it('handles odd word counts — last cue is single-word', () => {
    const words = [w('one', 0, 0.5), w('two', 0.5, 1.0), w('three', 1.0, 1.5)];
    const result = buildAssFile(words, 0, 5, STYLE, 'TestTitle');
    const dialogues = result.split('\n').filter((l) => l.startsWith('Dialogue:') && l.includes(',Default,'));
    expect(dialogues).toHaveLength(2);
    expect(dialogues[0]).toContain('one two');
    expect(dialogues[1]).toContain('three');
  });

  it('rebases word timestamps to clip-relative ASS time format H:MM:SS.cc', () => {
    // Word at source-time 5.25 → 5.5 should appear as 0:00:00.25 → 0:00:00.50 when clip starts at 5.0
    const words = [w('hi', 5.25, 5.5)];
    const result = buildAssFile(words, 5, 10, STYLE, 'TestTitle');
    const dialogue = result.split('\n').find((l) => l.startsWith('Dialogue:') && l.includes(',Default,'))!;
    expect(dialogue).toContain('0,0:00:00.25,0:00:00.50,Default,hi');
  });

  it('applies position=bottom → ASS Alignment 2', () => {
    const words = [w('hi', 0, 0.5)];
    const result = buildAssFile(words, 0, 5, { ...STYLE, position: 'bottom' }, 'TestTitle');
    const styleLine = result.split('\n').find((l) => l.startsWith('Style: Default,'))!;
    // Format row order: Name, Fontname, Fontsize, PrimaryColour, OutlineColour,
    // BorderStyle, Outline, Alignment, MarginV, Encoding → Alignment is column 8 (index 7).
    const cols = styleLine.replace(/^Style:\s*/, '').split(',');
    expect(cols[7]).toBe('2');
  });

  it('applies position=middle → ASS Alignment 5', () => {
    const words = [w('hi', 0, 0.5)];
    const result = buildAssFile(words, 0, 5, { ...STYLE, position: 'middle' }, 'TestTitle');
    const styleLine = result.split('\n').find((l) => l.startsWith('Style: Default,'))!;
    const cols = styleLine.replace(/^Style:\s*/, '').split(',');
    expect(cols[7]).toBe('5');
  });

  it('places Default style baseline inside the bottom bar (MarginV=120)', () => {
    const words = [w('hi', 0, 0.5)];
    const result = buildAssFile(words, 0, 5, STYLE, 'TestTitle');
    const defaultLine = result.split('\n').find((l) => l.startsWith('Style: Default,'))!;
    const cols = defaultLine.replace(/^Style:\s*/, '').split(',');
    // Format row: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BorderStyle,Outline,Alignment,MarginV,Encoding
    // MarginV is column 9 (index 8). Changed from 200 → 120 to land inside the 240px bottom bar.
    expect(cols[8]).toBe('120');
  });

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

  it('clamps cue end to clip end when a word straddles the boundary', () => {
    // word ends at 6.5 but clip ends at 6.0 → cue end should be 6.0 (= 1.0 clip-relative)
    const words = [w('hi', 5.5, 6.5)];
    const result = buildAssFile(words, 5, 6, STYLE, 'TestTitle');
    const dialogue = result.split('\n').find((l) => l.startsWith('Dialogue:') && l.includes(',Default,'))!;
    expect(dialogue).toContain('0,0:00:00.50,0:00:01.00,Default,hi');
  });

  it('applies a minimum cue duration of 0.30s for very short stutters', () => {
    // word "uh" lasts 0.05s — should be padded to at least 0.30s for readability
    const words = [w('uh', 0, 0.05)];
    const result = buildAssFile(words, 0, 5, STYLE, 'TestTitle');
    const dialogue = result.split('\n').find((l) => l.startsWith('Dialogue:') && l.includes(',Default,'))!;
    expect(dialogue).toContain('0,0:00:00.00,0:00:00.30,Default,uh');
  });

  it('escapes ASS-significant characters in word text', () => {
    // ASS uses { for override tags; literal { needs to be escaped as \{
    // Newlines in word text would break the Dialogue line.
    const words = [w('a{b}', 0, 0.5), w('c\nd', 0.5, 1.0)];
    const result = buildAssFile(words, 0, 5, STYLE, 'TestTitle');
    const dialogue = result.split('\n').find((l) => l.startsWith('Dialogue:') && l.includes(',Default,'))!;
    // Both words on one line (cue groups them); { escaped, \n replaced with space.
    expect(dialogue).toContain('a\\{b\\} c d');
  });

  it('escapes ASS-significant characters in the title text', () => {
    const result = buildAssFile([], 0, 5, STYLE, 'a{b}\\c');
    const titleDialogue = result
      .split('\n')
      .find((l) => l.startsWith('Dialogue:') && l.includes(',Title,'))!;
    // { and } escaped to \{ \}; backslash escaped to \\.
    expect(titleDialogue).toContain(',Title,a\\{b\\}\\\\c');
  });
});
