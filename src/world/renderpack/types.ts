import type { RenderpackRelease } from './registry';

/** Sprite geometry for one crop, as declared by the renderpack. */
export interface CropSprite {
  cropId: string;
  /** Absolute URL of the horizontal spritesheet. */
  sheetUrl: string;
  /** Number of frames in the sheet. */
  frames: number;
  /** Absolute URL of the "rotten" sprite, when the pack ships one. */
  rottenUrl?: string;
}

export interface RenderpackManifest {
  id: string;
  version: string;
  tileSize: number;
}

/** Everything the renderer needs, all URLs already resolved and pinned. */
export interface LoadedRenderpack {
  release: RenderpackRelease;
  manifest: RenderpackManifest;
  tileSize: number;
  sprites: Readonly<Record<string, CropSprite>>;
  /** Resolve a pack-relative asset path to an absolute pinned URL. */
  assetUrl(path: string): string;
}

/** Thrown with enough context to tell a pinning mistake from a network blip. */
export class RenderpackLoadError extends Error {
  constructor(
    message: string,
    readonly detail: { ref: string; url?: string; cause?: unknown }
  ) {
    super(message);
    this.name = 'RenderpackLoadError';
  }
}
