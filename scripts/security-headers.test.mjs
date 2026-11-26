import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The page ships its Content-Security-Policy twice: as a <meta> in
 * index.html (the only policy GitHub Pages can serve) and as a response
 * header in vercel.json (the official site). A <meta> policy cannot carry
 * `frame-ancestors`, so the header holds that one; every directive that
 * both sources declare must agree, so the two deployments enforce the same
 * policy.
 */

/** @param {string} policy */
function parsePolicy(policy) {
  /** @type {Map<string, string[]>} */
  const directives = new Map();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (!name) continue;
    directives.set(name.toLowerCase(), values);
  }
  return directives;
}

function metaPolicy() {
  const html = readFileSync('index.html', 'utf8');
  const metas = [...html.matchAll(/<meta\s+http-equiv="content-security-policy"\s+content="([^"]*)"/gi)];
  expect(metas, 'index.html declares exactly one CSP meta').toHaveLength(1);
  return parsePolicy(metas[0][1]);
}

function vercelHeaders() {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const all = config.headers.find((/** @type {{ source: string }} */ rule) => rule.source === '/(.*)');
  expect(all, 'vercel.json sets headers on every path').toBeDefined();
  /** @type {Map<string, string>} */
  const headers = new Map();
  for (const { key, value } of all.headers) headers.set(key.toLowerCase(), value);
  return headers;
}

describe('meta Content-Security-Policy', () => {
  it('denies everything not listed and never allows eval', () => {
    const policy = metaPolicy();
    expect(policy.get('default-src')).toEqual(["'none'"]);
    expect(policy.get('script-src')).toEqual(["'self'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
    for (const values of policy.values()) {
      expect(values).not.toContain("'unsafe-eval'");
    }
  });

  it('embeds no frames: the app has no iframe, and NIP-46 signers talk over WebSockets', () => {
    expect(metaPolicy().get('frame-src')).toEqual(["'none'"]);
  });

  it('only lets forms submit to the app itself (form-action has no default-src fallback)', () => {
    expect(metaPolicy().get('form-action')).toEqual(["'self'"]);
  });

  it('leaves frame-ancestors to the header, where browsers enforce it', () => {
    expect(metaPolicy().has('frame-ancestors')).toBe(false);
  });
});

describe('vercel.json security headers', () => {
  it('forbids framing, sniffing and full referrers', () => {
    const headers = vercelHeaders();
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    const policy = parsePolicy(headers.get('content-security-policy') ?? '');
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('agrees with the meta policy on every directive both declare', () => {
    const header = parsePolicy(vercelHeaders().get('content-security-policy') ?? '');
    const meta = metaPolicy();
    for (const [name, values] of header) {
      if (meta.has(name)) expect(values, name).toEqual(meta.get(name));
    }
  });
});
