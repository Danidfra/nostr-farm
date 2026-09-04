import { CROP_CATALOG, CROP_IDS } from '@/farm/crops/catalog';
import { GameDialog } from '@/components/game/GameDialog';
import type { LoadedRenderpack } from '@/world/renderpack/types';
import { CropSprite } from './CropSprite';
import { describeGrowTime } from './slotDisplay';

interface SeedPickerProps {
  isOpen: boolean;
  onClose: () => void;
  renderpack: LoadedRenderpack;
  onSelect: (cropId: string) => void;
}

/**
 * Seed choices come from the source-controlled crop catalog; the renderpack is
 * only asked for the picture. A crop the pack has no art for is still listed,
 * so a missing sprite is visible rather than silently unplantable.
 */
export function SeedPicker({ isOpen, onClose, renderpack, onSelect }: SeedPickerProps) {
  return (
    <GameDialog
      open={isOpen}
      onOpenChange={(open) => !open && onClose()}
      title="Plant a seed"
      description="Choose what to grow in this plot."
      className="max-w-lg"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {CROP_IDS.map((cropId) => {
          const crop = CROP_CATALOG[cropId];
          const sprite = renderpack.sprites[cropId];
          const growTime = describeGrowTime(cropId);
          return (
            <button
              key={cropId}
              type="button"
              onClick={() => {
                onSelect(cropId);
                onClose();
              }}
              title={growTime ?? undefined}
              className="flex flex-col items-center gap-2 rounded-xl border border-border bg-background/60 p-3 text-center transition-[border-color,background-color,transform] hover:border-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:translate-y-px"
            >
              {sprite ? (
                <CropSprite sprite={sprite} frame={crop.harvestStage} size={56} />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground">
                  no art
                </div>
              )}
              <span className="font-display text-base font-semibold capitalize leading-none">{cropId}</span>
              {growTime && <span className="text-[11px] leading-tight text-muted-foreground">{growTime}</span>}
            </button>
          );
        })}
      </div>
    </GameDialog>
  );
}
