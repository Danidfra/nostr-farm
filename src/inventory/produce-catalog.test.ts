import { describe, expect, it } from 'vitest';

import { FARM_OFFICIAL_ISSUER_PUBKEY } from './constants';
import {
  PRODUCE_CATALOG,
  PRODUCE_CROP_IDS,
  PRODUCE_DEFINITION_RELAY_HINT,
  getProduceByAddress,
  getProduceForCrop,
} from './produce-catalog';

const ISSUER = FARM_OFFICIAL_ISSUER_PUBKEY;

describe('crop to official produce mapping', () => {
  it.each([
    ['carrot', `31632:${ISSUER}:farm:produce:carrot`],
    ['parsnip', `31632:${ISSUER}:farm:produce:parsnip`],
    ['pumpkin', `31632:${ISSUER}:farm:produce:pumpkin`],
    ['strawberry', `31632:${ISSUER}:farm:produce:strawberry`],
  ])('maps %s to its exact official address', (cropId, address) => {
    expect(getProduceForCrop(cropId)?.address).toBe(address);
  });

  it('covers exactly the four V1 crops', () => {
    expect(PRODUCE_CROP_IDS).toEqual(['carrot', 'parsnip', 'pumpkin', 'strawberry']);
  });

  it('always uses the official issuer, never a bare d', () => {
    for (const cropId of PRODUCE_CROP_IDS) {
      const produce = PRODUCE_CATALOG[cropId];
      expect(produce.address.startsWith(`31632:${ISSUER}:`)).toBe(true);
      expect(produce.address).not.toBe(produce.itemId);
    }
  });

  it('carries a relay hint where the definitions are actually published', () => {
    for (const cropId of PRODUCE_CROP_IDS) {
      expect(PRODUCE_CATALOG[cropId].relayHint).toBe(PRODUCE_DEFINITION_RELAY_HINT);
      expect(PRODUCE_CATALOG[cropId].relayHint).toMatch(/^wss:\/\//);
    }
  });

  it('gives every crop a display name and a badge', () => {
    for (const cropId of PRODUCE_CROP_IDS) {
      expect(PRODUCE_CATALOG[cropId].name.length).toBeGreaterThan(0);
      expect(PRODUCE_CATALOG[cropId].emoji.length).toBeGreaterThan(0);
    }
  });
});

describe('unmapped crops', () => {
  it('rejects an unknown crop rather than guessing an address', () => {
    expect(getProduceForCrop('moonfruit')).toBeUndefined();
    expect(getProduceForCrop('')).toBeUndefined();
    expect(getProduceForCrop(undefined)).toBeUndefined();
  });
});

describe('reverse lookup', () => {
  it('resolves an address back to its crop', () => {
    expect(getProduceByAddress(`31632:${ISSUER}:farm:produce:pumpkin`)?.cropId).toBe('pumpkin');
  });

  it('does not match the same d under a different issuer', () => {
    expect(getProduceByAddress(`31632:${'b'.repeat(64)}:farm:produce:pumpkin`)).toBeUndefined();
  });
});
