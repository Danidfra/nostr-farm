import { Link, useLocation } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { DEV_ROUTE, DEV_WORLDS_ROUTE } from './enabled';

/** Shared chrome for the developer tools, visibly distinct from the game. */
export function DevLayout({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();

  const tabs = [
    { to: DEV_ROUTE, label: 'Test lab' },
    { to: DEV_WORLDS_ROUTE, label: 'World editor' },
  ];

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-dashed border-amber-500 bg-amber-500/10 px-4">
        <span className="rounded bg-amber-500 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-amber-950">
          Dev tools
        </span>
        <nav className="flex gap-1">
          {tabs.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              className={cn(
                'rounded px-3 py-1 text-sm',
                pathname === tab.to ? 'bg-foreground text-background' : 'hover:bg-muted'
              )}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        <Link to="/" className="ml-auto text-sm text-muted-foreground hover:underline">
          Back to the game
        </Link>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}

/** Banner for any panel that could ever touch the network. */
export function LiveWarning({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border-2 border-red-500/60 bg-red-500/5 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-red-600 px-2 py-0.5 text-xs font-bold uppercase text-white">Live Nostr</span>
        <span className="text-sm font-medium">Anything in this panel can publish signed events.</span>
      </div>
      {children}
    </div>
  );
}

/** Banner for panels guaranteed to be offline. */
export function SimulationBadge() {
  return (
    <span className="rounded bg-emerald-600 px-2 py-0.5 text-xs font-bold uppercase text-white">
      Simulation only — no network
    </span>
  );
}
