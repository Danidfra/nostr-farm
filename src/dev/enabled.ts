/**
 * Developer tooling gate.
 *
 * `__DEV_TOOLS_ENABLED__` is replaced by Vite with a literal `true`/`false` at
 * build time (see `vite.config.ts`). Because it is a literal, the bundler drops
 * the whole `/dev` route table and its lazy chunks from a production build —
 * the tools are absent, not merely unreachable.
 *
 * A production build can opt in with `VITE_ENABLE_DEV_TOOLS=true`, which is how
 * a staging deploy gets them.
 */
declare const __DEV_TOOLS_ENABLED__: boolean;

export const DEV_TOOLS_ENABLED: boolean =
  typeof __DEV_TOOLS_ENABLED__ === 'boolean' ? __DEV_TOOLS_ENABLED__ : false;

export const DEV_ROUTE = '/dev';
export const DEV_WORLDS_ROUTE = '/dev/worlds';
