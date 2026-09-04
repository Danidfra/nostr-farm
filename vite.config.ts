import path from 'node:path';

import react from '@vitejs/plugin-react-swc';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

import { resolveDeployTarget, resolveDevToolsEnabled } from './scripts/deploy-target.mjs';

// https://vitejs.dev/config/
/**
 * Where the production build is served from is a deployment target, chosen
 * with `DEPLOY_TARGET` at build time (see `scripts/deploy-target.mjs`):
 *
 *   official      → `/`             https://farm.blobbi.pet (Vercel), the default
 *   github-pages  → `/nostr-farm/`  the GitHub Pages project site
 *
 * Every emitted asset URL, the manifest and favicon links and the router's
 * basename derive from this one value (`import.meta.env.BASE_URL`). The dev
 * server always stays at `/`.
 */
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  const deployTarget = resolveDeployTarget(env);

  // Resolved at build time and inlined as a literal, so a production build with
  // dev tools disabled drops the /dev routes *and* their chunks entirely rather
  // than shipping unreachable code.
  const devToolsEnabled = resolveDevToolsEnabled(env, mode);

  return {
    base: command === 'build' ? deployTarget.base : '/',
    server: {
      host: '::',
      port: 8080,
    },
    define: {
      __DEV_TOOLS_ENABLED__: JSON.stringify(devToolsEnabled),
    },
    plugins: [react()],
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      onConsoleLog(log) {
        return !log.includes('React Router Future Flag Warning');
      },
      env: {
        DEBUG_PRINT_LIMIT: '0', // Suppress DOM output that exceeds AI context windows
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
});
