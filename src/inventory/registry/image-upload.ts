import { GAME_ITEM_IMAGE_MARKERS } from '@/inventory/package';
import { PRIMARY_MARKER } from './form-model';

/**
 * Guess a view marker from a filename.
 *
 * Ordered longest-pattern-first: `carrot-diagonal-front-right.png` must not
 * match the `front` rule, and `carrot-side-left.png` must not match a bare
 * `left`. Returns {@link PRIMARY_MARKER} when nothing matches, which is the
 * right default — an unmarked image is the primary one.
 *
 * A suggestion is always shown for editing before it is applied. A wrong
 * marker is invisible until something renders the wrong view.
 */
export function suggestMarkerFromFilename(filename: string): string {
  const name = filename.toLowerCase().replace(/\.[a-z0-9]+$/, '');

  const patterns: readonly [RegExp, string][] = [
    [/diagonal[-_]?front[-_]?right|diag[-_]?fr\b/, 'diagonal-front-right'],
    [/diagonal[-_]?front[-_]?left|diag[-_]?fl\b/, 'diagonal-front-left'],
    [/side[-_]?right|[-_]right$/, 'side-right'],
    [/side[-_]?left|[-_]left$/, 'side-left'],
    [/[-_]back$|[-_]back[-_]/, 'back'],
    [/[-_]front$|[-_]front[-_]/, 'front'],
  ];

  for (const [pattern, marker] of patterns) {
    if (pattern.test(name)) return marker;
  }
  return PRIMARY_MARKER;
}

/** Every marker a suggestion may produce. */
export const SUGGESTABLE_MARKERS: readonly string[] = [PRIMARY_MARKER, ...GAME_ITEM_IMAGE_MARKERS];

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error';

export interface UploadEntry {
  id: string;
  file: File;
  filename: string;
  /** Editable; seeded from {@link suggestMarkerFromFilename}. */
  marker: string;
  status: UploadStatus;
  url?: string;
  error?: string;
}

/**
 * Pull the URL out of the NIP-94 style tag list a Blossom upload returns.
 *
 * STRICT ON PURPOSE. Only an explicit `["url", "<value>"]` tag counts, and the
 * value must parse as an `http:`/`https:` URL. The previous version fell back
 * to the first tag of any name, which meant a response shaped differently —
 * `["x", "<sha256>"]` first, say — would put a hash, or any other metadata
 * string, into an `image` tag and publish it as an item's artwork. An upload
 * that yields no usable URL is a failed upload, not an item with a broken
 * image.
 */
export function urlFromUploadTags(tags: readonly string[][]): string | undefined {
  const value = tags.find(([name]) => name === 'url')?.[1]?.trim();
  if (!value) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;

  return value;
}
