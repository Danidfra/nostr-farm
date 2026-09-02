// This file wires providers only. Routes live in AppRouter.tsx.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createHead, UnheadProvider } from '@unhead/react/client';
import { InferSeoMetaPlugin } from '@unhead/addons';
import { Suspense } from 'react';
import { NostrLoginProvider } from '@nostrify/react/login';

import NostrProvider from '@/components/NostrProvider';
import { AppProvider } from '@/components/AppProvider';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppConfig } from '@/contexts/AppContext';
import { GAME_RELAYS } from '@/nostr/relays';
import AppRouter from './AppRouter';

const head = createHead({ plugins: [InferSeoMetaPlugin()] });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      gcTime: Infinity,
    },
  },
});

const defaultConfig: AppConfig = {
  theme: 'light',
  relayMetadata: {
    relays: GAME_RELAYS.map((relay) => ({ url: relay.url, read: true, write: true })),
    updatedAt: 0,
  },
};

export function App() {
  return (
    <UnheadProvider head={head}>
      <AppProvider storageKey="nostr-worlds:app-config" defaultConfig={defaultConfig}>
        <QueryClientProvider client={queryClient}>
          <NostrLoginProvider storageKey="nostr-worlds:login">
            <NostrProvider>
              <TooltipProvider>
                <Toaster />
                <Suspense>
                  <AppRouter />
                </Suspense>
              </TooltipProvider>
            </NostrProvider>
          </NostrLoginProvider>
        </QueryClientProvider>
      </AppProvider>
    </UnheadProvider>
  );
}

export default App;
