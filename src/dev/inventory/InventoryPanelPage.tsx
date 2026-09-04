import { useEffect, useState } from 'react';
import { onlineManager } from '@tanstack/react-query';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useFarmInventory } from '@/hooks/farm/useFarmInventory';
import { DevLayout, ReadOnlyBadge } from '../DevLayout';
import { InventoryPanel } from './InventoryPanel';

/**
 * `/dev/inventory`: the player's `farm:main` as the read model sees it.
 *
 * Mounts the very same `useFarmInventory` query the HUD uses, so the panel
 * shares its cache and its live tail with the game rather than opening a
 * second read path. There is nothing here that can publish.
 */
export default function InventoryPanelPage() {
  const { user } = useCurrentUser();
  const inventory = useFarmInventory(user?.pubkey);
  const online = useOnline();

  return (
    <DevLayout>
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <h2 className="text-sm font-semibold">farm:main accounting</h2>
        <ReadOnlyBadge />
        <span className="ml-auto text-xs text-muted-foreground">
          Same query and cache as the HUD; nothing is re-derived here.
        </span>
      </div>
      {user ? (
        <InventoryPanel
          ownerPubkey={user.pubkey}
          view={inventory.data}
          online={online}
          query={{
            isPending: inventory.isPending,
            isFetching: inventory.isFetching,
            dataUpdatedAt: inventory.dataUpdatedAt,
            error: inventory.error ? inventory.error.message : null,
          }}
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">Sign in on the farm to inspect an inventory.</p>
      )}
    </DevLayout>
  );
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => onlineManager.isOnline());
  useEffect(() => onlineManager.subscribe(setOnline), []);
  return online;
}
