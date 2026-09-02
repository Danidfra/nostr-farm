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

/** `m:ss`, or `Hhmm` past an hour. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}
