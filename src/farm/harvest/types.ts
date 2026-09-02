import type { UnixSeconds } from '../time';

/**
 * Outcome of a successful harvest.
 *
 * V1 stops here: the result is a pure domain value. Turning it into inventory
 * (kind 31633) is a later milestone and happens strictly outside `src/farm`.
 */
export interface HarvestResult {
  cropId: string;
  /** Units of produce yielded. Always 1 in V1. */
  quantity: number;
  harvestedAt: UnixSeconds;
  /** Growth seconds the crop had banked when harvested. */
  growthSec: number;
}
