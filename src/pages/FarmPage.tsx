import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSeoMeta } from '@unhead/react';

import type { FarmSlot } from '@/farm/slots/types';
import type { FarmActionType } from '@/farm/slots/actions';
import { RenderpackLoadError } from '@/world/renderpack/types';
import { CreateFarmPanel, FarmErrorPanel, LoadingFieldPanel, RestoreFieldPanel, WelcomePanel } from '@/components/farm/FarmGate';
import { CLEAR_ROTTEN, ERRORS } from '@/components/farm/copy';
import { FarmField, type FieldBurst } from '@/components/farm/FarmField';
import { GameDialog } from '@/components/game/GameDialog';
import { Button } from '@/components/ui/button';
import { FarmHud } from '@/components/farm/FarmHud';
import { SeedPicker } from '@/components/farm/SeedPicker';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNowSeconds } from '@/hooks/useClock';
import { useCreateFarm } from '@/hooks/farm/useCreateFarm';
import { foundFarm, useFarm } from '@/hooks/farm/useFarm';
import { useFarmActions } from '@/hooks/farm/useFarmActions';
import { readSlot, readSlotRecord, useFarmSlots } from '@/hooks/farm/useFarmSlots';
import { useFarmInventory } from '@/hooks/farm/useFarmInventory';
import { useProduceChanges } from '@/hooks/farm/useProduceChanges';
import { ProduceChangeChips } from '@/components/farm/ProduceChangeChips';
import { useRenderpack } from '@/hooks/farm/useRenderpack';
import { DEV_TOOLS_ENABLED } from '@/dev/enabled';
import { useDevFarmToolsAccess } from '@/dev/farm-tools/access';

// Behind the same build-time literal as the /dev routes, so a production build
// without dev tools emits no chunk for the field tools at all.
const DevFarmTools = DEV_TOOLS_ENABLED ? lazy(() => import('@/dev/farm-tools/DevFarmTools')) : null;

/**
 * The V1 vertical slice: enter farm -> see the field -> plant -> water ->
 * watch it grow -> harvest. Deliberately nothing else.
 */
