import { Sprout } from 'lucide-react';

import { HudPill, HudRail } from '@/components/game/HudRail';
import { ProduceItem } from '@/components/game/ProduceItem';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import type { ProduceDefinition } from '@/inventory/produce-catalog';
import type { RenderpackRef } from '@/world/renderpack/registry';
import type { LoadedRenderpack } from '@/world/renderpack/types';
import { cn } from '@/lib/utils';
import { APP_NAME, HUD } from './copy';
import { PlayerMenu, type AboutFarm } from './PlayerMenu';

export interface FarmHudProps {
  farmName?: string;
  /** The loaded renderpack, for drawing produce with its harvest sprite. */
  renderpack?: LoadedRenderpack;
  /** What the About dialog shows. Technical detail lives there, not on the rail. */
  about?: AboutFarm;
  /** Official Farm produce currently held, from the effective inventory view. */
  produce?: { definition: ProduceDefinition; quantity: number }[];
  /**
   * `unresolved` means the inventory's settlement chain could not be
   * verified, so there is no balance to show, not even the raw snapshot.
   */
  produceStatus?: 'ready' | 'unresolved';
  /** True while the first authoritative read is still on its way. */
  produceLoading?: boolean;
  /** The pinned artwork reference, shown in About only. */
  renderpackRef?: RenderpackRef;
}

/**
 * The game's heads-up display: who and where on the left, the produce tray
 * in the middle, the player on the right. Wraps to two rows at phone widths
 * with the tray taking the second row.
 *
 * Nothing about relays, kinds or artwork versions appears here; that is what
 * the About dialog in the player menu is for.
 */
export function FarmHud({ farmName, renderpack, about, produce, produceStatus, produceLoading }: FarmHudProps) {
  const { user } = useCurrentUser();

  return (
    <HudRail>
      <Brand farmName={farmName} />

      {user && (
        <ProduceTray
          renderpack={renderpack}
          produce={produce}
          status={produceStatus}
          loading={produceLoading}
          hasFarm={!!farmName}
        />
      )}

      <div className="ml-auto flex items-center gap-2">{user ? <PlayerMenu about={about} /> : <ThemeToggle />}</div>
    </HudRail>
  );
}

function Brand({ farmName }: { farmName?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-pill"
        aria-hidden
      >
        <Sprout className="h-5 w-5" />
      </span>
      <div className="min-w-0 leading-tight">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{APP_NAME}</p>
        <h1 className="truncate font-display text-lg font-semibold tracking-tight">{farmName ?? HUD.tagline}</h1>
      </div>
    </div>
  );
}

interface ProduceTrayProps {
  renderpack?: LoadedRenderpack;
  produce?: { definition: ProduceDefinition; quantity: number }[];
  status?: 'ready' | 'unresolved';
  loading?: boolean;
  hasFarm: boolean;
}

/**
 * What the player holds, drawn from the effective inventory. Only non-zero
 * items are listed, which is exactly what the read model returns; the tray
 * never re-derives a balance.
 */
function ProduceTray({ renderpack, produce, status, loading, hasFarm }: ProduceTrayProps) {
  if (!hasFarm) return null;

  const layout = 'order-last w-full justify-center sm:order-none sm:ml-auto sm:w-auto';

  if (status === 'unresolved') {
    return (
      <div className={cn('flex', layout)} data-testid="produce-tray">
        <HudPill tone="warn" title={HUD.unresolvedHint}>
          {HUD.unresolved}
        </HudPill>
      </div>
    );
  }

  if (!produce && loading) {
    return (
      <div className={cn('flex', layout)} data-testid="produce-tray">
        <HudPill tone="quiet">{HUD.loading}</HudPill>
      </div>
    );
  }

  if (!produce || produce.length === 0) {
    return (
      <div className={cn('flex', layout)} data-testid="produce-tray">
        <HudPill tone="quiet" title={HUD.emptyHint}>
          {HUD.empty}
        </HudPill>
      </div>
    );
  }

  return (
    <div className={cn('flex', layout)} data-testid="produce-tray">
      <ul
        className="flex items-center gap-3 rounded-full border border-border bg-card px-3 py-1 shadow-pill sm:gap-4"
        aria-label={HUD.trayLabel}
      >
        {produce.map(({ definition, quantity }) => (
          <li key={definition.itemId} className="flex">
            <ProduceItem definition={definition} quantity={quantity} sprite={renderpack?.sprites[definition.cropId]} />
          </li>
        ))}
      </ul>
    </div>
  );
}
