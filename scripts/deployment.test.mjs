import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DEPLOY_TARGETS,
  findAssetRefsOutsideBase,
  OFFICIAL_ORIGIN,
  resolveDeployTarget,
} from './deploy-target.mjs';

/**
 * The deployment base is a build concern. These tests pin the two targets,
 * the guard that keeps a built HTML file honest about its base, and the
 * source files that must stay base-agnostic for Vite to rebase them.
 */
describe('deploy targets', () => {
  it('builds the official site from the domain root by default', () => {
    expect(resolveDeployTarget({})).toEqual({ name: 'official', base: '/' });
    expect(resolveDeployTarget({ DEPLOY_TARGET: '' })).toEqual({ name: 'official', base: '/' });
    expect(OFFICIAL_ORIGIN).toBe('https://farm.blobbi.pet');
  });

  it('keeps the GitHub Pages project path as an explicit target', () => {
    expect(resolveDeployTarget({ DEPLOY_TARGET: 'github-pages' })).toEqual({
      name: 'github-pages',
      base: '/nostr-farm/',
    });
  });

  it('rejects an unknown target instead of guessing a base', () => {
    expect(() => resolveDeployTarget({ DEPLOY_TARGET: 'netlify' })).toThrow(/github-pages/);
  });

  it('spells every base with a leading and trailing slash', () => {
    for (const base of Object.values(DEPLOY_TARGETS)) {
      expect(base).toMatch(/^\/(?:.*\/)?$/);
    }
  });
});

describe('findAssetRefsOutsideBase', () => {
  const officialHtml = `
    <link rel="icon" href="/favicon.svg">
    <link rel="manifest" href="/manifest.webmanifest">
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-def456.css">
    <link rel="preconnect" href="https://relay.example">`;
  const pagesHtml = officialHtml.replaceAll('="/', '="/nostr-farm/').replace('/nostr-farm/https://', 'https://');

  it('accepts an official build whose references sit at the root', () => {
    expect(findAssetRefsOutsideBase(officialHtml, '/')).toEqual([]);
  });

  it('accepts a Pages build whose references sit under /nostr-farm/', () => {
    expect(findAssetRefsOutsideBase(pagesHtml, '/nostr-farm/')).toEqual([]);
  });

  it('flags stale /nostr-farm/ references in an official build', () => {
    expect(findAssetRefsOutsideBase(pagesHtml, '/')).toEqual([
      '/nostr-farm/favicon.svg',
      '/nostr-farm/manifest.webmanifest',
      '/nostr-farm/assets/index-abc123.js',
      '/nostr-farm/assets/index-def456.css',
    ]);
  });

  it('flags root references in a Pages build', () => {
    expect(findAssetRefsOutsideBase(officialHtml, '/nostr-farm/')).toHaveLength(4);
  });

  it('ignores external and relative references', () => {
    const html = '<link href="https://x.test/a.css"><link href="//x.test/b.css"><img src="icons/icon.svg">';
    expect(findAssetRefsOutsideBase(html, '/')).toEqual([]);
    expect(findAssetRefsOutsideBase(html, '/nostr-farm/')).toEqual([]);
  });
});

describe('index.html', () => {
  const html = readFileSync('index.html', 'utf8');

  it('references static files root-relative so Vite can rebase them per target', () => {
    // Vite rewrites `/x` in index.html to `${base}x`; a hardcoded
    // `/nostr-farm/x` or a relative path would escape that.
    const refs = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map(([, ref]) => ref);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toMatch(/^\//);
      expect(ref).not.toMatch(/^\/nostr-farm\//);
    }
    expect(refs).toContain('/favicon.svg');
    expect(refs).toContain('/manifest.webmanifest');
  });

  it('loads no fonts from a third party', () => {
    // Fonts are self-hosted through @fontsource and served under
    // `font-src 'self'`; a Google Fonts stylesheet would trip the CSP.
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(html).toMatch(/font-src 'self'/);
  });
});

describe('manifest.webmanifest', () => {
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));

  it('describes the app relative to wherever the manifest is served from', () => {
    // A relative start_url and icon paths resolve against the manifest's own
    // URL, so the same file works at `/` and under `/nostr-farm/`.
    expect(manifest.start_url).toBe('.');
    expect(manifest.scope ?? '.').not.toMatch(/^\//);
    for (const icon of manifest.icons) {
      expect(icon.src).not.toMatch(/^\//);
      expect(icon.src).not.toMatch(/^https?:/);
    }
  });
});

describe('vercel.json', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const [rewrite, ...rest] = config.rewrites;

  // Vercel compiles a `/(<regex>)` source with path-to-regexp into exactly
  // this anchored form (verified against @vercel/routing-utils).
  const source = new RegExp(`^(?:${rewrite.source})$`);

  it('has a single SPA fallback to index.html', () => {
    expect(rest).toEqual([]);
    expect(rewrite.destination).toBe('/index.html');
    expect(config.redirects).toBeUndefined();
  });

  it('serves application routes and deep links through the shell', () => {
    for (const route of ['/', '/items', '/dev/inventory', '/npub1abc', '/deep/link']) {
      expect(source.test(route), route).toBe(true);
    }
  });

  it('never rewrites a static asset request to HTML', () => {
    for (const asset of [
      '/assets/index-abc123.js',
      '/assets/index-def456.css',
      '/assets/missing.js',
      '/favicon.svg',
      '/apple-touch-icon.png',
      '/manifest.webmanifest',
      '/icons/icon-192.png',
      '/robots.txt',
    ]) {
      expect(source.test(asset), asset).toBe(false);
    }
  });
});
