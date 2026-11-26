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
import { PROFILE_RELAY_URLS } from '@/nostr/relays';
import { APP_CONFIG_STORAGE_KEY } from '@/lib/theme-storage';
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
  theme: 'system',
  relayMetadata: {
    // The pool's default routing serves profile reads only; game, inventory and
    // registry flows name their relays explicitly (`src/nostr/relays.ts`).
    relays: PROFILE_RELAY_URLS.map((url) => ({ url, read: true, write: true })),
    updatedAt: 0,
  },
};

export function App() {
  return (
    <UnheadProvider head={head}>
      <AppProvider storageKey={APP_CONFIG_STORAGE_KEY} defaultConfig={defaultConfig}>
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
