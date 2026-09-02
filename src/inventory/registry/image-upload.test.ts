import { describe, expect, it } from 'vitest';

import { PRIMARY_MARKER } from './form-model';
import { SUGGESTABLE_MARKERS, suggestMarkerFromFilename, urlFromUploadTags } from './image-upload';

describe('marker suggestion from filename', () => {
  it.each([
    ['carrot.png', PRIMARY_MARKER],
    ['carrot-front.png', 'front'],
    ['carrot-back.png', 'back'],
    ['carrot-side-left.png', 'side-left'],
    ['carrot-side-right.png', 'side-right'],
    ['carrot-diagonal-front-right.png', 'diagonal-front-right'],
    ['carrot-diagonal-front-left.png', 'diagonal-front-left'],
  ])('maps %s to %s', (filename, expected) => {
    expect(suggestMarkerFromFilename(filename)).toBe(expected);
  });

  it('prefers the longest pattern, so a diagonal is not read as a front', () => {
    expect(suggestMarkerFromFilename('hat-diagonal-front-right.png')).toBe('diagonal-front-right');
    expect(suggestMarkerFromFilename('hat-side-left.png')).toBe('side-left');
  });

  it('defaults to the primary image when nothing matches', () => {
    expect(suggestMarkerFromFilename('some-artwork.png')).toBe(PRIMARY_MARKER);
  });

  it('only ever suggests markers the spec defines', () => {
    for (const name of ['a-front.png', 'a-back.png', 'a.png']) {
      expect(SUGGESTABLE_MARKERS).toContain(suggestMarkerFromFilename(name));
    }
  });
});

describe('Blossom upload result', () => {
  it('reads the URL from the url tag', () => {
    expect(urlFromUploadTags([['url', 'https://blossom.primal.net/abc.png'], ['x', 'hash']])).toBe(
      'https://blossom.primal.net/abc.png'
    );
  });

  it('falls back to the first tag when there is no named url tag', () => {
    expect(urlFromUploadTags([['whatever', 'https://blossom.primal.net/abc.png']])).toBe(
      'https://blossom.primal.net/abc.png'
    );
  });

  it('returns undefined for an empty or missing URL rather than a blank image tag', () => {
    expect(urlFromUploadTags([])).toBeUndefined();
    expect(urlFromUploadTags([['url', '']])).toBeUndefined();
    expect(urlFromUploadTags([['url', '   ']])).toBeUndefined();
  });
});
