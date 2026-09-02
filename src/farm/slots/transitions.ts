import { getCrop } from '../crops/catalog';
import type { CropCatalog } from '../crops/types';
import {
  canAbsorbWater,
  isRotten,
  plantPhase,
  plantSeed,
  totalGrowthSec,
  waterPlant,
} from '../growth/evaluate';
import type { FarmAction, FarmActionResult } from './actions';
import { emptySlot, type FarmSlot } from './types';

/**
 * Pure state transitions for a single slot.
 *
 * Every transition is `(slot, action, catalog) -> result`. Nothing here knows
 * about Nostr, React, signers or the clock. That is the seam that lets a future
 * visitor-action flow reuse this untouched:
 *
 *   visitor publishes intent -> owner validates permission -> owner calls
 *   `applyFarmAction` -> owner publishes the resulting slot state.
 *
 * The owner-side validation in V1 is exactly the same call, with the owner as
 * the actor. Adding remote actors changes who is allowed to ask, not what the
 * rules are.
 */

export function applyFarmAction(slot: FarmSlot, action: FarmAction, catalog: CropCatalog): FarmActionResult {
  switch (action.type) {
    case 'plant':
      return plantAction(slot, action, catalog);
    case 'water':
      return waterAction(slot, action, catalog);
    case 'harvest':
      return harvestAction(slot, action, catalog);
    case 'clear':
      return clearAction(slot, action, catalog);
    default:
      return { ok: false, action: action.type, reason: 'unknown_action' };
  }
}

function plantAction(slot: FarmSlot, action: FarmAction, catalog: CropCatalog): FarmActionResult {
  if (slot.content.type === 'plant') {
    return { ok: false, action: 'plant', reason: 'slot_occupied' };
  }

  const crop = getCrop(action.cropId, catalog);
  if (!crop) {
    return { ok: false, action: 'plant', reason: 'unknown_crop' };
  }

  return {
    ok: true,
    action: 'plant',
    slot: {
      coord: slot.coord,
      content: { type: 'plant', plant: plantSeed(crop.id, action.nowSec) },
    },
  };
}

function waterAction(slot: FarmSlot, action: FarmAction, catalog: CropCatalog): FarmActionResult {
  if (slot.content.type !== 'plant') {
    return { ok: false, action: 'water', reason: 'slot_empty' };
  }

  const { plant } = slot.content;
  const crop = getCrop(plant.cropId, catalog);
  if (!crop) {
    return { ok: false, action: 'water', reason: 'unknown_crop' };
  }

  if (isRotten(plant, action.nowSec, crop)) {
    return { ok: false, action: 'water', reason: 'plant_rotten' };
  }

  // Watering a harvest-ready crop is allowed: it does not grow further, but the
  // extra wetness postpones rot, which is how a player protects a ripe crop.
  if (!canAbsorbWater(plant, action.nowSec, crop)) {
    return { ok: false, action: 'water', reason: 'already_saturated' };
  }

  return {
    ok: true,
    action: 'water',
    slot: {
      coord: slot.coord,
      content: { type: 'plant', plant: waterPlant(plant, action.nowSec, crop) },
    },
  };
}

function harvestAction(slot: FarmSlot, action: FarmAction, catalog: CropCatalog): FarmActionResult {
  if (slot.content.type !== 'plant') {
    return { ok: false, action: 'harvest', reason: 'slot_empty' };
  }

  const { plant } = slot.content;
  const crop = getCrop(plant.cropId, catalog);
  if (!crop) {
    return { ok: false, action: 'harvest', reason: 'unknown_crop' };
  }

  const phase = plantPhase(plant, action.nowSec, crop);
  if (phase === 'rotten') {
    return { ok: false, action: 'harvest', reason: 'plant_rotten' };
  }
  if (phase !== 'ready') {
    return { ok: false, action: 'harvest', reason: 'not_ready' };
  }

  return {
    ok: true,
    action: 'harvest',
    slot: emptySlot(slot.coord, action.nowSec),
    harvest: {
      cropId: plant.cropId,
      quantity: 1,
      harvestedAt: action.nowSec,
      growthSec: totalGrowthSec(plant, action.nowSec),
    },
  };
}

function clearAction(slot: FarmSlot, action: FarmAction, catalog: CropCatalog): FarmActionResult {
  if (slot.content.type !== 'plant') {
    return { ok: false, action: 'clear', reason: 'slot_empty' };
  }

  const { plant } = slot.content;
  const crop = getCrop(plant.cropId, catalog);

  // An unknown crop can never be evaluated, so clearing it is always allowed —
  // otherwise a renamed crop would strand the slot forever.
  if (crop && !isRotten(plant, action.nowSec, crop)) {
    return { ok: false, action: 'clear', reason: 'plant_not_rotten' };
  }

  return { ok: true, action: 'clear', slot: emptySlot(slot.coord, action.nowSec) };
}
