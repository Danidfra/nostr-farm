import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ITEM_REGISTRY_RELAYS } from '@/inventory/constants';
import { GAME_RELAY_URLS, PRIMARY_RELAY_URL } from '@/nostr/relays';
import { relaySync } from '@/nostr/relay-sync';
import { SYNC_DESTINATIONS, useRelaySyncConsent } from './useRelaySyncStatus';

const ACCOUNT = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);

afterEach(() => {
  relaySync.consent.disable(ACCOUNT);
  relaySync.consent.disable(OTHER);
});

describe('the "Copy existing records" control', () => {
  it('lists every relay a copy could go to, primary first', () => {
    expect(SYNC_DESTINATIONS[0]).toBe(PRIMARY_RELAY_URL);
    for (const relay of [...GAME_RELAY_URLS, ...ITEM_REGISTRY_RELAYS]) expect(SYNC_DESTINATIONS).toContain(relay);
  });

  it('is off by default, turns on for exactly the relays shown, and can be turned off again', () => {
    const { result } = renderHook(() => useRelaySyncConsent(ACCOUNT));
    expect(result.current.enabled).toBe(false);

    act(() => result.current.enable());
    expect(result.current.enabled).toBe(true);
    expect(relaySync.consent.get(ACCOUNT)?.destinations).toEqual([...SYNC_DESTINATIONS]);

    act(() => result.current.disable());
    expect(result.current.enabled).toBe(false);
    expect(relaySync.consent.allows(ACCOUNT, PRIMARY_RELAY_URL)).toBe(false);
  });

  it('is per account, and never on when signed out', () => {
    relaySync.consent.enable(OTHER, SYNC_DESTINATIONS);

    expect(renderHook(() => useRelaySyncConsent(ACCOUNT)).result.current.enabled).toBe(false);
    const signedOut = renderHook(() => useRelaySyncConsent(undefined));
    act(() => signedOut.result.current.enable());
    expect(signedOut.result.current.enabled).toBe(false);
  });

  it('reads as off, and says which relays are new, when the account agreed to a shorter list', () => {
    relaySync.consent.enable(ACCOUNT, SYNC_DESTINATIONS.slice(1));

    const { result } = renderHook(() => useRelaySyncConsent(ACCOUNT));

    expect(result.current.enabled).toBe(false);
    expect(result.current.uncovered).toEqual([PRIMARY_RELAY_URL]);
  });
});
