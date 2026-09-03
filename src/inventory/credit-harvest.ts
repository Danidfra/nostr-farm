import type { NostrEvent } from '@nostrify/nostrify';

import {
  buildGameInventoryFoldEvent,
  toBuildGameInventoryFoldInput,
  type GameInventory,
  type GameInventoryDerivedState,
  type GameInventoryFoldProblem,
  type UnsignedEventTemplate,
  type KIND_GAME_INVENTORY,
  type KIND_GAME_INVENTORY_FOLD,
} from './package';
import {
  buildCreditEvent,
  emptyFarmInventory,
  isHarvestCredited,
  nextCreatedAt,
  produceQuantity,
  selectNewestInventory,
} from './farm-inventory';
import { describeUnresolved, loadFarmInventoryState, type FarmInventoryReadDeps } from './effective-inventory';
import type { ProduceDefinition } from './produce-catalog';
import type { EventReference, InventoryReadResult, PublishOutcome } from './relay-io';

export type { InventoryReadResult, PublishOutcome, PublishStatus } from './relay-io';

/**
 * The Farm's one kind:31633 write transaction.
 *
 * Deliberately framework-free: it takes a small dependency object rather than
 * hooks, so every branch — including the ones that only happen when a relay
 * misbehaves — is reachable in a test.
 *
 * Since the spend protocol, the transaction does two things in one replace:
 *
 * ```text
 * confirmed read of the snapshot
 *   → resolve its fold chain and read the pending kind:1416 spends
 *   → derive: pending spends → applied / rejected; effective = snapshot − applied
 *   → if anything was applied or rejected: sign + publish a kind:1417 settling it
 *   → add the harvested produce to the EFFECTIVE inventory
 *   → sign + publish the kind:31633 (referencing the new manifest, if any)
 * ```
 *
 * The order of the middle steps is the whole point. Spends are settled against
 * the inventory as it stood BEFORE the harvest, so a spend that overdrew is
 * voided and stays void — it does not spring back to life because this write
 * happens to add stock. Then, and only then, is the harvest added.
 */

export type SignableTemplate = UnsignedEventTemplate<typeof KIND_GAME_INVENTORY | typeof KIND_GAME_INVENTORY_FOLD> & {
  created_at: number;
};

export interface CreditDeps extends FarmInventoryReadDeps {
  ownerPubkey: string;
  /** Authoritative read of the owner's `farm:main` inventory. */
  readInventory(): Promise<InventoryReadResult>;
  /** Signs a kind:31633 snapshot or a kind:1417 manifest. Only the owner may sign either. */
  signEvent(template: SignableTemplate): Promise<NostrEvent>;
  /** Offer an event to the Farm's configured inventory relays. */
  publish(event: NostrEvent): Promise<PublishOutcome>;
  nowSec(): number;
  /** The relay written into references the Farm creates, so others can resolve them. */
  relayHint: string;
}

export interface CreditRequest {
  produce: ProduceDefinition;
  /** The kind:31417 plant event being consumed. */
  consumedEventId: string;
  consumedEventRelay: string;
  /**
   * A kind:1417 this client signed earlier for the same inventory whose
   * settlement was never confirmed by a snapshot — the publish timed out, or
   * the snapshot after it failed. When the manifest this attempt needs is the
   * SAME manifest (same base fold, same applied set, same voided set), the
   * signed event is republished as-is rather than re-signed: a manifest is
   * identified by its id, and signing a second identical one only leaves a
   * competing orphan behind. It is never treated as settled on its own.
   */
  unconfirmedFold?: NostrEvent;
}

