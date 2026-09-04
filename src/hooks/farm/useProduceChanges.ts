import { useEffect, useRef, useState } from 'react';

import { diffProduceViews, type ProduceChange } from '@/inventory/produce-changes';
import type { FarmInventoryView } from './useFarmInventory';

export interface ProduceNotice extends ProduceChange {
  id: string;
}

const DEFAULT_TTL_MS = 7000;
const MAX_NOTICES = 3;

/**
 * Ephemeral notices for produce counts that changed under the player.
 *
 * Compares each committed view with the one before it through
 * `diffProduceViews` and keeps the results for a few seconds. Own harvests
 * are left out: the field burst and the toast already announce those at the
 * point of interaction, and a third signal would be noise. Nothing here is
 * stored, queued beyond three entries, or read back by anyone.
 */
export function useProduceChanges(view: FarmInventoryView | undefined, ttlMs = DEFAULT_TTL_MS): ProduceNotice[] {
  const previous = useRef<FarmInventoryView | undefined>(undefined);
  const [notices, setNotices] = useState<ProduceNotice[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const before = previous.current;
    previous.current = view;
    if (!view) return;

    const changes = diffProduceViews(before, view).filter((change) => change.cause !== 'harvest');
    if (changes.length === 0) return;

    const stamp = Date.now();
    const added = changes.map((change, index) => ({ ...change, id: `${stamp}-${index}-${change.definition.itemId}` }));
    setNotices((current) => [...current, ...added].slice(-MAX_NOTICES));

    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setNotices((current) => current.filter((notice) => !added.some((entry) => entry.id === notice.id)));
    }, ttlMs);
    timers.current.add(timer);
  }, [view, ttlMs]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  return notices;
}
