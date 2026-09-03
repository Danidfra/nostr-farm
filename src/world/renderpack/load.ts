import {
  formatRenderpackRef,
  resolveRenderpack,
  type RenderpackRef,
  type RenderpackRelease,
} from './registry';
import { RenderpackLoadError, type CropSprite, type LoadedRenderpack, type RenderpackManifest } from './types';

function joinUrl(base: string, path: string): string {
  return `${base}/${String(path).replace(/^\/+/, '')}`;
}

async function fetchJson(url: string, ref: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (cause) {
    throw new RenderpackLoadError(`Could not reach the renderpack at ${url}.`, { ref, url, cause });
  }
  if (!response.ok) {
    throw new RenderpackLoadError(`Renderpack file returned HTTP ${response.status}.`, { ref, url });
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new RenderpackLoadError(`Renderpack file is not valid JSON.`, { ref, url, cause });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManifest(raw: unknown, release: RenderpackRelease, url: string): RenderpackManifest {
  if (!isRecord(raw)) {
    throw new RenderpackLoadError('Renderpack manifest is not an object.', { ref: formatRenderpackRef(release), url });
  }
  const tileSize = Number(raw.tileSize);
  if (!Number.isFinite(tileSize) || tileSize <= 0) {
    throw new RenderpackLoadError('Renderpack manifest has no usable tileSize.', { ref: formatRenderpackRef(release), url });
  }
  return {
    id: typeof raw.id === 'string' ? raw.id : release.id,
    version: typeof raw.version === 'string' ? raw.version : release.version,
    tileSize: Math.trunc(tileSize),
  };
}

/**
 * Sprite paths in `crops.json` are inconsistent across the shipped pack: some
 * are relative to the pack root (`assets/crops/carrot.png`), the rotten sprite
 * is relative to the assets directory (`crops/crop-rotten.png`). Rather than
 * mutate published artwork, normalize on read.
 */
function normalizeAssetPath(path: string): string {
  const clean = String(path).replace(/^\/+/, '');
  if (clean.startsWith('assets/')) return clean;
  return `assets/${clean}`;
}

/** The pinned URL of one asset of a release, without loading the pack. */
export function renderpackAssetUrl(release: RenderpackRelease, path: string): string {
  return joinUrl(release.baseUrl, normalizeAssetPath(path));
}

function parseSprites(raw: unknown, release: RenderpackRelease, url: string): Record<string, CropSprite> {
  if (!isRecord(raw) || !isRecord(raw.crops)) {
    throw new RenderpackLoadError('Renderpack crops.json has no `crops` dictionary.', { ref: formatRenderpackRef(release), url });
  }

  const sprites: Record<string, CropSprite> = {};
  for (const [cropId, value] of Object.entries(raw.crops)) {
    if (!isRecord(value) || typeof value.file !== 'string') continue;
    const frames = Number(value.stages);
    sprites[cropId] = {
      cropId,
      sheetUrl: joinUrl(release.baseUrl, normalizeAssetPath(value.file)),
      frames: Number.isFinite(frames) && frames > 0 ? Math.trunc(frames) : 1,
      rottenUrl: typeof value.rottenFile === 'string' ? joinUrl(release.baseUrl, normalizeAssetPath(value.rottenFile)) : undefined,
    };
  }

  if (Object.keys(sprites).length === 0) {
    throw new RenderpackLoadError('Renderpack declares no usable crop sprites.', { ref: formatRenderpackRef(release), url });
  }
  return sprites;
}

/**
 * Load a pinned renderpack. Unknown refs fail immediately and loudly rather
 * than falling back to a mutable URL.
 */
export async function loadRenderpack(ref: RenderpackRef, signal?: AbortSignal): Promise<LoadedRenderpack> {
  const refLabel = formatRenderpackRef(ref);
  const release = resolveRenderpack(ref);
  if (!release) {
    throw new RenderpackLoadError(
      `Unknown renderpack "${refLabel}". Only pinned renderpacks from the registry can be loaded.`,
      { ref: refLabel }
    );
  }

  const manifestUrl = joinUrl(release.baseUrl, 'manifest.json');
  const cropsUrl = joinUrl(release.baseUrl, 'meta/crops.json');

  const [manifestRaw, cropsRaw] = await Promise.all([
    fetchJson(manifestUrl, refLabel, signal),
    fetchJson(cropsUrl, refLabel, signal),
  ]);

  const manifest = parseManifest(manifestRaw, release, manifestUrl);
  const sprites = parseSprites(cropsRaw, release, cropsUrl);

  return {
    release,
    manifest,
    tileSize: manifest.tileSize,
    sprites: Object.freeze(sprites),
    assetUrl: (path: string) => renderpackAssetUrl(release, path),
  };
}
