import { useMemo, useState } from 'react';

import { CROP_CATALOG, getCrop } from '@/farm/crops/catalog';
import { evaluatePlant } from '@/farm/growth/evaluate';
import type { FarmSlot } from '@/farm/slots/types';
import type { FarmActionType } from '@/farm/slots/actions';
import type { UnixSeconds } from '@/farm/time';
import type { MapDefinition } from '@/world/definitions/schema';
import { computeGrid, slotToPixel } from '@/world/renderer/grid';
import { fitViewport, pointerToSlot } from '@/world/renderer/viewport';
import type { LoadedRenderpack } from '@/world/renderpack/types';
import { useElementSize } from '@/hooks/useElementSize';
import { cn } from '@/lib/utils';
import { CropSprite } from './CropSprite';
import { formatDuration, primaryAction } from './slotDisplay';

export interface FarmFieldProps {
  definition: MapDefinition;
  renderpack: LoadedRenderpack;
  /** Slot lookup by grid coordinate; every cell of the grid is addressable. */
  readSlot: (x: number, y: number) => FarmSlot;
  nowSec: UnixSeconds;
  busy?: boolean;
  onSlotAction: (slot: FarmSlot, action: FarmActionType) => void;
  onPlantRequest: (slot: FarmSlot) => void;
}

export function FarmField({
  definition,
  renderpack,
  readSlot,
  nowSec,
  busy,
  onSlotAction,
  onPlantRequest,
}: FarmFieldProps) {
  const { ref, size } = useElementSize<HTMLDivElement>();
  const [hovered, setHovered] = useState<{ x: number; y: number } | null>(null);

  const grid = useMemo(() => computeGrid(definition), [definition]);
  const viewport = useMemo(
    () => fitViewport({ w: definition.backgroundSize.w, h: definition.backgroundSize.h }, { w: size.width, h: size.height }),
    [definition.backgroundSize.w, definition.backgroundSize.h, size.width, size.height]
  );

  const backgroundUrl = renderpack.assetUrl(definition.background);

  const handlePointer = (event: React.PointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    return pointerToSlot({ x: event.clientX - rect.left, y: event.clientY - rect.top }, viewport, grid);
  };

  const handleClick = (event: React.PointerEvent<HTMLDivElement>) => {
    if (busy) return;
    const coord = handlePointer(event);
    if (!coord) return;

    const slot = readSlot(coord.x, coord.y);
    const action = primaryAction(slot, nowSec);
    if (action === 'plant') onPlantRequest(slot);
    else onSlotAction(slot, action);
  };

  return (
    <div ref={ref} className="relative h-full w-full overflow-hidden">
      <div
        className={cn('absolute select-none', busy ? 'cursor-wait' : 'cursor-pointer')}
        style={{
          left: viewport.offsetX,
          top: viewport.offsetY,
          width: viewport.width,
          height: viewport.height,
        }}
        onPointerMove={(event) => setHovered(handlePointer(event))}
        onPointerLeave={() => setHovered(null)}
        onClick={(event) => handleClick(event as unknown as React.PointerEvent<HTMLDivElement>)}
      >
        <img
          src={backgroundUrl}
          alt={definition.name}
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full"
          style={{ imageRendering: 'pixelated' }}
        />

        {grid.cells.map((cell) => {
          const slot = readSlot(cell.col, cell.row);
          const isHovered = hovered?.x === cell.col && hovered?.y === cell.row;
          return (
            <SlotView
              key={`${cell.col}:${cell.row}`}
              slot={slot}
              renderpack={renderpack}
              nowSec={nowSec}
              scale={viewport.scale}
              tileSize={grid.tileSize}
              position={slotToPixel(grid, cell.col, cell.row)!}
              hovered={isHovered}
            />
          );
        })}
      </div>
    </div>
  );
}

interface SlotViewProps {
  slot: FarmSlot;
  renderpack: LoadedRenderpack;
  nowSec: UnixSeconds;
  scale: number;
  tileSize: number;
  position: { px: number; py: number };
  hovered: boolean;
}

function SlotView({ slot, renderpack, nowSec, scale, tileSize, position, hovered }: SlotViewProps) {
  const box = {
    left: position.px * scale,
    top: position.py * scale,
    width: tileSize * scale,
    height: tileSize * scale,
  };

  if (slot.content.type !== 'plant') {
    return (
      <div
        className={cn('absolute rounded transition-colors', hovered && 'bg-white/25 ring-2 ring-white/60')}
        style={box}
      />
    );
  }

  const { plant } = slot.content;
  const crop = getCrop(plant.cropId, CROP_CATALOG);
  const sprite = renderpack.sprites[plant.cropId];
  const view = crop ? evaluatePlant(plant, nowSec, crop) : null;

  return (
    <div className={cn('absolute rounded transition-colors', hovered && 'bg-white/20 ring-2 ring-white/50')} style={box}>
      <CropSprite
        sprite={sprite}
        frame={view?.stage ?? 0}
        size={box.width}
        rotten={view?.phase === 'rotten'}
        className="pointer-events-none absolute inset-0"
      />

      {view && <SlotBadge view={view} scale={scale} />}
    </div>
  );
}

function SlotBadge({ view, scale }: { view: ReturnType<typeof evaluatePlant>; scale: number }) {
  const fontSize = Math.max(9, Math.round(11 * scale));

  if (view.phase === 'rotten') {
    return <Badge fontSize={fontSize} tone="bg-stone-700/90">rotten</Badge>;
  }
  if (view.phase === 'ready') {
    return <Badge fontSize={fontSize} tone="bg-amber-500/95">ready</Badge>;
  }
  if (view.needsWater) {
    return <Badge fontSize={fontSize} tone="bg-sky-600/95">water</Badge>;
  }
  return <Badge fontSize={fontSize} tone="bg-emerald-700/85">{formatDuration(view.secondsUntilDry)}</Badge>;
}

function Badge({ children, tone, fontSize }: { children: React.ReactNode; tone: string; fontSize: number }) {
  return (
    <span
      className={cn('pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 rounded px-1 font-medium text-white', tone)}
      style={{ fontSize }}
    >
      {children}
    </span>
  );
}
