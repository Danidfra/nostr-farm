import { useCallback, useSyncExternalStore } from 'react';

import { ITEM_REGISTRY_RELAYS } from '@/inventory/constants';
import { dedupeRelayUrls } from '@/lib/relay-routing';
import { GAME_RELAY_URLS } from '@/nostr/relays';
import { relaySync, type PrimarySyncStatus } from '@/nostr/relay-sync';

/**
 * How the primary relay stands with what this device has published or read in
 * this session. For the About dialog: a primary relay that refused or did not
 * answer never blocks an action, so this is where it is said.
 */
export function useRelaySyncStatus(): PrimarySyncStatus {
  return useSyncExternalStore(relaySync.subscribe, relaySync.status, relaySync.status);
}

/**
 * Every relay a copy of an existing record could be sent to: the game relays
 * and the inventory/registry relays. This is the list the account is shown,
 * and exactly the list its answer covers.
 */
export const SYNC_DESTINATIONS: readonly string[] = Object.freeze(dedupeRelayUrls([...GAME_RELAY_URLS, ...ITEM_REGISTRY_RELAYS]));

export interface RelaySyncConsentControl {
  /** The relays that would receive copies. */
  destinations: readonly string[];
  /** On for this account AND covering every relay in `destinations`. */
  enabled: boolean;
  /** Relays added since the account answered. Until it answers again, nothing is copied to them. */
  uncovered: readonly string[];
  enable(): void;
  disable(): void;
}

/**
 * The account's choice to have its existing records copied between relays.
 * Off until the account turns it on; per pubkey; never on when signed out.
 */
export function useRelaySyncConsent(pubkey: string | undefined): RelaySyncConsentControl {
  const record = useSyncExternalStore(
    relaySync.subscribe,
    () => relaySync.consent.get(pubkey),
    () => relaySync.consent.get(pubkey)
  );
  const uncovered = relaySync.consent.uncovered(pubkey, SYNC_DESTINATIONS);
  const enable = useCallback(() => {
    if (pubkey) relaySync.consent.enable(pubkey, SYNC_DESTINATIONS);
  }, [pubkey]);
  const disable = useCallback(() => {
    if (pubkey) relaySync.consent.disable(pubkey);
  }, [pubkey]);

  return {
    destinations: SYNC_DESTINATIONS,
    enabled: !!pubkey && record?.enabled === true && uncovered.length === 0,
    uncovered: record?.enabled ? uncovered : [],
    enable,
    disable,
  };
}
