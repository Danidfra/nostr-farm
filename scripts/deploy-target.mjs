// Deployment targets and the base path each one is built for.
//
// The base path is a build concern, never application logic. Vite inlines the
// chosen base into every emitted asset URL, the manifest/favicon links and
// `import.meta.env.BASE_URL` (which the router uses as its basename), so this
// module is the only place a deployment path is spelled out.
//
// Select a target with the `DEPLOY_TARGET` environment variable at build time.
// The default is the official deployment so that a plain `npm run build`, which
// is what Vercel runs, produces the canonical site.

/** The canonical public Farm. */
export const OFFICIAL_ORIGIN = 'https://farm.blobbi.pet';

export const DEPLOY_TARGET_ENV = 'DEPLOY_TARGET';

/** Target name → base path (always with leading and trailing slash). */
export const DEPLOY_TARGETS = Object.freeze({
  /** https://farm.blobbi.pet, served by Vercel from the domain root. */
  official: '/',
  /** The GitHub Pages project site, served under `/nostr-farm/`. */
  'github-pages': '/nostr-farm/',
});

export const DEFAULT_DEPLOY_TARGET = 'official';

/**
 * Resolve the deployment target from an environment map.
 *
 * @param {Record<string, string | undefined>} env usually `process.env`
 * @returns {{ name: string, base: string }}
 */
export function resolveDeployTarget(env = process.env) {
  const raw = env[DEPLOY_TARGET_ENV];
  const name = raw === undefined || raw === '' ? DEFAULT_DEPLOY_TARGET : raw;
  if (!Object.hasOwn(DEPLOY_TARGETS, name)) {
    const known = Object.keys(DEPLOY_TARGETS).join(', ');
    throw new Error(`[deploy-target] unknown ${DEPLOY_TARGET_ENV} "${raw}"; expected one of: ${known}`);
  }
  return { name, base: DEPLOY_TARGETS[name] };
}

/**
 * Root-relative `src`/`href` references in built HTML that do not belong to
 * `base`: either outside it, or inside the base of a *different* target (a
 * `/nostr-farm/...` reference in an official build starts with `/` too, so a
 * plain prefix check would let it through).
 *
 * External (`https://...`) and relative references are not the build base's
 * business and are ignored.
 *
 * @param {string} html
 * @param {string} base
 * @returns {string[]} the offending references, in document order
 */
export function findAssetRefsOutsideBase(html, base) {
  const foreignBases = Object.values(DEPLOY_TARGETS).filter((b) => b !== base && b !== '/');
  const offending = [];
  for (const [, ref] of html.matchAll(/\b(?:src|href)="([^"]*)"/g)) {
    if (!ref.startsWith('/') || ref.startsWith('//')) continue;
    if (!ref.startsWith(base) || foreignBases.some((b) => ref.startsWith(b))) {
      offending.push(ref);
    }
  }
  return offending;
}