export default function FarmPage() {
  useSeoMeta({
    title: 'Nostr Farm',
    description: 'A Nostr-native farming game. Plant, water and harvest crops on a farm you own.',
  });

  const { user } = useCurrentUser();
  const nowSec = useNowSeconds();

  const lookup = useFarm(user?.pubkey);
  const farm = foundFarm(lookup.data);
  const missingFieldWorld = lookup.data?.status === 'field-missing' ? lookup.data.world : undefined;
  const { createFarm, isCreating } = useCreateFarm();
  const slots = useFarmSlots(user?.pubkey, farm?.map.id);
  const renderpack = useRenderpack(farm?.world.renderpack);
  const { act, isActing } = useFarmActions();
  const inventory = useFarmInventory(user?.pubkey);
  const produceChanges = useProduceChanges(inventory.data);
  const devToolsAllowed = useDevFarmToolsAccess();

  const [seedTarget, setSeedTarget] = useState<FarmSlot | null>(null);
  const [clearTarget, setClearTarget] = useState<FarmSlot | null>(null);

  // Harvest feedback on the field. A burst is added only after the mutation
  // resolved with produce, i.e. after the inventory credit was accepted.
  const [bursts, setBursts] = useState<FieldBurst[]>([]);
  const burstTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = burstTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  const mapId = farm?.map.id;

  const read = useCallback(
    (x: number, y: number): FarmSlot => readSlot(slots.data, mapId ?? '', x, y),
    [slots.data, mapId]
  );

  const runAction = useCallback(
    async (slot: FarmSlot, type: FarmActionType, cropId?: string) => {
      if (!mapId) return;
      // The record carries the source event id, which harvest needs as its
      // idempotency key.
      const record = readSlotRecord(slots.data, mapId, slot.coord.x, slot.coord.y);
      const result = await act({ mapId, record, type, cropId }).catch(() => undefined);

      if (result?.produce) {
        const burst: FieldBurst = {
          id: `${Date.now()}-${slot.coord.x}-${slot.coord.y}`,
          coord: slot.coord,
          label: `+1 ${result.produce.emoji} ${result.produce.name}`,
        };
        setBursts((current) => [...current, burst]);
        const timer = setTimeout(() => {
          burstTimers.current.delete(timer);
          setBursts((current) => current.filter((entry) => entry.id !== burst.id));
        }, 1400);
        burstTimers.current.add(timer);
      }
    },
    [act, mapId, slots.data]
  );

  // Clearing a rotten crop is the one irreversible click on the field, so it
  // asks first. The clear itself is the same action as before.
  const requestAction = useCallback(
    (slot: FarmSlot, type: FarmActionType) => {
      if (type === 'clear') setClearTarget(slot);
      else void runAction(slot, type);
    },
    [runAction]
  );

  return (
    <div className="farm-meadow flex h-screen w-screen flex-col overflow-hidden">
      <FarmHud
        farmName={farm?.world.name}
        renderpack={renderpack.data}
        about={
          farm
            ? {
                farmName: farm.world.name,
                mapName: farm.definition.name,
                mapDefinitionId: farm.definition.id,
                mapRevision: farm.definition.revision,
                renderpack: farm.world.renderpack,
              }
            : undefined
        }
        produce={inventory.data?.produce}
        produceStatus={inventory.data?.status}
        produceLoading={inventory.isPending}
      />

      <main className="relative flex-1 overflow-hidden p-3 sm:p-4">
        {!user && <WelcomePanel />}

        {user && lookup.isLoading && <LoadingFieldPanel />}

        {user && lookup.isError && (
          <FarmErrorPanel
            title={ERRORS.farmTitle}
            message={ERRORS.farmMessage}
            detail={lookup.error instanceof Error ? lookup.error.message : 'Unknown error.'}
            onRetry={() => lookup.refetch()}
          />
        )}

        {/* Not confirmed either way: a retry, never a Create button. */}
        {user && lookup.data?.status === 'unknown' && (
          <FarmErrorPanel
            title={ERRORS.farmUnknownTitle}
            message={ERRORS.farmUnknownMessage}
            detail={lookup.data.detail}
            onRetry={() => lookup.refetch()}
          />
        )}

        {user && lookup.data?.status === 'absent' && (
          <CreateFarmPanel onCreate={(name) => void createFarm({ name }).catch(() => undefined)} isCreating={isCreating} />
        )}

        {/* The world exists; only its field is republished. The name is not used. */}
        {user && missingFieldWorld && (
          <RestoreFieldPanel
            farmName={missingFieldWorld.name}
            onRestore={() => void createFarm({ name: missingFieldWorld.name }).catch(() => undefined)}
            isRestoring={isCreating}
          />
        )}

        {user && farm && renderpack.isLoading && <LoadingFieldPanel />}

        {user && farm && renderpack.isError && (
          <FarmErrorPanel
            title={ERRORS.artworkTitle}
            message={ERRORS.artworkMessage}
            detail={describeRenderpackError(renderpack.error)}
            onRetry={() => renderpack.refetch()}
          />
        )}

        {user && farm && renderpack.data && (
          <FarmField
            definition={farm.definition}
            renderpack={renderpack.data}
            readSlot={read}
            nowSec={nowSec}
            busy={isActing}
            onSlotAction={requestAction}
            onPlantRequest={setSeedTarget}
            bursts={bursts}
          />
        )}

        {user && farm && <ProduceChangeChips notices={produceChanges} renderpack={renderpack.data} />}

        {DevFarmTools && devToolsAllowed && mapId && (
          <Suspense fallback={null}>
            <DevFarmTools mapId={mapId} slots={slots.data} nowSec={nowSec} />
          </Suspense>
        )}

        {user && farm && renderpack.data && seedTarget && (
          <SeedPicker
            isOpen
            renderpack={renderpack.data}
            onClose={() => setSeedTarget(null)}
            onSelect={(cropId) => void runAction(seedTarget, 'plant', cropId)}
          />
        )}

        <GameDialog
          open={clearTarget !== null}
          onOpenChange={(open) => !open && setClearTarget(null)}
          title={CLEAR_ROTTEN.title}
          description={CLEAR_ROTTEN.description}
          footer={
            <>
              <Button variant="outline" onClick={() => setClearTarget(null)}>
                {CLEAR_ROTTEN.cancel}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const target = clearTarget;
                  setClearTarget(null);
                  if (target) void runAction(target, 'clear');
                }}
              >
                {CLEAR_ROTTEN.confirm}
              </Button>
            </>
          }
        />
      </main>
    </div>
  );
}

function describeRenderpackError(error: unknown): string {
  if (error instanceof RenderpackLoadError) {
    return `${error.message} (pinned renderpack ${error.detail.ref}${error.detail.url ? `, ${error.detail.url}` : ''})`;
  }
  return error instanceof Error ? error.message : 'Unknown error.';
}
