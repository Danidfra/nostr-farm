import { useCallback, useState } from 'react';
import { useSeoMeta } from '@unhead/react';

import type { FarmSlot } from '@/farm/slots/types';
import type { FarmActionType } from '@/farm/slots/actions';
import { RenderpackLoadError } from '@/world/renderpack/types';
import { CreateFarmPanel, FarmErrorPanel, LoadingFieldPanel, WelcomePanel } from '@/components/farm/FarmGate';
import { ERRORS } from '@/components/farm/copy';
import { FarmField } from '@/components/farm/FarmField';
import { FarmTopBar } from '@/components/farm/FarmTopBar';
import { SeedPicker } from '@/components/farm/SeedPicker';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNowSeconds } from '@/hooks/useClock';
import { useCreateFarm } from '@/hooks/farm/useCreateFarm';
import { useFarm } from '@/hooks/farm/useFarm';
import { useFarmActions } from '@/hooks/farm/useFarmActions';
import { readSlot, readSlotRecord, useFarmSlots } from '@/hooks/farm/useFarmSlots';
import { useFarmInventory } from '@/hooks/farm/useFarmInventory';
import { useRenderpack } from '@/hooks/farm/useRenderpack';

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

  const farm = useFarm(user?.pubkey);
  const { createFarm, isCreating } = useCreateFarm();
  const slots = useFarmSlots(user?.pubkey, farm.data?.map.id);
  const renderpack = useRenderpack(farm.data?.world.renderpack);
  const { act, isActing } = useFarmActions();
  const inventory = useFarmInventory(user?.pubkey);

  const [seedTarget, setSeedTarget] = useState<FarmSlot | null>(null);

  const mapId = farm.data?.map.id;

  const read = useCallback(
    (x: number, y: number): FarmSlot => readSlot(slots.data, mapId ?? '', x, y),
    [slots.data, mapId]
  );

  const runAction = useCallback(
    (slot: FarmSlot, type: FarmActionType, cropId?: string) => {
      if (!mapId) return;
      // The record carries the source event id, which harvest needs as its
      // idempotency key.
      const record = readSlotRecord(slots.data, mapId, slot.coord.x, slot.coord.y);
      void act({ mapId, record, type, cropId });
    },
    [act, mapId, slots.data]
  );

  return (
    <div className="farm-meadow flex h-screen w-screen flex-col overflow-hidden">
      <FarmTopBar
        farmName={farm.data?.world.name}
        renderpack={farm.data?.world.renderpack}
        produce={inventory.data?.produce}
        produceStatus={inventory.data?.status}
      />

      <main className="relative flex-1 overflow-hidden">
        {!user && <WelcomePanel />}

        {user && farm.isLoading && <LoadingFieldPanel />}

        {user && farm.isError && (
          <FarmErrorPanel
            title={ERRORS.farmTitle}
            message={ERRORS.farmMessage}
            detail={farm.error instanceof Error ? farm.error.message : 'Unknown error.'}
            onRetry={() => farm.refetch()}
          />
        )}

        {user && !farm.isLoading && !farm.isError && !farm.data && (
          <CreateFarmPanel onCreate={(name) => void createFarm({ name })} isCreating={isCreating} />
        )}

        {user && farm.data && renderpack.isLoading && <LoadingFieldPanel />}

        {user && farm.data && renderpack.isError && (
          <FarmErrorPanel
            title={ERRORS.artworkTitle}
            message={ERRORS.artworkMessage}
            detail={describeRenderpackError(renderpack.error)}
            onRetry={() => renderpack.refetch()}
          />
        )}

        {user && farm.data && renderpack.data && (
          <FarmField
            definition={farm.data.definition}
            renderpack={renderpack.data}
            readSlot={read}
            nowSec={nowSec}
            busy={isActing}
            onSlotAction={(slot, action) => runAction(slot, action)}
            onPlantRequest={setSeedTarget}
          />
        )}

        {user && farm.data && renderpack.data && seedTarget && (
          <SeedPicker
            isOpen
            renderpack={renderpack.data}
            onClose={() => setSeedTarget(null)}
            onSelect={(cropId) => runAction(seedTarget, 'plant', cropId)}
          />
        )}
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
