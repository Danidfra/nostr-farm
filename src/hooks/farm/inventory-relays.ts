import type { NPool, NostrEvent, NostrFilter } from '@nostrify/nostrify';

import { buildGameInventoryFilter } from '@/inventory/package';
import { ITEM_REGISTRY_RELAYS } from '@/inventory/constants';
import { FARM_INVENTORY_D } from '@/inventory/farm-inventory';
import type { InventoryReadResult, PublishOutcome } from '@/inventory/credit-harvest';

/**
 * Relay plumbing for kind:31633.
 *
 * The Farm's world state (31415/31416/31417) stays on the game relay — it is
 * nobody else's business. The inventory does not: the entire point is that
 * another client can find it, so it uses the same cross-client relay set the
 * Item Registry already publishes definitions to.
 */
export const INVENTORY_RELAYS = ITEM_REGISTRY_RELAYS;

const READ_TIMEOUT_MS = 6000;
const PUBLISH_TIMEOUT_MS = 8000;

/**
 * Is this failure a definite "no" from the relay, or just silence?
 *
 * A timeout or abort means the event may still have been accepted, which is a
 * different situation from a relay that answered with a rejection. Treating the
 * two alike is what turns a retry into a duplicate credit.
 */
function isIndefinite(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return name === 'TimeoutError' || name === 'AbortError' || message.includes('timeout') || message.includes('abort');
}

export function readFarmInventory(nostr: NPool, ownerPubkey: string, signal?: AbortSignal) {
  return async (): Promise<InventoryReadResult> => {
    // The package's filter type is a precise literal shape; Nostrify wants its
    // open-ended one. The values are identical.
    const filter = buildGameInventoryFilter({
      authors: [ownerPubkey],
      inventoryIds: [FARM_INVENTORY_D],
    }) as unknown as NostrFilter;

    const results = await Promise.all(
      INVENTORY_RELAYS.map(async (relay) => {
        try {
          const events = await nostr.relay(relay).query([filter], {
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
              : AbortSignal.timeout(READ_TIMEOUT_MS),
          });
          return { ok: true as const, events };
        } catch {
          return { ok: false as const, events: [] as NostrEvent[] };
        }
      })
    );

    return {
      events: results.flatMap((result) => result.events),
      // One relay answering is enough to have *an* answer; every relay failing
      // is not an empty inventory, it is an unusable read.
      answered: results.some((result) => result.ok),
    };
  };
}

export function publishFarmInventory(nostr: NPool) {
  return async (event: NostrEvent): Promise<PublishOutcome> => {
    const results = await Promise.all(
      INVENTORY_RELAYS.map(async (relay) => {
        try {
          await nostr.relay(relay).event(event, { signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS) });
          return { relay, ok: true as const, indefinite: false, error: '' };
        } catch (error) {
          return {
            relay,
            ok: false as const,
            indefinite: isIndefinite(error),
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    const acceptedRelays = results.filter((result) => result.ok).map((result) => result.relay);
    const errors = results.filter((result) => !result.ok).map(({ relay, error }) => ({ relay, error }));

    if (acceptedRelays.length > 0) return { status: 'accepted', acceptedRelays, errors };

    // Nobody accepted. If any relay merely went quiet, the event may still have
    // landed there, so the honest answer is "unknown".
    const status = results.some((result) => result.indefinite) ? 'ambiguous' : 'rejected';
    return { status, acceptedRelays, errors };
  };
}
