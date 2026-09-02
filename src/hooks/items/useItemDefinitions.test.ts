import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { FARM_OFFICIAL_ISSUER_PUBKEY } from '@/inventory/constants';
import { AllRelaysFailedError, collectDefinitions, type RelayQueryResult } from './useItemDefinitions';

function definition(d: string, createdAt = 1, pubkey: string = FARM_OFFICIAL_ISSUER_PUBKEY): NostrEvent {
  return {
    id: `${d}-${createdAt}`.padEnd(64, '0'),
    pubkey,
    created_at: createdAt,
    kind: 31632,
    tags: [['d', d], ['name', d], ['type', 'consumable']],
    content: '',
    sig: 'x'.repeat(128),
  };
}

const ok = (relay: string, events: NostrEvent[]): RelayQueryResult => ({ relay, events });
const failed = (relay: string, error = 'connection refused'): RelayQueryResult => ({ relay, events: [], error });

describe('relay outcomes', () => {
  it('uses the results of the relays that succeeded', () => {
    const items = collectDefinitions([
      failed('wss://a'),
      ok('wss://b', [definition('farm:produce:carrot')]),
      failed('wss://c'),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].definition.id).toBe('farm:produce:carrot');
  });

  it('throws when EVERY relay failed, rather than reporting an empty registry', () => {
    expect(() => collectDefinitions([failed('wss://a'), failed('wss://b'), failed('wss://c')])).toThrow(
      AllRelaysFailedError
    );
  });

  it('names every failed relay and its reason in the error', () => {
    try {
      collectDefinitions([failed('wss://a', 'timeout'), failed('wss://b', 'refused')]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AllRelaysFailedError);
      expect((error as Error).message).toContain('wss://a — timeout');
      expect((error as Error).message).toContain('wss://b — refused');
    }
  });

  it('returns an empty list when relays succeeded but hold nothing', () => {
    expect(collectDefinitions([ok('wss://a', []), ok('wss://b', [])])).toEqual([]);
  });

  it('returns an empty list when a relay answered with only unparseable events', () => {
    const junk: NostrEvent = { ...definition('x'), kind: 1 };
    expect(collectDefinitions([ok('wss://a', [junk])])).toEqual([]);
  });

  it('treats no relays at all as empty rather than as total failure', () => {
    expect(collectDefinitions([])).toEqual([]);
  });
});

describe('de-duplication across relays', () => {
  it('keeps the newest event per address', () => {
    const items = collectDefinitions([
      ok('wss://a', [definition('farm:produce:carrot', 1)]),
      ok('wss://b', [definition('farm:produce:carrot', 5)]),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].event.created_at).toBe(5);
  });

  it('keeps two issuers using the same d as two different items', () => {
    const items = collectDefinitions([
      ok('wss://a', [definition('shared:d', 1), definition('shared:d', 1, 'b'.repeat(64))]),
    ]);

    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.address)).size).toBe(2);
  });

  it('records the extra relay when the same event arrives twice', () => {
    const event = definition('farm:produce:carrot', 3);
    const items = collectDefinitions([ok('wss://a', [event]), ok('wss://b', [event])]);

    expect(items).toHaveLength(1);
    expect(items[0].relays).toEqual(['wss://a', 'wss://b']);
  });
});
