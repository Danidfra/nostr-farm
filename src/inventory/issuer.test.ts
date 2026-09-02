import { describe, expect, it } from 'vitest';

import { FARM_OFFICIAL_ISSUER_PUBKEY } from './constants';
import { abbreviate, canEditItem, describeIssuer, describeSigner, isFarmIssuer, issuerLabel, safeNpub } from './issuer';

const EXTERNAL = 'b'.repeat(64);

describe('official Farm issuer detection', () => {
  it('recognises the configured Farm issuer', () => {
    expect(isFarmIssuer(FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(true);
    expect(describeIssuer(FARM_OFFICIAL_ISSUER_PUBKEY).kind).toBe('official');
    expect(issuerLabel('official')).toBe('Official Farm Item');
  });

  it('is configured with a well-formed 32-byte hex pubkey', () => {
    expect(FARM_OFFICIAL_ISSUER_PUBKEY).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the one canonical Farm identity, fixed in source', () => {
    expect(FARM_OFFICIAL_ISSUER_PUBKEY).toBe(
      'f47aaf2e3279fe6fcdde556336d1f740705126c9a37e6390e2ede21165199fb4'
    );
    expect(safeNpub(FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(
      'npub173a27t3j08lxlnw7243nd50hgpc9zfkf5dlx8y8zah3pzegen76q8fl9lm'
    );
  });

  it('cannot be redirected by any environment variable', async () => {
    // "Official" is a claim about one specific public identity. A build-time
    // variable that could point it elsewhere would let an operator forge the
    // badge, so the constant must not read configuration at all.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(process.cwd(), 'src/inventory/constants.ts'), 'utf8');

    expect(source).not.toContain('import.meta.env');
    expect(source).not.toContain('process.env');
    expect(source).not.toMatch(/VITE_[A-Z_]*ISSUER/);
  });

  it('exposes the issuer as an inspectable npub', () => {
    const identity = describeIssuer(FARM_OFFICIAL_ISSUER_PUBKEY);
    expect(identity.npub).toMatch(/^npub1/);
    expect(identity.short).toContain('…');
  });
});

describe('external issuer detection', () => {
  it('classifies any other pubkey as external', () => {
    expect(isFarmIssuer(EXTERNAL)).toBe(false);
    expect(describeIssuer(EXTERNAL).kind).toBe('external');
    expect(issuerLabel('external')).toBe('External Item');
  });

  it('treats a missing pubkey as not-official rather than throwing', () => {
    expect(isFarmIssuer(undefined)).toBe(false);
    expect(isFarmIssuer(null)).toBe(false);
    expect(isFarmIssuer('')).toBe(false);
  });

  it('does not mark an external item invalid — it stays inspectable', () => {
    const identity = describeIssuer(EXTERNAL);
    expect(identity.pubkey).toBe(EXTERNAL);
    expect(identity.npub).toMatch(/^npub1/);
  });

  it('is case-sensitive, so a differently-cased key is not the issuer', () => {
    expect(isFarmIssuer(FARM_OFFICIAL_ISSUER_PUBKEY.toUpperCase())).toBe(false);
  });
});

describe('signer identity', () => {
  it('reports a signed-out user as unable to publish', () => {
    const signer = describeSigner(null);
    expect(signer.mode).toBe('signed-out');
    expect(signer.canPublish).toBe(false);
    expect(signer.isOfficialIssuer).toBe(false);
  });

  it('lets an external signer publish, labelled as external', () => {
    const signer = describeSigner(EXTERNAL);
    expect(signer.mode).toBe('external');
    expect(signer.canPublish).toBe(true);
    expect(signer.isOfficialIssuer).toBe(false);
  });

  it('recognises the official issuer as the signer', () => {
    const signer = describeSigner(FARM_OFFICIAL_ISSUER_PUBKEY);
    expect(signer.mode).toBe('official');
    expect(signer.isOfficialIssuer).toBe(true);
  });
});

describe('edit permission', () => {
  it('permits editing only when the signer IS the item issuer', () => {
    expect(canEditItem(FARM_OFFICIAL_ISSUER_PUBKEY, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(true);
    expect(canEditItem(EXTERNAL, EXTERNAL)).toBe(true);
  });

  it('refuses editing an item issued by somebody else', () => {
    expect(canEditItem(EXTERNAL, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(false);
    expect(canEditItem(FARM_OFFICIAL_ISSUER_PUBKEY, EXTERNAL)).toBe(false);
  });

  it('refuses editing when signed out', () => {
    expect(canEditItem(null, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(false);
    expect(canEditItem(undefined, EXTERNAL)).toBe(false);
  });
});

describe('display helpers', () => {
  it('abbreviates long identifiers and leaves short ones alone', () => {
    expect(abbreviate('a'.repeat(64))).toBe(`${'a'.repeat(8)}…${'a'.repeat(6)}`);
    expect(abbreviate('short')).toBe('short');
  });

  it('returns null rather than throwing for a malformed pubkey', () => {
    expect(safeNpub('not-hex')).toBeNull();
    expect(safeNpub(null)).toBeNull();
  });
});
