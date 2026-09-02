import path from 'node:path';

import react from '@vitejs/plugin-react-swc';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // Resolved at build time and inlined as a literal, so a production build with
  // dev tools disabled drops the /dev routes *and* their chunks entirely rather
  // than shipping unreachable code.
  const devToolsEnabled = mode === 'development' || env.VITE_ENABLE_DEV_TOOLS === 'true';

  return {
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
