import { describe, expect, it } from 'vitest';

import { extractVideoId, isYoutubeUrl } from './youtube';

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
