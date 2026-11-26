import type { NostrEvent } from '@nostrify/nostrify';

import type { GameInventory } from './package';
import type { CreditDeps } from './credit-harvest';
import { isHarvestCredited, selectNewestInventory, snapshotRevision, type HarvestIdentity } from './farm-inventory';

/**
 * What a read of `farm:main`, a few seconds after an accepted credit, says
 * about that credit.
 *
 * This is a check, not a guarantee of durable consensus: it asks the
 * configured relays once and reports what they hold at that moment. A relay
 * can still lose the snapshot later, and a device that is offline by now
 * never asks at all.
 */
export type CreditVerification =
  /** The relays' newest snapshot is ours, or a later one that carries our record. */
  | { status: 'confirmed'; newest: GameInventory }
  /**
   * The relays' newest snapshot is newer than ours and does NOT carry our
   * record: another writer built on an older base and replaced ours. The
   * harvest is missing from the balance everyone now sees.
   */
  | { status: 'overwritten'; newest: GameInventory }
  /** The relays could not say: no answer, no inventory, or a snapshot older than ours. */
  | { status: 'uncertain'; reason: string; newest: GameInventory | null };

export async function verifyCredit(
  deps: Pick<CreditDeps, 'ownerPubkey' | 'readInventory'>,
  written: NostrEvent,
  identity: HarvestIdentity
): Promise<CreditVerification> {
  let read: Awaited<ReturnType<CreditDeps['readInventory']>>;
  try {
    read = await deps.readInventory();
  } catch (error) {
    return { status: 'uncertain', reason: error instanceof Error ? error.message : String(error), newest: null };
  }
  if (!read.answered) return { status: 'uncertain', reason: 'No relay answered.', newest: null };

  const newest = selectNewestInventory(read.events, deps.ownerPubkey);
  if (!newest) return { status: 'uncertain', reason: 'The relays returned no inventory.', newest: null };

  if (newest.event.id === written.id || isHarvestCredited(newest, identity)) return { status: 'confirmed', newest };

  // Older than what we wrote: the relays have not caught up, which says
  // nothing about whether our snapshot will be the one that survives.
  const writtenRevision = snapshotRevision(written);
  const behind =
    newest.event.created_at < written.created_at ||
    (writtenRevision !== undefined && (newest.revision === undefined || newest.revision < writtenRevision));
  if (behind) return { status: 'uncertain', reason: 'The relays returned a snapshot older than the one just written.', newest };

  return { status: 'overwritten', newest };
}
