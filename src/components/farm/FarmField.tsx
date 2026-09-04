import { useMemo, useState } from 'react';

import { CROP_CATALOG, getCrop } from '@/farm/crops/catalog';
import { evaluatePlant } from '@/farm/growth/evaluate';
import type { FarmSlot, SlotCoord } from '@/farm/slots/types';
import type { FarmActionType } from '@/farm/slots/actions';
import type { UnixSeconds } from '@/farm/time';
import type { MapDefinition } from '@/world/definitions/schema';
import { computeGrid, slotToPixel } from '@/world/renderer/grid';
import { fitViewport, pointerToSlot } from '@/world/renderer/viewport';
import type { LoadedRenderpack } from '@/world/renderpack/types';
import { useElementSize } from '@/hooks/useElementSize';
import { StateTag } from '@/components/game/StateTag';
import { cn } from '@/lib/utils';
import { CropSprite } from './CropSprite';
import { describeSlotAction, formatDuration } from './slotDisplay';

/** A short-lived label rising from a slot after a successful harvest. */
export interface FieldBurst {
  id: string;
  coord: SlotCoord;
  label: string;
}

export interface FarmFieldProps {
  definition: MapDefinition;
  renderpack: LoadedRenderpack;
  /** Slot lookup by grid coordinate; every cell of the grid is addressable. */
  readSlot: (x: number, y: number) => FarmSlot;
  nowSec: UnixSeconds;
  busy?: boolean;
  onSlotAction: (slot: FarmSlot, action: FarmActionType) => void;
  onPlantRequest: (slot: FarmSlot) => void;
  /** Feedback the page adds after a mutation actually succeeded. */
  bursts?: readonly FieldBurst[];
}

const FRAME_INSET = 8;

export function FarmField({
  definition,
  renderpack,
  readSlot,
  nowSec,
  busy,
  onSlotAction,
  onPlantRequest,
  bursts = [],
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
    const { action } = describeSlotAction(slot, nowSec);
    if (action === 'plant') onPlantRequest(slot);
    else onSlotAction(slot, action);
  };

  const hoveredSlot = hovered ? readSlot(hovered.x, hovered.y) : null;
  const hint = hoveredSlot && !busy ? describeSlotAction(hoveredSlot, nowSec).label : null;
  const fontSize = Math.max(10, Math.round(11 * viewport.scale));

  return (
    // Pointer handlers live on the container, not on the letterboxed image
    // below: `pointerToSlot` subtracts `viewport.offset*` itself, so it needs
    // container-relative coordinates. Overflow stays visible so the frame,
    // drawn just outside the image, can spill into the page's padding.
    <div
      ref={ref}
      className={cn('relative h-full w-full', busy ? 'cursor-wait' : 'cursor-pointer')}
      onPointerMove={(event) => setHovered(handlePointer(event))}
      onPointerLeave={() => setHovered(null)}
      onClick={(event) => handleClick(event as unknown as React.PointerEvent<HTMLDivElement>)}
    >
      <div
        className="absolute select-none"
        style={{ left: viewport.offsetX, top: viewport.offsetY, width: viewport.width, height: viewport.height }}
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
              fontSize={fontSize}
            />
          );
        })}

        {hovered && hint && (
          <HoverHint
            label={hint}
            position={slotToPixel(grid, hovered.x, hovered.y)!}
            scale={viewport.scale}
            tileSize={grid.tileSize}
          />
        )}

        {bursts.map((burst) => (
          <Burst
            key={burst.id}
            label={burst.label}
            position={slotToPixel(grid, burst.coord.x, burst.coord.y)!}
            scale={viewport.scale}
            tileSize={grid.tileSize}
          />
        ))}
      </div>

      {/* The wooden frame, drawn last so its inner shadow sits over the art. */}
      <div
        className="farm-frame pointer-events-none absolute"
        aria-hidden
        style={{
          left: viewport.offsetX - FRAME_INSET,
          top: viewport.offsetY - FRAME_INSET,
          width: viewport.width + FRAME_INSET * 2,
          height: viewport.height + FRAME_INSET * 2,
        }}
      />
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
  fontSize: number;
}

function SlotView({ slot, renderpack, nowSec, scale, tileSize, position, hovered, fontSize }: SlotViewProps) {
  const box = {
    left: position.px * scale,
    top: position.py * scale,
    width: tileSize * scale,
    height: tileSize * scale,
  };

  if (slot.content.type !== 'plant') {
    return (
      <div
        className={cn('absolute rounded-md transition-[background-color,box-shadow]', hovered && 'bg-card/25 ring-2 ring-card/70')}
        style={box}
      />
    );
  }

  const { plant } = slot.content;
  const crop = getCrop(plant.cropId, CROP_CATALOG);
  const sprite = renderpack.sprites[plant.cropId];
  const view = crop ? evaluatePlant(plant, nowSec, crop) : null;

  return (
    <div
      className={cn('absolute rounded-md transition-[background-color,box-shadow]', hovered && 'bg-card/20 ring-2 ring-card/60')}
      style={box}
    >
      <CropSprite
        sprite={sprite}
        frame={view?.stage ?? 0}
        size={box.width}
        rotten={view?.phase === 'rotten'}
        className="pointer-events-none absolute inset-0"
      />

      {view && (
        <span className="pointer-events-none absolute bottom-0.5 left-1/2 -translate-x-1/2">
          <SlotStateTag view={view} fontSize={fontSize} />
        </span>
      )}
    </div>
  );
}

function SlotStateTag({ view, fontSize }: { view: ReturnType<typeof evaluatePlant>; fontSize: number }) {
  if (view.phase === 'rotten') {
    return <StateTag tone="rotten" fontSize={fontSize}>Rotten</StateTag>;
  }
  if (view.phase === 'ready') {
    return <StateTag tone="ready" fontSize={fontSize}>Ready</StateTag>;
  }
  if (view.needsWater) {
    return <StateTag tone="water" fontSize={fontSize}>Water</StateTag>;
  }
  return (
    <StateTag tone="growing" fontSize={fontSize}>
      {formatDuration(view.secondsUntilDry)}
    </StateTag>
  );
}

interface OverlayProps {
  label: string;
  position: { px: number; py: number };
  scale: number;
  tileSize: number;
}

/** The action a click would take, floating above the hovered cell. */
function HoverHint({ label, position, scale, tileSize }: OverlayProps) {
  return (
    <span
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-foreground px-2 py-0.5 text-xs font-semibold text-background shadow-pill"
      style={{ left: (position.px + tileSize / 2) * scale, top: position.py * scale - 4 }}
    >
      {label}
    </span>
  );
}

/** "+1 Carrot" rising from a harvested cell. Removed by the page when it has played. */
function Burst({ label, position, scale, tileSize }: OverlayProps) {
  return (
    <span
      className="pointer-events-none absolute z-20 whitespace-nowrap rounded-full border border-farm-harvest/60 bg-card px-2.5 py-1 font-display text-sm font-semibold text-card-foreground shadow-panel motion-safe:animate-farm-rise"
      style={{ left: (position.px + tileSize / 2) * scale, top: (position.py + tileSize / 2) * scale, transform: 'translate(-50%, 0)' }}
      role="status"
    >
      {label}
    </span>
  );
}
