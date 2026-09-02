/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to "true" to expose the /dev routes in a production build. */
  readonly VITE_ENABLE_DEV_TOOLS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
