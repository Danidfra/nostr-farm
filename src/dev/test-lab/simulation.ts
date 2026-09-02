import { CROP_CATALOG, getCrop } from '@/farm/crops/catalog';
import type { CropCatalog, CropDefinition } from '@/farm/crops/types';
import { evaluatePlant, plantSeed, waterPlant, type PlantState, type PlantView } from '@/farm/growth';
import { applyFarmAction, emptySlot, type FarmActionType, type FarmSlot } from '@/farm/slots';
import type { UnixSeconds } from '@/farm/time';

/**
 * Simulation-only farm state for the dev test lab.
 *
 * Everything here is pure and offline: no relay, no signer, no publishing.
 * It drives the same `src/farm` functions the real game uses, so a bug
 * reproduced here is a bug in the shipped domain.
 */
export interface SimState {
  nowSec: UnixSeconds;
  cols: number;
  rows: number;
  slots: Record<string, FarmSlot>;
  log: string[];
}

export const SIM_EPOCH: UnixSeconds = 1_800_000_000;

export function slotId(x: number, y: number): string {
  return `${x}:${y}`;
}

export function createSimState(cols: number, rows: number, nowSec: UnixSeconds = SIM_EPOCH): SimState {
  const slots: Record<string, FarmSlot> = {};
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) slots[slotId(x, y)] = emptySlot({ x, y });
  }
  return { nowSec, cols, rows, slots, log: [`reset at t=${nowSec}`] };
}

export function getSimSlot(state: SimState, x: number, y: number): FarmSlot {
  return state.slots[slotId(x, y)] ?? emptySlot({ x, y });
}

function withSlot(state: SimState, slot: FarmSlot, message: string): SimState {
  return {
    ...state,
    slots: { ...state.slots, [slotId(slot.coord.x, slot.coord.y)]: slot },
    log: [message, ...state.log].slice(0, 100),
  };
}

function note(state: SimState, message: string): SimState {
  return { ...state, log: [message, ...state.log].slice(0, 100) };
}

/** Move the virtual clock. Negative deltas are allowed, to test clock skew. */
export function advanceClock(state: SimState, deltaSec: number): SimState {
  const nowSec = state.nowSec + Math.trunc(deltaSec);
  return note({ ...state, nowSec }, `clock ${deltaSec >= 0 ? '+' : ''}${Math.trunc(deltaSec)}s -> t=${nowSec}`);
}

/** Run a real domain action, exactly as the game would. */
export function runAction(
  state: SimState,
  coord: { x: number; y: number },
  type: FarmActionType,
  cropId?: string,
  catalog: CropCatalog = CROP_CATALOG
): SimState {
  const slot = getSimSlot(state, coord.x, coord.y);
  const result = applyFarmAction(slot, { type, nowSec: state.nowSec, cropId }, catalog);

  if (!result.ok) return note(state, `${type} ${slotId(coord.x, coord.y)} rejected: ${result.reason}`);

  const suffix = result.harvest ? ` -> ${result.harvest.quantity}x ${result.harvest.cropId}` : '';
  return withSlot(state, result.slot, `${type} ${slotId(coord.x, coord.y)} ok${suffix}`);
}

/** Overwrite a slot with hand-built plant state. This bypasses the rules on purpose. */
export function forcePlant(state: SimState, coord: { x: number; y: number }, plant: PlantState, label: string): SimState {
  return withSlot(state, { coord, content: { type: 'plant', plant } }, `force ${label} at ${slotId(coord.x, coord.y)}`);
}

/** Jump a plant straight to a stage by writing the growth it would have banked. */
export function forceStage(state: SimState, coord: { x: number; y: number }, stage: number, catalog: CropCatalog = CROP_CATALOG): SimState {
  const slot = getSimSlot(state, coord.x, coord.y);
  if (slot.content.type !== 'plant') return note(state, 'force stage: nothing planted');

  const crop = getCrop(slot.content.plant.cropId, catalog);
  if (!crop) return note(state, 'force stage: unknown crop');

  const clamped = Math.max(0, Math.min(Math.trunc(stage), crop.harvestStage));
  return forcePlant(
    state,
    coord,
    {
      ...slot.content.plant,
      growthSec: clamped * crop.stageDurationSec,
      growthUpdatedAt: state.nowSec,
      wetUntil: Math.max(slot.content.plant.wetUntil, state.nowSec),
    },
    `stage ${clamped}`
  );
}

/** Make a plant dry right now, without touching its banked growth. */
export function forceDry(state: SimState, coord: { x: number; y: number }): SimState {
  const slot = getSimSlot(state, coord.x, coord.y);
  if (slot.content.type !== 'plant') return note(state, 'force dry: nothing planted');

  const plant = slot.content.plant;
  return forcePlant(
    state,
    coord,
    { ...plant, growthSec: bankedAt(plant, state.nowSec), growthUpdatedAt: state.nowSec, wetUntil: state.nowSec },
    'dry'
  );
}

