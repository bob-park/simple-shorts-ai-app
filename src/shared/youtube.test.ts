import { describe, expect, it } from 'vitest';

import { extractVideoId, isYoutubeUrl, sanitizeFilename } from './youtube';

describe('isYoutubeUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', true],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ', true],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', true],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', true],
    ['https://youtu.be/dQw4w9WgXcQ', true],
    ['https://www.youtube.com/shorts/abc123', true],
    ['  https://www.youtube.com/watch?v=abc  ', true],
    ['https://vimeo.com/123', false],
    ['https://example.com/youtube.com/watch?v=abc', false],
    ['not a url', false],
    ['', false],
  ])('isYoutubeUrl(%s) === %s', (input, expected) => {
    expect(isYoutubeUrl(input)).toBe(expected);
  });
});

describe('extractVideoId', () => {
  it('reads ?v= from a standard watch URL', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('reads the path from a youtu.be short link', () => {
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('reads the path from a /shorts/<id> URL', () => {
    expect(extractVideoId('https://www.youtube.com/shorts/abc123')).toBe('abc123');
  });

  it('returns null for non-YouTube hosts', () => {
    expect(extractVideoId('https://vimeo.com/123')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(extractVideoId('not a url')).toBeNull();
  });

  it('returns null when no v param and not a short or shorts link', () => {
    expect(extractVideoId('https://www.youtube.com/feed/trending')).toBeNull();
  });
});

describe('sanitizeFilename', () => {
  it.each([
    ['Me at the zoo', 'Me at the zoo'],
    ['Hello/World', 'Hello_World'],
    ['Hello: World!', 'Hello_ World!'],
    ['  hi  ', 'hi'],
    ['', ''],
    ['     ', ''],
    ['...hidden', '_hidden'],
    ['Hello              World', 'Hello World'],
    ['/////', ''],
    ['<>:"/\\|?*', ''],
    ['안녕 세상 영상', '안녕 세상 영상'],
  ])('sanitizeFilename(%j) === %j', (input, expected) => {
    expect(sanitizeFilename(input, 20)).toBe(expected);
  });

  it('truncates to maxLen and trims trailing whitespace/_', () => {
    expect(sanitizeFilename('a'.repeat(30), 20)).toBe('a'.repeat(20));
    // 18 chars + 2 chars that get sliced off → trailing space gets trimmed
    expect(sanitizeFilename('Lorem ipsum dolor sit amet', 20)).toBe('Lorem ipsum dolor si');
  });

  it('trims trailing dot or underscore created by truncation', () => {
    expect(sanitizeFilename('twenty.twenty.twenty.twenty', 20)).toBe('twenty.twenty.twenty');
    expect(sanitizeFilename('a/b/c/d/e/f/g/h/i/j/k/X', 20)).toBe('a_b_c_d_e_f_g_h_i_j');
  });
});
