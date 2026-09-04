import { ArrowRight } from 'lucide-react';

import { CROP_CATALOG, getCrop } from '@/farm/crops/catalog';
import type { ProduceNotice } from '@/hooks/farm/useProduceChanges';
import type { LoadedRenderpack } from '@/world/renderpack/types';
import { CropSprite } from './CropSprite';
import { PRODUCE_CHANGE } from './copy';

interface ProduceChangeChipsProps {
  notices: readonly ProduceNotice[];
  renderpack?: LoadedRenderpack;
}

/**
 * "Pumpkin 4 → 2 · Used in another Nostr game", floating over the field for
 * a few seconds when a balance moved without the player doing anything here.
 * The other game is named only when its spend declared a client tag; the
 * Farm never keeps a list of consumers.
 */
export function ProduceChangeChips({ notices, renderpack }: ProduceChangeChipsProps) {
  if (notices.length === 0) return null;

  return (
    <div className="pointer-events-none absolute right-3 top-3 z-30 flex flex-col items-end gap-2 sm:right-5 sm:top-5" aria-live="polite">
      {notices.map((notice) => {
        const crop = getCrop(notice.definition.cropId, CROP_CATALOG);
        const sprite = renderpack?.sprites[notice.definition.cropId];
        return (
          <div
            key={notice.id}
            className="farm-paper flex items-center gap-3 px-3 py-2 animate-in fade-in slide-in-from-top-2"
            role="status"
          >
            {sprite && crop ? (
              <CropSprite sprite={sprite} frame={crop.harvestStage} size={32} className="shrink-0" />
            ) : (
              <span className="text-2xl leading-none" aria-hidden>
                {notice.definition.emoji}
              </span>
            )}
            <div className="leading-tight">
              <p className="flex items-center gap-1.5 font-display text-base font-semibold tabular-nums">
                <span>{notice.definition.name}</span>
                <span>{notice.from}</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <span>{notice.to}</span>
              </p>
              <p className="text-xs text-muted-foreground">{caption(notice)}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function caption(notice: ProduceNotice): string {
  if (notice.cause === 'external-spend') {
    return notice.client ? PRODUCE_CHANGE.usedIn(notice.client) : PRODUCE_CHANGE.usedElsewhere;
  }
  if (notice.cause === 'harvest') return PRODUCE_CHANGE.harvested;
  return notice.to < notice.from ? PRODUCE_CHANGE.updatedElsewhere : PRODUCE_CHANGE.updated;
}
