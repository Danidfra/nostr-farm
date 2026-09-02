import { createRoot } from 'react-dom/client';

// Import polyfills first
import './lib/polyfills.ts';

import '@fontsource-variable/inter';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { applyStoredTheme } from '@/lib/theme';
import { APP_CONFIG_STORAGE_KEY } from '@/lib/theme-storage';
import App from './App.tsx';
import './index.css';

// Before the first render, so the page never paints light and then flips to
// dark. AppProvider takes over once it mounts.
applyStoredTheme(APP_CONFIG_STORAGE_KEY);

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
