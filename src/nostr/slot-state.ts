import type { NostrEvent } from '@nostrify/nostrify';

import type { FarmSlot } from '@/farm/slots/types';
import { normalizePlantState } from '@/farm/growth/evaluate';
import { isValidIdentifier, mapRef, parseAddressableRef, parseSlotAddress, slotAddress } from './identifiers';
import { KIND_MAP_STATE, KIND_SLOT_STATE, SCHEMA_VERSION } from './kinds';
import { getIntTag, getTag, getTagValues, type EventTemplate } from './tags';

/**
 * SlotState (kind 31417) — the authoritative state of one grid cell.
 *
 * Only *inputs* are stored. `stage`, `ready_at` and `expires_at` were all
 * derived quantities in v1 and are gone: writing derived state to a relay makes
 * two clients disagree the moment the derivation changes, and it was the reason
 * a background processor had to keep re-publishing slots. Everything is now
 * recomputed from `(planted_at, growth_sec, growth_updated_at, wet_until)`.
 */
export interface SlotStateEvent {
  event: NostrEvent;
  /** `d` tag, `slot:<mapId>:<x>:<y>`. */
  id: string;
  version: string;
  owner: string;
  mapId: string;
  slot: FarmSlot;
}

export interface BuildSlotStateInput {
  mapId: string;
  ownerPubkey: string;
  slot: FarmSlot;
}

export function buildSlotState(input: BuildSlotStateInput): EventTemplate {
  const { coord, content } = input.slot;
  const tags: string[][] = [
    ['d', slotAddress(input.mapId, coord.x, coord.y)],
    ['v', SCHEMA_VERSION],
    ['a', mapRef(input.ownerPubkey, input.mapId)],
    ['slot', String(coord.x), String(coord.y)],
    ['type', content.type],
  ];

  if (content.type === 'plant') {
    const { plant } = content;
    tags.push(
      ['crop', plant.cropId],
      ['planted_at', String(plant.plantedAt)],
      ['growth_sec', String(plant.growthSec)],
      ['growth_updated_at', String(plant.growthUpdatedAt)],
      ['wet_until', String(plant.wetUntil)]
    );
  } else if (content.lastHarvestedAt !== undefined) {
    tags.push(['last_harvested_at', String(content.lastHarvestedAt)]);
  }

  return { kind: KIND_SLOT_STATE, content: '', tags };
}

export function parseSlotState(event: NostrEvent): SlotStateEvent | null {
  if (event.kind !== KIND_SLOT_STATE) return null;

  const id = getTag(event, 'd');
  const version = getTag(event, 'v');
  const address = parseSlotAddress(id);
  const parent = parseAddressableRef(getTag(event, 'a'));

  if (!id || !version || !address) return null;
  if (!parent || parent.kind !== KIND_MAP_STATE) return null;

  // Personal-farm authority: only the map owner may state what is in a slot.
  if (parent.pubkey !== event.pubkey) return null;
  if (!isValidIdentifier(parent.d) || parent.d !== address.mapId) return null;

  // The `slot` tag must agree with the address it was published under.
  const slotTag = getTagValues(event, 'slot');
  if (!slotTag || Number(slotTag[1]) !== address.x || Number(slotTag[2]) !== address.y) return null;

  const coord = { x: address.x, y: address.y };
  const type = getTag(event, 'type');

  if (type === 'empty') {
    const lastHarvestedAt = getIntTag(event, 'last_harvested_at');
    return {
      event,
      id,
      version,
      owner: event.pubkey,
      mapId: address.mapId,
      slot: { coord, content: lastHarvestedAt === undefined ? { type: 'empty' } : { type: 'empty', lastHarvestedAt } },
    };
  }

  if (type !== 'plant') return null;

  const cropId = getTag(event, 'crop');
  if (!cropId) return null;

  const plantedAt = getIntTag(event, 'planted_at') ?? event.created_at;
  const plant = normalizePlantState(
    {
      cropId,
      plantedAt,
      growthSec: getIntTag(event, 'growth_sec'),
      growthUpdatedAt: getIntTag(event, 'growth_updated_at'),
      wetUntil: getIntTag(event, 'wet_until'),
    },
    plantedAt
  );

  return {
    event,
    id,
    version,
    owner: event.pubkey,
    mapId: address.mapId,
    slot: { coord, content: { type: 'plant', plant } },
  };
}

/**
 * Reduce a relay result set to the newest state per slot **for one owner**.
 *
 * The v1 reader de-duplicated on the `d` tag alone, so any pubkey could publish
 * `slot:...:3:2` and win the race on somebody else's farm. The real addressable
 * coordinate is `(pubkey, kind, d)`, and V1 goes further: only the map owner's
 * events are considered at all.
 */
export function collectOwnedSlots(events: NostrEvent[], ownerPubkey: string, mapId: string): Map<string, SlotStateEvent> {
  const byAddress = new Map<string, SlotStateEvent>();

  for (const event of events) {
    if (event.pubkey !== ownerPubkey) continue;
    const parsed = parseSlotState(event);
    if (!parsed || parsed.mapId !== mapId) continue;

    const existing = byAddress.get(parsed.id);
    if (!existing || isNewer(event, existing.event)) byAddress.set(parsed.id, parsed);
  }

  return byAddress;
}

/** NIP-01 replaceable-event tie-break: newest `created_at`, then lowest id. */
function isNewer(candidate: NostrEvent, current: NostrEvent): boolean {
  if (candidate.created_at !== current.created_at) return candidate.created_at > current.created_at;
  return candidate.id < current.id;
}
