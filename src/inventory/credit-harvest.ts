import type { NostrEvent } from '@nostrify/nostrify';

import type { GameInventory, UnsignedEventTemplate, KIND_GAME_INVENTORY } from './package';
import {
  buildCreditEvent,
  isHarvestCredited,
  nextCreatedAt,
  produceQuantity,
  selectNewestInventory,
} from './farm-inventory';
import type { ProduceDefinition } from './produce-catalog';

/**
 * The Farm's one kind:31633 write transaction.
 *
 * Deliberately framework-free: it takes a small dependency object rather than
 * hooks, so every branch — including the ones that only happen when a relay
 * misbehaves — is reachable in a test.
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
  /** Events the relays returned for this filter. */
  events: NostrEvent[];
  /** True when at least one relay answered without erroring. */
  answered: boolean;
}

export interface CreditDeps {
  ownerPubkey: string;
  /** Authoritative read of the owner's `farm:main` inventory. */
  readInventory(): Promise<InventoryReadResult>;
  signEvent(template: UnsignedEventTemplate<typeof KIND_GAME_INVENTORY> & { created_at: number }): Promise<NostrEvent>;
  publish(event: NostrEvent): Promise<PublishOutcome>;
  nowSec(): number;
}

export interface CreditRequest {
  produce: ProduceDefinition;
  /** The kind:31417 plant event being consumed. */
  consumedEventId: string;
  consumedEventRelay: string;
}

export type CreditResult =
  /** The credit was published and at least one relay accepted it. */
  | { status: 'accepted'; inventory: GameInventory | null; event: NostrEvent; quantity: number }
  /** This exact harvest was already credited; nothing was published. */
  | { status: 'already-applied'; inventory: GameInventory; quantity: number }
  /** A definite failure. Nothing was credited; the caller may retry safely. */
  | { status: 'rejected'; error: string }
  /**
   * The event may or may not have landed. NOT retryable as another `+1`: a
   * later attempt re-reads and finds the marker if it did land.
   */
  | { status: 'ambiguous'; event: NostrEvent; error: string };

/**
 * A read that resolved to no inventory is AMBIGUOUS, not proof of an empty one.
 *
 * Either the player genuinely has none, or a relay does not carry the event, or
 * it has not caught up. Building a replacement from an unconfirmed empty base
 * replaces the player's whole inventory with a one-item one — a defect that has
 * actually shipped in this ecosystem before. So an empty result is re-read once
 * before it is believed, and an unusable read fails the operation instead of
 * degrading into "no inventory".
 */
async function readConfirmedBase(deps: CreditDeps): Promise<{ base: GameInventory | null } | { error: string }> {
  const first = await deps.readInventory();
  if (!first.answered) return { error: 'No relay answered when reading your inventory.' };

  const base = selectNewestInventory(first.events, deps.ownerPubkey);
  if (base) return { base };

  const confirm = await deps.readInventory();
  if (!confirm.answered) return { error: 'No relay answered when confirming your inventory is empty.' };

  const confirmed = selectNewestInventory(confirm.events, deps.ownerPubkey);
  return { base: confirmed };
}

/**
 * Credit one unit of produce for one harvested plant.
 *
 * The caller is responsible for serializing this against other writes — see
 * `withSerializedWrite`. Everything else is here: confirmed read, idempotency
 * check, lossless rebuild, revision bump, monotonic timestamp, strict publish.
 */
export async function creditHarvest(deps: CreditDeps, request: CreditRequest): Promise<CreditResult> {
  const read = await readConfirmedBase(deps);
  if ('error' in read) return { status: 'rejected', error: read.error };

  const { base } = read;

  // Idempotency, before anything is built or signed.
  if (base && isHarvestCredited(base, request.consumedEventId)) {
    return {
      status: 'already-applied',
      inventory: base,
      quantity: produceQuantity(base, request.produce.address),
    };
  }

  let template: UnsignedEventTemplate<typeof KIND_GAME_INVENTORY>;
  try {
    template = buildCreditEvent({
      base,
      produce: request.produce,
      consumedEventId: request.consumedEventId,
      consumedEventRelay: request.consumedEventRelay,
    });
  } catch (error) {
    return { status: 'rejected', error: `Could not build the inventory update: ${describe(error)}` };
  }

  let signed: NostrEvent;
  try {
    signed = await deps.signEvent({ ...template, created_at: nextCreatedAt(base, deps.nowSec()) });
  } catch (error) {
    return { status: 'rejected', error: `Signing was rejected: ${describe(error)}` };
  }

  const outcome = await deps.publish(signed);
  const quantity = produceQuantity(base, request.produce.address) + 1;

  if (outcome.status === 'accepted') return { status: 'accepted', inventory: base, event: signed, quantity };
  if (outcome.status === 'ambiguous') {
    return { status: 'ambiguous', event: signed, error: summarize(outcome) };
  }
  return { status: 'rejected', error: summarize(outcome) };
}

/**
 * Decide whether an ambiguous credit actually landed.
 *
 * Re-reads and looks for the marker. This never publishes and never credits: it
 * only converts "unknown" into a definite answer when the evidence is there.
 */
export async function reconcileCredit(
  deps: CreditDeps,
  request: Pick<CreditRequest, 'consumedEventId' | 'produce'>
): Promise<{ credited: boolean; inventory: GameInventory | null; quantity: number }> {
  const read = await deps.readInventory();
  if (!read.answered) return { credited: false, inventory: null, quantity: 0 };

  const inventory = selectNewestInventory(read.events, deps.ownerPubkey);
  return {
    credited: !!inventory && isHarvestCredited(inventory, request.consumedEventId),
    inventory,
    quantity: produceQuantity(inventory, request.produce.address),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarize(outcome: PublishOutcome): string {
  if (outcome.errors.length === 0) return 'No relay accepted the inventory update.';
  return outcome.errors.map((entry) => `${entry.relay}: ${entry.error}`).join('; ');
}
