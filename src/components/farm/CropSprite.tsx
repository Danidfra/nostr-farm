import type { CSSProperties } from 'react';

import type { CropSprite as CropSpriteMeta } from '@/world/renderpack/types';

interface CropSpriteProps {
  sprite: CropSpriteMeta | undefined;
  /** Frame index into the horizontal spritesheet. */
  frame: number;
  /** Rendered size in CSS pixels. */
  size: number;
  /** Render the pack's "rotten" artwork instead of a growth frame. */
  rotten?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * One crop frame, drawn by scaling the whole spritesheet to the target tile
 * size and offsetting to the requested frame. Scaling the sheet (rather than
 * the element) keeps neighbouring frames from bleeding in.
 */
export function CropSprite({ sprite, frame, size, rotten, className, style }: CropSpriteProps) {
  if (!sprite) return null;

  const url = rotten ? sprite.rottenUrl : sprite.sheetUrl;
  if (!url) return null;

  const frames = rotten ? 1 : Math.max(1, sprite.frames);
  const index = rotten ? 0 : Math.max(0, Math.min(frame, frames - 1));

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${url})`,
        backgroundSize: `${frames * size}px ${size}px`,
        backgroundPosition: `${-index * size}px 0px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
        ...style,
      }}
    />
  );
}
