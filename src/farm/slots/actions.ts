import type { UnixSeconds } from '../time';
import type { CropCatalog } from '../crops/types';
import type { HarvestResult } from '../harvest/types';
import type { FarmSlot } from './types';

/** The four things a player can do to a slot in V1. */
export type FarmActionType = 'plant' | 'water' | 'harvest' | 'clear';

export interface FarmAction {
  type: FarmActionType;
  /** When the action is considered to happen. */
  nowSec: UnixSeconds;
  /** Required for `plant`, ignored otherwise. */
  cropId?: string;
}

/** Every way an action can be refused. Stable strings — safe to switch on in UI. */
export type FarmActionFailure =
  | 'unknown_action'
  | 'unknown_crop'
  | 'slot_occupied'
  | 'slot_empty'
  | 'plant_rotten'
  | 'plant_not_rotten'
  | 'not_ready'
  | 'already_saturated';

export interface FarmActionSuccess {
  ok: true;
  action: FarmActionType;
  slot: FarmSlot;
  /** Present only for a successful `harvest`. */
  harvest?: HarvestResult;
}

export interface FarmActionRejected {
  ok: false;
  action: FarmActionType;
  reason: FarmActionFailure;
}

export type FarmActionResult = FarmActionSuccess | FarmActionRejected;

export interface FarmActionContext {
  catalog: CropCatalog;
}
