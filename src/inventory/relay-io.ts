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

/**
 * What a read of several relays returned, and how far it can be trusted.
 *
 * A relay "answered" only by reaching `EOSE`. One that closed the
 * subscription, timed out or failed DID NOT ANSWER; it did not answer "I have
 * nothing". The three flags exist because three different claims rest on a
 * read:
 *
 * - `answered`: something can be shown.
 * - `anchored`: what was found may be built on. A write counts only when one
 *   of the flow's secondary relays accepted it, so the newest state is on one
 *   of them; a read none of them finished can be arbitrarily old.
 * - `complete`: an EMPTY result may be believed. Only every relay together
 *   can say an event does not exist.
 */
export interface InventoryReadResult {
  /** Events the relays returned for this filter, deduplicated by event id. */
  events: NostrEvent[];
  /** At least one relay reached `EOSE`. */
  answered: boolean;
  /** At least one relay whose acceptance makes a write count reached `EOSE`. */
  anchored: boolean;
  /** Every relay asked reached `EOSE`. */
  complete: boolean;
}

/** A read every relay finished: the shape of "nothing to read", and of a test's fully answered read. */
export function completeRead(events: NostrEvent[] = []): InventoryReadResult {
  return { events, answered: true, anchored: true, complete: true };
}

/** A read no relay finished. */
export function unansweredRead(): InventoryReadResult {
  return { events: [], answered: false, anchored: false, complete: false };
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
