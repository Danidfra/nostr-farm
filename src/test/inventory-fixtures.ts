import type { NostrEvent } from '@nostrify/nostrify';

import { KIND_GAME_INVENTORY, buildGameInventoryEvent, parseGameInventoryResult, type GameInventory } from '@/inventory/package';
import { INVENTORY_KINDS } from '@/inventory/package';
import { FARM_INVENTORY_D, farmInventoryAddress } from '@/inventory/farm-inventory';
import { FARM_GAME_CONTEXT } from '@/inventory/constants';
import { PRODUCE_CATALOG } from '@/inventory/produce-catalog';

/**
 * Test fixtures for the spend protocol as the Farm sees it.
 *
 * kind:1416 and kind:1417 events are written out tag by tag rather than through
 * the package's builders on purpose: the Farm never publishes a spend, so the
 * boundary does not expose that builder, and spelling the wire format out here
 * is an independent check that the Farm reads what the spec says.
 */

export const OWNER = 'a'.repeat(64);
export const STRANGER = 'b'.repeat(64);
export const FARM_ADDRESS = farmInventoryAddress(OWNER);
/** Another inventory context of the same player, owned by some other game. */
export const OTHER_GAME_ADDRESS = `31633:${OWNER}:other:main`;
export const RELAY = 'wss://relay.primal.net';

export const STRAWBERRY = PRODUCE_CATALOG.strawberry;
export const CARROT = PRODUCE_CATALOG.carrot;

/** A 64-hex-looking id from a short label, sortable the way the label sorts. */
export function eventId(label: string): string {
  return label.padEnd(64, '0');
}

export interface SpendSpec {
  id: string;
  createdAt?: number;
  pubkey?: string;
  inventory?: string;
  item?: string;
  quantity?: number;
  extraTags?: string[][];
}

/** A kind:1416 as another game would publish it, signed by the player. */
export function spendEvent(spec: SpendSpec): NostrEvent {
  return {
    id: spec.id,
    kind: INVENTORY_KINDS.spend,
    pubkey: spec.pubkey ?? OWNER,
    created_at: spec.createdAt ?? 1_700_000_000,
    content: '',
    sig: 'x'.repeat(128),
    tags: [
      ['a', spec.inventory ?? FARM_ADDRESS, RELAY, 'inventory'],
      ['a', spec.item ?? STRAWBERRY.address, '', 'item'],
      ['quantity', String(spec.quantity ?? 1)],
      ['client', 'another-game'],
      ...(spec.extraTags ?? []),
    ],
  };
}

export interface FoldSpec {
  id: string;
  createdAt?: number;
  pubkey?: string;
  inventory?: string;
  previous?: { eventId: string; relay?: string };
  spends?: string[];
  voids?: string[];
}

/** A kind:1417 manifest. */
export function foldEvent(spec: FoldSpec): NostrEvent {
  return {
    id: spec.id,
    kind: INVENTORY_KINDS.fold,
    pubkey: spec.pubkey ?? OWNER,
    created_at: spec.createdAt ?? 1_700_000_000,
    content: '',
    sig: 'x'.repeat(128),
    tags: [
      ['a', spec.inventory ?? FARM_ADDRESS, RELAY, 'inventory'],
      ...(spec.previous ? [['e', spec.previous.eventId, spec.previous.relay ?? '', 'previous']] : []),
      ...(spec.spends ?? []).map((id) => ['e', id, '', 'spend']),
      ...(spec.voids ?? []).map((id) => ['e', id, '', 'void']),
    ],
  };
}

export interface SnapshotSpec {
  id?: string;
  createdAt?: number;
  pubkey?: string;
  /** Item address → quantity. */
  items?: Record<string, number>;
  fold?: { eventId: string; relay?: string };
  revision?: number;
  extraTags?: string[][];
}

/** A signed-looking `farm:main` kind:31633 built through the real builder. */
export function snapshotEvent(spec: SnapshotSpec = {}): NostrEvent {
  const template = buildGameInventoryEvent({
    id: FARM_INVENTORY_D,
    contexts: [FARM_GAME_CONTEXT],
    items: Object.entries(spec.items ?? {}).map(([address, quantity]) => ({ address, quantity })),
    ...(spec.fold ? { fold: { eventId: spec.fold.eventId, relay: spec.fold.relay ?? '' } } : {}),
    ...(spec.revision !== undefined ? { revision: spec.revision } : {}),
    ...(spec.extraTags ? { extraTags: spec.extraTags } : {}),
  });
  return {
    ...template,
    kind: KIND_GAME_INVENTORY,
    id: spec.id ?? eventId('snap'),
    pubkey: spec.pubkey ?? OWNER,
    created_at: spec.createdAt ?? 1_700_000_000,
    sig: 'x'.repeat(128),
  };
}

export function snapshot(spec: SnapshotSpec = {}): GameInventory {
  const parsed = parseGameInventoryResult(snapshotEvent(spec), { mode: 'permissive' });
  if (!parsed.ok) throw new Error(`fixture snapshot did not parse: ${parsed.error}`);
  return parsed.value;
}

export function parseSnapshot(event: NostrEvent): GameInventory {
  const parsed = parseGameInventoryResult(event, { mode: 'permissive' });
  if (!parsed.ok) throw new Error(`event did not parse as an inventory: ${parsed.error}`);
  return parsed.value;
}

/** The `e` tag marked `fold` on a snapshot event, if any. */
export function foldTag(event: NostrEvent | undefined): string[] | undefined {
  return event?.tags.find((tag) => tag[0] === 'e' && tag[3] === 'fold');
}

/** Spend ids a manifest lists under `marker` (`spend` / `void` / `previous`). */
export function foldRefs(event: NostrEvent | undefined, marker: 'spend' | 'void' | 'previous'): string[] {
  return (event?.tags ?? []).filter((tag) => tag[0] === 'e' && tag[3] === marker).map((tag) => tag[1]);
}
