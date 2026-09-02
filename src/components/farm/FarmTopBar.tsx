import { LogOut, Package } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useLoginActions } from '@/hooks/useLoginActions';
import { genUserName } from '@/lib/genUserName';
import { formatRenderpackRef, type RenderpackRef } from '@/world/renderpack/registry';
import { ITEM_REGISTRY_ROUTE } from '@/inventory/routes';

interface FarmTopBarProps {
  farmName?: string;
  renderpack?: RenderpackRef;
}

export function FarmTopBar({ farmName, renderpack }: FarmTopBarProps) {
  const { user, metadata } = useCurrentUser();
  const { logout } = useLoginActions();

  const displayName = user ? (metadata?.name ?? genUserName(user.pubkey)) : '';

  return (
    <header className="flex h-14 items-center justify-between border-b border-white/20 bg-white/30 px-4 backdrop-blur-sm dark:border-black/20 dark:bg-black/20">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl">🌾</span>
        <h1 className="text-lg font-bold">{farmName ?? 'Nostr Farm'}</h1>
        {renderpack && (
          <span className="hidden text-xs text-muted-foreground sm:inline" title="Pinned renderpack version">
            {formatRenderpackRef(renderpack)}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link to={ITEM_REGISTRY_ROUTE}>
            <Package className="mr-2 h-4 w-4" />
            Items
          </Link>
        </Button>

        {user && (
          <>
            <span className="hidden text-sm font-medium sm:inline">{displayName}</span>
            <Button variant="ghost" size="icon" onClick={() => logout()} aria-label="Log out">
              <LogOut className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