export type CreditResult =
  /** The credit was published and at least one relay accepted it. */
  | {
      status: 'accepted';
      /** The raw snapshot the write started from, or `null` for a first inventory. */
      inventory: GameInventory | null;
      event: NostrEvent;
      /** The manifest this snapshot newly references, when spends were settled. */
      fold?: NostrEvent;
      /** Every manifest and spend the derivation saw, for the caller's cache. */
      folds: NostrEvent[];
      spends: NostrEvent[];
      /** Effective quantity of the harvested produce after this credit. */
      quantity: number;
    }
  /** This exact harvest was already credited; nothing was published. */
  | { status: 'already-applied'; inventory: GameInventory; quantity: number }
  /**
   * A definite failure. Nothing was credited; the caller may retry safely. A
   * `fold` here was ACCEPTED by relays but its snapshot was not: it is an
   * orphan, settles nothing, and may be reused by the retry.
   */
  | { status: 'rejected'; error: string; fold?: NostrEvent }
  /**
   * The snapshot's fold chain could not be verified, so no balance exists to
   * write on top of. Nothing was signed. Not a relay failure: retrying only
   * helps once the missing or broken manifest becomes retrievable.
   */
  | { status: 'unresolved'; error: string; problems: GameInventoryFoldProblem[] }
  /**
   * The manifest's publish returned no acceptance and no rejection, and it
   * could not be found by id afterwards. Nothing was credited and no snapshot
   * was published, so a retry is safe; it should carry `fold` back in as
   * `unconfirmedFold` so the same manifest is republished instead of re-signed.
   */
  | { status: 'fold-unconfirmed'; fold: NostrEvent; error: string }
  /**
   * The SNAPSHOT may or may not have landed. NOT retryable as another `+1`: a
   * later attempt re-reads and finds the marker if it did land. `fold`, when
   * present, was accepted and is at worst an orphan.
   */
  | { status: 'ambiguous'; event: NostrEvent; error: string; fold?: NostrEvent };

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
 * check, spend settlement, lossless rebuild, revision bump, monotonic
 * timestamp, strict publish — manifest first, snapshot second.
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

  // Effective state FIRST. With no snapshot, the derivation runs against an
  // empty one: any spend found is an overdraw and gets voided, rather than
  // being left pending to debit the very unit this harvest adds.
  const loaded = await loadFarmInventoryState(deps, base ?? emptyFarmInventory(deps.ownerPubkey));
  if (loaded.status === 'error') return { status: 'rejected', error: loaded.error };
  if (loaded.status === 'unresolved') {
    return {
      status: 'unresolved',
      error: `Your inventory's settlement records could not be verified, so it was left untouched: ${describeUnresolved(loaded.problems)}`,
      problems: loaded.problems,
    };
  }

  const credit = {
    base: base ? loaded.inventory : null,
    produce: request.produce,
    consumedEventId: request.consumedEventId,
    consumedEventRelay: request.consumedEventRelay,
  };

  // Preflight the Farm's own mutation against the effective inventory BEFORE
  // anything is published, so a rule the package enforces — an overflowing
  // stack, a malformed address — fails here and leaves no orphan manifest.
  try {
    buildCreditEvent(credit);
  } catch (error) {
    return { status: 'rejected', error: `Could not build the inventory update: ${describe(error)}` };
  }

  // Settle the pending spends as evaluated against the PRE-HARVEST state.
  const settled = await establishFold(deps, loaded.state, request.unconfirmedFold);
  if (settled.status !== 'ok') return settled.result;
  const { fold, foldReference } = settled;

  // Only now: the Farm's own mutation, on top of the effective inventory,
  // referencing the manifest that settled the spends it was derived with.
  let template: UnsignedEventTemplate<typeof KIND_GAME_INVENTORY>;
  try {
    template = buildCreditEvent({ ...credit, ...(foldReference ? { fold: foldReference } : {}) });
  } catch (error) {
    return { status: 'rejected', error: `Could not build the inventory update: ${describe(error)}`, ...withFold(fold) };
  }

  let signed: NostrEvent;
  try {
    signed = await deps.signEvent({ ...template, created_at: nextCreatedAt(base, deps.nowSec()) });
  } catch (error) {
    return { status: 'rejected', error: `Signing was rejected: ${describe(error)}`, ...withFold(fold) };
  }

  const outcome = await deps.publish(signed);
  const quantity = produceQuantity(loaded.inventory, request.produce.address) + 1;

  if (outcome.status === 'accepted') {
    return {
      status: 'accepted',
      inventory: base,
      event: signed,
      ...withFold(fold),
      folds: fold ? [...loaded.folds, fold] : loaded.folds,
      spends: loaded.spends,
      quantity,
    };
  }
  if (outcome.status === 'ambiguous') {
    return { status: 'ambiguous', event: signed, error: summarize(outcome), ...withFold(fold) };
  }
  return { status: 'rejected', error: summarize(outcome), ...withFold(fold) };
}

type EstablishFoldResult =
  | { status: 'ok'; fold?: NostrEvent; foldReference?: EventReference }
  | { status: 'failed'; result: CreditResult };