/** Make a plant wet for exactly one watering, ignoring the saturation rule. */
export function forceWet(state: SimState, coord: { x: number; y: number }, catalog: CropCatalog = CROP_CATALOG): SimState {
  const slot = getSimSlot(state, coord.x, coord.y);
  if (slot.content.type !== 'plant') return note(state, 'force wet: nothing planted');

  const crop = getCrop(slot.content.plant.cropId, catalog);
  if (!crop) return note(state, 'force wet: unknown crop');

  return forcePlant(state, coord, waterPlant(slot.content.plant, state.nowSec, crop), 'wet');
}

/** Put a plant one action away from harvest. */
export function forceReady(state: SimState, coord: { x: number; y: number }, catalog: CropCatalog = CROP_CATALOG): SimState {
  const slot = getSimSlot(state, coord.x, coord.y);
  if (slot.content.type !== 'plant') return note(state, 'force ready: nothing planted');

  const crop = getCrop(slot.content.plant.cropId, catalog);
  if (!crop) return note(state, 'force ready: unknown crop');

  return forceStage(state, coord, crop.harvestStage, catalog);
}

/** Push a plant past its rot deadline. */
export function forceRotten(state: SimState, coord: { x: number; y: number }, catalog: CropCatalog = CROP_CATALOG): SimState {
  const slot = getSimSlot(state, coord.x, coord.y);
  if (slot.content.type !== 'plant') return note(state, 'force rot: nothing planted');

  const crop = getCrop(slot.content.plant.cropId, catalog);
  if (!crop) return note(state, 'force rot: unknown crop');

  const plant = slot.content.plant;
  return forcePlant(
    state,
    coord,
    { ...plant, growthSec: bankedAt(plant, state.nowSec), growthUpdatedAt: state.nowSec, wetUntil: state.nowSec - crop.rotAfterDrySec },
    'rotten'
  );
}

/** Inject deliberately broken state, to prove the reader survives it. */
export const MALFORMED_PRESETS = {
  'negative growth': (nowSec: UnixSeconds): PlantState => ({ cropId: 'carrot', plantedAt: nowSec, growthSec: -9999, growthUpdatedAt: nowSec, wetUntil: nowSec + 300 }),
  'wet for 10 years': (nowSec: UnixSeconds): PlantState => ({ cropId: 'carrot', plantedAt: nowSec, growthSec: 0, growthUpdatedAt: nowSec, wetUntil: nowSec + 315_360_000 }),
  'planted in the future': (nowSec: UnixSeconds): PlantState => ({ cropId: 'carrot', plantedAt: nowSec + 86_400, growthSec: 0, growthUpdatedAt: nowSec + 86_400, wetUntil: nowSec + 86_700 }),
  'unknown crop': (nowSec: UnixSeconds): PlantState => ({ cropId: 'moonfruit', plantedAt: nowSec, growthSec: 0, growthUpdatedAt: nowSec, wetUntil: nowSec }),
  'NaN timestamps': (_nowSec: UnixSeconds): PlantState => ({ cropId: 'carrot', plantedAt: Number.NaN, growthSec: Number.NaN, growthUpdatedAt: Number.NaN, wetUntil: Number.NaN }),
} as const;

export type MalformedPreset = keyof typeof MALFORMED_PRESETS;

export function injectMalformed(state: SimState, coord: { x: number; y: number }, preset: MalformedPreset): SimState {
  return forcePlant(state, coord, MALFORMED_PRESETS[preset](state.nowSec), `malformed "${preset}"`);
}

/** Derived view of a slot, or a reason it cannot be evaluated. */
export interface SimSlotInspection {
  slot: FarmSlot;
  crop?: CropDefinition;
  view?: PlantView;
  problem?: string;
}

export function inspectSlot(state: SimState, coord: { x: number; y: number }, catalog: CropCatalog = CROP_CATALOG): SimSlotInspection {
  const slot = getSimSlot(state, coord.x, coord.y);
  if (slot.content.type !== 'plant') return { slot };

  const crop = getCrop(slot.content.plant.cropId, catalog);
  if (!crop) return { slot, problem: `crop "${slot.content.plant.cropId}" is not in the catalog` };

  try {
    return { slot, crop, view: evaluatePlant(slot.content.plant, state.nowSec, crop) };
  } catch (error) {
    return { slot, crop, problem: error instanceof Error ? error.message : String(error) };
  }
}

function bankedAt(plant: PlantState, nowSec: UnixSeconds): number {
  return Math.max(0, plant.growthSec) + Math.max(0, Math.min(nowSec, plant.wetUntil) - plant.growthUpdatedAt);
}

/** Convenience for the lab's "spawn" button. */
export function spawnCrop(state: SimState, coord: { x: number; y: number }, cropId: string): SimState {
  return forcePlant(state, coord, plantSeed(cropId, state.nowSec), `spawn ${cropId}`);
}
