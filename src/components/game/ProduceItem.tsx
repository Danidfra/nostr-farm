import { CROP_CATALOG, getCrop } from '@/farm/crops/catalog';
import type { ProduceDefinition } from '@/inventory/produce-catalog';
import type { CropSprite as CropSpriteMeta } from '@/world/renderpack/types';
import { CropSprite } from '@/components/farm/CropSprite';
import { cn } from '@/lib/utils';

interface ProduceItemProps {
  definition: ProduceDefinition;
  quantity: number;
  /** The renderpack's sprite for this crop, when loaded. Falls back to the emoji. */
  sprite?: CropSpriteMeta;
  size?: 'sm' | 'md';
  /** Render as held-but-empty (zero) rather than hiding. */
  dim?: boolean;
  className?: string;
}

const SPRITE_PX = { sm: 26, md: 40 } as const;

/**
 * One produce item: the crop as the renderpack draws it at harvest, plus a
 * count in the display face. The accessible name says it in words
 * ("14 Carrot"), so the artwork never has to.
 */
export function ProduceItem({ definition, quantity, sprite, size = 'sm', dim, className }: ProduceItemProps) {
  const crop = getCrop(definition.cropId, CROP_CATALOG);
  const px = SPRITE_PX[size];

  return (
    <span
      className={cn('inline-flex items-center gap-1.5', dim && 'opacity-50', className)}
      role="img"
      aria-label={`${quantity} ${definition.name}`}
      title={`${quantity} ${definition.name}`}
    >
      {sprite && crop ? (
        <CropSprite sprite={sprite} frame={crop.harvestStage} size={px} className="shrink-0" />
      ) : (
        <span className="shrink-0 leading-none" style={{ fontSize: px * 0.8 }} aria-hidden>
          {definition.emoji}
        </span>
      )}
      <span
        className={cn('font-display font-semibold leading-none tabular-nums', size === 'md' ? 'text-2xl' : 'text-lg')}
        aria-hidden
      >
        {quantity}
      </span>
    </span>
  );
}
