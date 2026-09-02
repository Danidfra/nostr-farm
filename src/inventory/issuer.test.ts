import { describe, expect, it } from 'vitest';

import { FARM_ISSUER_PUBKEY } from './constants';
import { abbreviate, canEditItem, describeIssuer, describeSigner, isFarmIssuer, issuerLabel, safeNpub } from './issuer';

const EXTERNAL = 'b'.repeat(64);

describe('official Farm issuer detection', () => {
  it('recognises the configured Farm issuer', () => {
    expect(isFarmIssuer(FARM_ISSUER_PUBKEY)).toBe(true);
    expect(describeIssuer(FARM_ISSUER_PUBKEY).kind).toBe('official');
    expect(issuerLabel('official')).toBe('Official Farm Item');
  });

  it('is configured with a well-formed 32-byte hex pubkey', () => {
    expect(FARM_ISSUER_PUBKEY).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exposes the issuer as an inspectable npub', () => {
    const identity = describeIssuer(FARM_ISSUER_PUBKEY);
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
    expect(isFarmIssuer(FARM_ISSUER_PUBKEY.toUpperCase())).toBe(false);
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
    const signer = describeSigner(FARM_ISSUER_PUBKEY);
    expect(signer.mode).toBe('official');
    expect(signer.isOfficialIssuer).toBe(true);
  });
});

describe('edit permission', () => {
  it('permits editing only when the signer IS the item issuer', () => {
    expect(canEditItem(FARM_ISSUER_PUBKEY, FARM_ISSUER_PUBKEY)).toBe(true);
    expect(canEditItem(EXTERNAL, EXTERNAL)).toBe(true);
  });

  it('refuses editing an item issued by somebody else', () => {
    expect(canEditItem(EXTERNAL, FARM_ISSUER_PUBKEY)).toBe(false);
    expect(canEditItem(FARM_ISSUER_PUBKEY, EXTERNAL)).toBe(false);
  });

  it('refuses editing when signed out', () => {
    expect(canEditItem(null, FARM_ISSUER_PUBKEY)).toBe(false);
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
