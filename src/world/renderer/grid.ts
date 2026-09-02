import type { MapDefinition } from '../definitions/schema';

export interface GridCell {
  col: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputedGrid {
  /** Top-left corner of cell (0,0) in natural background pixels. */
  originX: number;
  originY: number;
  cols: number;
  rows: number;
  tileSize: number;
  cells: GridCell[];
}

/** Lay the plantable grid out inside the map's plant area. */
export function computeGrid(map: MapDefinition): ComputedGrid {
  const { plantArea, grid, tileSize } = map;

  let originX = plantArea.x;
  let originY = plantArea.y;
  if (grid.align === 'center') {
    originX += (plantArea.w - grid.cols * tileSize) / 2;
    originY += (plantArea.h - grid.rows * tileSize) / 2;
  }
  originX = Math.round(originX);
  originY = Math.round(originY);

  const cells: GridCell[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      cells.push({
        col,
        row,
        x: originX + col * tileSize,
        y: originY + row * tileSize,
        width: tileSize,
        height: tileSize,
      });
    }
  }

  return { originX, originY, cols: grid.cols, rows: grid.rows, tileSize, cells };
}

/** Top-left pixel of a slot, or null when the slot is off the grid. */
export function slotToPixel(grid: ComputedGrid, x: number, y: number): { px: number; py: number } | null {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || x >= grid.cols || y < 0 || y >= grid.rows) return null;
  return { px: grid.originX + x * grid.tileSize, py: grid.originY + y * grid.tileSize };
}

/** Natural-pixel coordinate to slot, or null when outside the grid. */
export function pixelToSlot(grid: ComputedGrid, px: number, py: number): { x: number; y: number } | null {
  const x = Math.floor((px - grid.originX) / grid.tileSize);
  const y = Math.floor((py - grid.originY) / grid.tileSize);
  if (x < 0 || x >= grid.cols || y < 0 || y >= grid.rows) return null;
  return { x, y };
}
