import { CROP_CATALOG, CROP_IDS } from '@/farm/crops/catalog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { LoadedRenderpack } from '@/world/renderpack/types';
import { CropSprite } from './CropSprite';

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
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Plant a seed</DialogTitle>
          <DialogDescription>Choose what to grow in this plot.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {CROP_IDS.map((cropId) => {
            const crop = CROP_CATALOG[cropId];
            const sprite = renderpack.sprites[cropId];
            return (
              <button
                key={cropId}
                type="button"
                onClick={() => {
                  onSelect(cropId);
                  onClose();
                }}
                className="flex flex-col items-center gap-2 rounded-lg border-2 border-muted p-3 transition-colors hover:border-primary hover:bg-accent"
              >
                {sprite ? (
                  <CropSprite sprite={sprite} frame={crop.harvestStage} size={56} />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded bg-muted text-xs text-muted-foreground">
                    no art
                  </div>
                )}
                <span className="text-sm font-medium capitalize">{cropId}</span>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
