import { describe, expect, it } from 'vitest';

import { DEV_TOOLS_ENABLED } from '@/dev/enabled';
import { FARM_OFFICIAL_ISSUER_PUBKEY } from '@/inventory/constants';
import { DEV_FARM_TOOLS_PUBKEY, canUseDevFarmTools } from './access';

const AUTHORIZED = DEV_FARM_TOOLS_PUBKEY;
const STRANGER = 'b'.repeat(64);

describe('canUseDevFarmTools', () => {
  it('is available when the build opted in and the authorized key is signed in', () => {
    expect(canUseDevFarmTools({ enabled: true, pubkey: AUTHORIZED })).toBe(true);
  });

  it('is unavailable to any other key in an opted-in build', () => {
    expect(canUseDevFarmTools({ enabled: true, pubkey: STRANGER })).toBe(false);
  });

  it('is unavailable when logged out, even in an opted-in build', () => {
    expect(canUseDevFarmTools({ enabled: true, pubkey: undefined })).toBe(false);
    expect(canUseDevFarmTools({ enabled: true, pubkey: '' })).toBe(false);
  });

  it('is unavailable to the authorized key when the build did not opt in', () => {
    expect(canUseDevFarmTools({ enabled: false, pubkey: AUTHORIZED })).toBe(false);
  });

  it('is off in the default configuration this test suite runs under', () => {
    // No `__DEV_TOOLS_ENABLED__` literal is defined here, exactly like a
    // production build without the flag.
    expect(DEV_TOOLS_ENABLED).toBe(false);
    expect(canUseDevFarmTools({ enabled: DEV_TOOLS_ENABLED, pubkey: AUTHORIZED })).toBe(false);
  });

  it('compares the normalized hex public key, never an npub or a prefix', () => {
    expect(canUseDevFarmTools({ enabled: true, pubkey: AUTHORIZED.toUpperCase() })).toBe(true);
    expect(canUseDevFarmTools({ enabled: true, pubkey: AUTHORIZED.slice(0, 63) })).toBe(false);
    expect(canUseDevFarmTools({ enabled: true, pubkey: `npub1${AUTHORIZED}` })).toBe(false);
  });

  it('is the official Farm issuer identity, reused rather than invented', () => {
    expect(DEV_FARM_TOOLS_PUBKEY).toBe(FARM_OFFICIAL_ISSUER_PUBKEY);
    expect(DEV_FARM_TOOLS_PUBKEY).toMatch(/^[0-9a-f]{64}$/);
  });
});
