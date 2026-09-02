import type { UnixSeconds } from '../time';
import type { PlantState } from '../growth/types';

/** Position of a slot inside its map grid. */
export interface SlotCoord {
  x: number;
  y: number;
}

/** Nothing planted here. `lastHarvestedAt` is set after a harvest or clear. */
export interface EmptySlotContent {
  type: 'empty';
  lastHarvestedAt?: UnixSeconds;
}

/** A slot holding one crop. */
export interface PlantSlotContent {
  type: 'plant';
  plant: PlantState;
}

export type SlotContent = EmptySlotContent | PlantSlotContent;

/** A single addressable cell of a farm map. */
export interface FarmSlot {
  coord: SlotCoord;
  content: SlotContent;
}

export function emptySlot(coord: SlotCoord, lastHarvestedAt?: UnixSeconds): FarmSlot {
  return { coord, content: lastHarvestedAt === undefined ? { type: 'empty' } : { type: 'empty', lastHarvestedAt } };
}

export function isPlanted(slot: FarmSlot): slot is FarmSlot & { content: PlantSlotContent } {
  return slot.content.type === 'plant';
}
