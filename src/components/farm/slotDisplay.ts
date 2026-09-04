import { CROP_CATALOG, getCrop } from '@/farm/crops/catalog';
import { evaluatePlant } from '@/farm/growth/evaluate';
import type { FarmActionType } from '@/farm/slots/actions';
import type { FarmSlot } from '@/farm/slots/types';
import type { UnixSeconds } from '@/farm/time';

/** What clicking a slot does, given what is in it right now. */
export function primaryAction(slot: FarmSlot, nowSec: UnixSeconds): FarmActionType {
  if (slot.content.type !== 'plant') return 'plant';

  const crop = getCrop(slot.content.plant.cropId, CROP_CATALOG);
  if (!crop) return 'clear';

  const view = evaluatePlant(slot.content.plant, nowSec, crop);
  if (view.phase === 'rotten') return 'clear';
  if (view.phase === 'ready') return 'harvest';
  return 'water';
}

/** The words for each action, as the field's hover hint shows them. */
export const ACTION_LABELS: Record<FarmActionType, string> = {
  plant: 'Plant',
  water: 'Water',
  harvest: 'Harvest',
  clear: 'Clear rotten crop',
};

/**
 * The action a click would perform and the label to show for it. Presentation
 * over `primaryAction`; the rules stay in the domain.
 */
export function describeSlotAction(slot: FarmSlot, nowSec: UnixSeconds): { action: FarmActionType; label: string } {
  const action = primaryAction(slot, nowSec);
  return { action, label: ACTION_LABELS[action] };
}

/** `m:ss`, or `Hhmm` past an hour. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** A rough "grows in about …" for a seed card, from the crop's own balance. */
export function describeGrowTime(cropId: string): string | null {
  const crop = getCrop(cropId, CROP_CATALOG);
  if (!crop) return null;
  const minutes = Math.round((crop.harvestStage * crop.stageDurationSec) / 60);
  if (minutes < 1) return 'Grows in under a minute while watered';
  if (minutes < 60) return `Grows in about ${minutes} min while watered`;
  const hours = Math.round(minutes / 60);
  return `Grows in about ${hours} h while watered`;
}
