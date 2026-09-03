import type { NostrEvent } from '@nostrify/nostrify';

/**
 * The shapes the inventory transaction and the read model use to talk to
 * relays. Kept free of any relay client so that every branch of the inventory
 * logic can be driven from a test with a fake world.
 */

/**
 * The outcome of offering an event to relays.
 *
 * Three-valued on purpose. Collapsing a timeout into "failed" is what produces
 * duplicate grants: the publish lands, the acknowledgement does not arrive, the
 * UI offers a retry, and the retry credits a second time. A timeout means
 * "unknown", and unknown is not failure.
 */
export type PublishStatus = 'accepted' | 'rejected' | 'ambiguous';

export interface PublishOutcome {
  status: PublishStatus;
  acceptedRelays: string[];
  errors: { relay: string; error: string }[];
}

export interface InventoryReadResult {
  /** Events the relays returned for this filter, deduplicated by event id. */
  events: NostrEvent[];
  /** True when at least one relay answered without erroring. */
  answered: boolean;
}

/** An event id plus the relay hint a reference carried for it (`""` when unknown). */
export interface EventReference {
  eventId: string;
  relay: string;
}

/**
 * Keep the first copy of every event id. Relays return copies of immutable
 * events; a spend delivered by three relays is still one spend.
 */
export function dedupeEventsById(events: readonly NostrEvent[]): NostrEvent[] {
  const seen = new Set<string>();
  const distinct: NostrEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    distinct.push(event);
  }
  return distinct;
}
