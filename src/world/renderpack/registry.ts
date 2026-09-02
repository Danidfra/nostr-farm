/**
 * Renderpack pinning.
 *
 * A renderpack supplies artwork and sprite geometry only. It never supplies
 * gameplay numbers — those live in `src/farm/crops/catalog.ts`.
 *
 * Renderpacks used to be fetched from `raw.githubusercontent.com/.../master`,
 * which meant a push to the art repository silently changed a running game and
 * could not be reproduced after the fact. Every release below is therefore
 * pinned to an immutable commit and served through a CDN that honours that
 * pin. Nothing outside this registry may name a renderpack URL.
 */

export interface RenderpackRef {
  id: string;
  version: string;
}

export interface RenderpackRelease extends RenderpackRef {
  /** Human-readable provenance of the artwork. */
  source: {
    repo: string;
    /** Full 40-character commit SHA. Immutability depends on this being exact. */
    commit: string;
    path: string;
  };
  /** Immutable base URL. No trailing slash. */
  baseUrl: string;
}

function jsdelivrGh(repo: string, commit: string, path: string): string {
  return `https://cdn.jsdelivr.net/gh/${repo}@${commit}/${path}`;
}

const COZY_PIXEL_V1_COMMIT = '26bf77115a46fea907bc0a5e1c135a3501a59be4';

export const RENDERPACK_RELEASES: readonly RenderpackRelease[] = Object.freeze([
  Object.freeze({
    id: 'cozy-pixel-v1',
    version: '1.0.0',
    source: {
      repo: 'Danidfra/farm-nostr-game',
      commit: COZY_PIXEL_V1_COMMIT,
      path: 'renderpacks/cozy-pixel-v1',
    },
    baseUrl: jsdelivrGh('Danidfra/farm-nostr-game', COZY_PIXEL_V1_COMMIT, 'renderpacks/cozy-pixel-v1'),
  }),
]);

/** The renderpack every V1 farm is created with. */
export const DEFAULT_RENDERPACK_REF: RenderpackRef = Object.freeze({ id: 'cozy-pixel-v1', version: '1.0.0' });

export function resolveRenderpack(ref: RenderpackRef | undefined): RenderpackRelease | undefined {
  if (!ref) return undefined;
  return RENDERPACK_RELEASES.find((r) => r.id === ref.id && r.version === ref.version);
}

export function formatRenderpackRef(ref: RenderpackRef): string {
  return `${ref.id}@${ref.version}`;
}
