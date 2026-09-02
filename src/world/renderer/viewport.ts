import type { ComputedGrid } from './grid';
import { pixelToSlot } from './grid';

/**
 * How the natural-size background is placed inside the on-screen container.
 * The renderer scales the background to fit and letterboxes the remainder.
 */
export interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

export function fitViewport(
  natural: { w: number; h: number },
  container: { w: number; h: number }
): Viewport {
  if (natural.w <= 0 || natural.h <= 0 || container.w <= 0 || container.h <= 0) {
    return { scale: 1, offsetX: 0, offsetY: 0, width: natural.w, height: natural.h };
  }
  const scale = Math.min(container.w / natural.w, container.h / natural.h);
  const width = natural.w * scale;
  const height = natural.h * scale;
  return {
    scale,
    offsetX: (container.w - width) / 2,
    offsetY: (container.h - height) / 2,
    width,
    height,
  };
}

/** Convert a pointer position (relative to the container) into a grid slot. */
export function pointerToSlot(
  pointer: { x: number; y: number },
  viewport: Viewport,
  grid: ComputedGrid
): { x: number; y: number } | null {
  if (viewport.scale <= 0) return null;
  const naturalX = (pointer.x - viewport.offsetX) / viewport.scale;
  const naturalY = (pointer.y - viewport.offsetY) / viewport.scale;
  return pixelToSlot(grid, naturalX, naturalY);
}
