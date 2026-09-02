import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const FARM_DIR = join(process.cwd(), 'src', 'farm');
const SRC_DIR = join(process.cwd(), 'src');

function walk(dir: string, filter: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

const isSource = (p: string) => /\.tsx?$/.test(p);
const isProductionSource = (p: string) => isSource(p) && !/\.test\.tsx?$/.test(p);

/**
 * These guards are the teeth behind the architecture rules. They are cheap and
 * they fail loudly the first time somebody reaches for a shortcut.
 */
describe('src/farm stays a pure domain', () => {
  const files = walk(FARM_DIR, isProductionSource);

  it('contains source files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each([
    ['React', /from\s+['"]react/],
    ['Nostr libraries', /from\s+['"](@nostrify|nostr-tools)/],
    ['TanStack Query', /from\s+['"]@tanstack/],
    ['application modules outside the domain', /from\s+['"]@\/(?!farm)/],
    ['relative escapes out of src/farm', /from\s+['"]\.\.\/\.\.\//],
  ])('never imports %s', (_label, pattern) => {
    const offenders = files.filter((f) => pattern.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(process.cwd(), f))).toEqual([]);
  });

  it.each([
    ['Date.now', /\bDate\.now\s*\(/],
    ['new Date', /\bnew\s+Date\s*\(/],
    ['performance.now', /\bperformance\.now\s*\(/],
    ['window/document', /\b(window|document)\s*\./],
    ['localStorage', /\blocalStorage\b/],
    ['fetch', /\bfetch\s*\(/],
  ])('never reads %s directly', (_label, pattern) => {
    // `systemClock` in time.ts is the single sanctioned Date.now, and it is only
    // ever called by the application layer.
    const offenders = files
      .filter((f) => !f.endsWith(join('farm', 'time.ts')))
      .filter((f) => pattern.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(process.cwd(), f))).toEqual([]);
  });
});

describe('no Blobbi coupling anywhere in src', () => {
  it('does not mention blobbi', () => {
    const offenders = walk(SRC_DIR, isSource)
      .filter((f) => !f.endsWith(join('farm', 'purity.test.ts')))
      .filter((f) => /blobbi/i.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(process.cwd(), f))).toEqual([]);
  });
});