/**
 * Publish the manifest that settles this derivation's pending spends, if any.
 *
 * - Nothing applied and nothing rejected → no manifest. The snapshot keeps the
 *   base's fold reference (`toBuildGameInventoryInput` carries it through).
 * - Otherwise the package classifies: applied → `spend`, rejected → `void`,
 *   previous → the base's current fold. The Farm adds only relay hints.
 * - An earlier signed-but-unconfirmed manifest is reused when it is the same
 *   manifest; otherwise a new one is signed.
 * - The manifest MUST be accepted before the snapshot is even built. A
 *   snapshot pointing at a manifest nobody can retrieve leaves every reader
 *   unable to derive a balance; an accepted manifest nobody references is
 *   harmless.
 */
async function establishFold(
  deps: CreditDeps,
  state: GameInventoryDerivedState,
  unconfirmed: NostrEvent | undefined
): Promise<EstablishFoldResult> {
  const input = toBuildGameInventoryFoldInput(state);
  if (!input) return { status: 'ok' };

  let template: UnsignedEventTemplate<typeof KIND_GAME_INVENTORY_FOLD>;
  try {
    template = buildGameInventoryFoldEvent({
      ...input,
      inventoryRelay: deps.relayHint,
      alt: describeFold(state),
    });
  } catch (error) {
    return { status: 'failed', result: { status: 'rejected', error: `Could not build the settlement record: ${describe(error)}` } };
  }

  let fold: NostrEvent;
  if (unconfirmed && isSameManifest(unconfirmed, template)) {
    fold = unconfirmed;
  } else {
    try {
      fold = await deps.signEvent({ ...template, created_at: deps.nowSec() });
    } catch (error) {
      return { status: 'failed', result: { status: 'rejected', error: `Signing was rejected: ${describe(error)}` } };
    }
  }

  const outcome = await deps.publish(fold);
  if (outcome.status === 'accepted') {
    return { status: 'ok', fold, foldReference: { eventId: fold.id, relay: outcome.acceptedRelays[0] ?? deps.relayHint } };
  }
  if (outcome.status === 'rejected') {
    return {
      status: 'failed',
      result: { status: 'rejected', error: `The settlement record was not accepted, so nothing was credited. ${summarize(outcome)}` },
    };
  }

  // Ambiguous: the manifest is immutable and identified by id, so look for
  // that exact id before ever considering a replacement. Found means it is
  // established; not found means "unknown", which is reported as such and
  // never papered over with a second signature.
  const check = await deps.readFoldsById([{ eventId: fold.id, relay: deps.relayHint }]);
  if (check.events.some((event) => event.id === fold.id)) {
    return { status: 'ok', fold, foldReference: { eventId: fold.id, relay: deps.relayHint } };
  }
  return {
    status: 'failed',
    result: {
      status: 'fold-unconfirmed',
      fold,
      error: `Could not confirm the settlement record reached a relay, so nothing was credited. ${summarize(outcome)}`,
    },
  };
}

/**
 * Is this signed manifest the one the template describes?
 *
 * The builder's tag order is deterministic and the Farm always builds from the
 * same inputs, so tag-for-tag equality is exact equality of what the manifest
 * settles: same inventory, same previous, same spends, same voids.
 */
export function isSameManifest(signed: NostrEvent, template: UnsignedEventTemplate<typeof KIND_GAME_INVENTORY_FOLD>): boolean {
  return (
    signed.kind === template.kind &&
    signed.content === template.content &&
    JSON.stringify(signed.tags) === JSON.stringify(template.tags)
  );
}

function describeFold(state: GameInventoryDerivedState): string {
  const parts: string[] = [];
  if (state.applied.length > 0) parts.push(`${state.applied.length} spend${state.applied.length === 1 ? '' : 's'} folded`);
  if (state.rejected.length > 0) parts.push(`${state.rejected.length} voided`);
  return `Farm inventory settlement: ${parts.join(', ')}`;
}

function withFold(fold: NostrEvent | undefined): { fold?: NostrEvent } {
  return fold ? { fold } : {};
}

/**
 * Decide whether an ambiguous credit actually landed.
 *
 * Re-reads and looks for the marker. This never publishes and never credits: it
 * only converts "unknown" into a definite answer when the evidence is there.
 * The quantity reported is the raw snapshot's; the read model derives the
 * effective one.
 */
export async function reconcileCredit(
  deps: Pick<CreditDeps, 'ownerPubkey' | 'readInventory'>,
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
