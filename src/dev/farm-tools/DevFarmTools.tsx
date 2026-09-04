import { useMemo, useState } from 'react';

import { CROP_CATALOG, getCrop } from '@/farm/crops/catalog';
import { evaluatePlant } from '@/farm/growth/evaluate';
import type { UnixSeconds } from '@/farm/time';
import type { FarmSlotRecord, FarmSlots } from '@/hooks/farm/useFarmSlots';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useDevFarmToolsAccess } from './access';
import { useAccelerateCrop } from './useAccelerateCrop';

export interface DevFarmToolsProps {
  mapId: string;
  slots: FarmSlots | undefined;
  nowSec: UnixSeconds;
}

/**
 * The developer panel on the live field. Utilitarian on purpose.
 *
 * One action: make the selected planted crop harvestable now. The harvest
 * itself is then the ordinary click on the field. Renders nothing at all
 * unless this build opted in AND the signed-in key is the authorized one.
 */
export default function DevFarmTools({ mapId, slots, nowSec }: DevFarmToolsProps) {
  const allowed = useDevFarmToolsAccess();
  const accelerate = useAccelerateCrop();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [lastEventId, setLastEventId] = useState<string | null>(null);

  const planted = useMemo(() => {
    const entries: { key: string; record: FarmSlotRecord }[] = [];
    for (const [key, record] of slots?.byAddress ?? []) {
      if (record.slot.content.type === 'plant') entries.push({ key, record });
    }
    return entries.sort((a, b) => a.record.slot.coord.y - b.record.slot.coord.y || a.record.slot.coord.x - b.record.slot.coord.x);
  }, [slots]);

  if (!allowed) return null;

  const selected = planted.find((entry) => entry.key === selectedKey) ?? planted[0];
  const plant = selected?.record.slot.content.type === 'plant' ? selected.record.slot.content.plant : null;
  const crop = plant ? getCrop(plant.cropId, CROP_CATALOG) : undefined;
  const view = plant && crop ? evaluatePlant(plant, nowSec, crop) : null;
  const canAccelerate = !!selected && !!view && view.phase === 'growing' && !accelerate.isPending;

  return (
    <aside
      className="fixed bottom-3 left-3 z-40 w-72 rounded-lg border-2 border-dashed border-amber-500 bg-background/95 p-3 text-xs text-foreground shadow-panel"
      aria-label="Developer tools"
      data-testid="dev-farm-tools"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-amber-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-950">
          Dev / test tool
        </span>
        <span className="font-semibold">Developer tools</span>
      </div>
      <p className="mb-2 rounded border border-red-500/60 bg-red-500/5 px-2 py-1 font-medium">
        Actions here publish real Nostr events with your signer.
      </p>

      {planted.length === 0 ? (
        <p className="text-muted-foreground">Nothing is planted. Plant a crop on the field first.</p>
      ) : (
        <>
          <label className="mb-1 block text-muted-foreground" htmlFor="dev-farm-tools-slot">
            Selected slot
          </label>
          <select
            id="dev-farm-tools-slot"
            className="mb-2 w-full rounded border bg-background px-2 py-1"
            value={selected?.key ?? ''}
            onChange={(event) => setSelectedKey(event.target.value)}
          >
            {planted.map(({ key, record }) => {
              const content = record.slot.content;
              const label = content.type === 'plant' ? content.plant.cropId : 'empty';
              return (
                <option key={key} value={key}>
                  ({record.slot.coord.x}, {record.slot.coord.y}) {label}
                </option>
              );
            })}
          </select>

          {plant && view && (
            <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <dt className="text-muted-foreground">Crop</dt>
              <dd className="font-semibold capitalize">{plant.cropId}</dd>
              <dt className="text-muted-foreground">Stage</dt>
              <dd>
                {view.stage} / {view.harvestStage}
              </dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd className={cn(view.phase === 'ready' && 'text-farm-harvest', view.phase === 'rotten' && 'text-destructive')}>
                {view.phase}
                {view.phase === 'growing' && (view.wet ? ', wet' : ', dry')}
              </dd>
            </dl>
          )}

          <Button
            size="sm"
            className="w-full"
            disabled={!canAccelerate}
            onClick={() => {
              if (!selected) return;
              setLastEventId(null);
              accelerate.mutate(
                { mapId, record: selected.record },
                { onSuccess: (result) => setLastEventId(result.eventId) }
              );
            }}
          >
            {accelerate.isPending ? 'Publishing…' : 'Make harvestable'}
          </Button>

          {view?.phase === 'ready' && (
            <p className="mt-2 text-muted-foreground">
              Ready. Now click the crop on the field and use the normal <strong>Harvest</strong>.
            </p>
          )}
          {view?.phase === 'rotten' && <p className="mt-2 text-muted-foreground">Rotten. Clear it on the field first.</p>}
          {accelerate.isError && <p className="mt-2 text-destructive">{accelerate.error.message}</p>}
          {lastEventId && (
            <p className="mt-2 break-all text-muted-foreground" data-testid="dev-farm-tools-published">
              Published kind 31417 {lastEventId.slice(0, 12)}…
            </p>
          )}
        </>
      )}
    </aside>
  );
}
