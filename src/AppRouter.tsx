import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import { DEV_INVENTORY_ROUTE, DEV_ROUTE, DEV_TOOLS_ENABLED, DEV_WORLDS_ROUTE } from '@/dev/enabled';
import { ITEM_REGISTRY_ROUTE } from '@/inventory/routes';
import FarmPage from './pages/FarmPage';
import NotFound from './pages/NotFound';

// The registry is a real feature route, not a dev tool: browsing item
// definitions is useful to anyone, and publishing is already gated behind
// having a signer plus an explicit review step. It is lazily loaded so the
// gameplay bundle does not carry the authoring UI.
const ItemRegistryPage = lazy(() => import('./pages/ItemRegistryPage'));

// Both the routes and the dynamic imports sit behind a build-time literal, so a
// production build with dev tools disabled emits no dev chunks at all.
const devRoutes = DEV_TOOLS_ENABLED
  ? [
      { path: DEV_ROUTE, Component: lazy(() => import('@/dev/test-lab/TestLabPage')) },
      { path: DEV_WORLDS_ROUTE, Component: lazy(() => import('@/dev/world-editor/WorldEditorPage')) },
      { path: DEV_INVENTORY_ROUTE, Component: lazy(() => import('@/dev/inventory/InventoryPanelPage')) },
    ]
  : [];

export function AppRouter() {
  return (
    // Routes are written from `/`; the basename places them under the Pages
    // project path in production and at the root in development.
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<FarmPage />} />
        <Route
          path={ITEM_REGISTRY_ROUTE}
          element={
            <Suspense fallback={null}>
              <ItemRegistryPage />
            </Suspense>
          }
        />

        {devRoutes.map(({ path, Component }) => (
          <Route
            key={path}
            path={path}
            element={
              <Suspense fallback={null}>
                <Component />
              </Suspense>
            }
          />
        ))}

        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

export default AppRouter;
