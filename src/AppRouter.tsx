import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import { DEV_ROUTE, DEV_TOOLS_ENABLED, DEV_WORLDS_ROUTE } from '@/dev/enabled';
import FarmPage from './pages/FarmPage';
import NotFound from './pages/NotFound';

// Both the routes and the dynamic imports sit behind a build-time literal, so a
// production build with dev tools disabled emits no dev chunks at all.
const devRoutes = DEV_TOOLS_ENABLED
  ? [
      { path: DEV_ROUTE, Component: lazy(() => import('@/dev/test-lab/TestLabPage')) },
      { path: DEV_WORLDS_ROUTE, Component: lazy(() => import('@/dev/world-editor/WorldEditorPage')) },
    ]
  : [];

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<FarmPage />} />

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
