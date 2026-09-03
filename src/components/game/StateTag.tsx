import type { CSSProperties, ReactNode } from 'react';
import { Droplet, Droplets, Sparkles, TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/utils';

export type StateTone = 'ready' | 'water' | 'growing' | 'rotten';

const ICONS: Record<StateTone, typeof Droplet> = {
  ready: Sparkles,
  water: Droplet,
  growing: Droplets,
  rotten: TriangleAlert,
};

const ICON_TONE: Record<StateTone, string> = {
  ready: 'text-farm-harvest',
  water: 'text-farm-water',
  growing: 'text-farm-water',
  rotten: 'text-farm-rot',
};

interface StateTagProps {
  tone: StateTone;
  children: ReactNode;
  /** Font size in CSS pixels; the field scales it with the tile. */
  fontSize?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * A small paper tag naming a crop's state. Paper rather than a saturated
 * block so it reads on any part of the artwork, in both themes; the colour
 * lives in the icon.
 */
export function StateTag({ tone, children, fontSize = 12, className, style }: StateTagProps) {
  const Icon = ICONS[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-border/70 bg-card/95 px-1.5 py-px font-medium leading-none text-card-foreground shadow-pill tabular-nums',
        tone === 'ready' && 'motion-safe:animate-farm-glow',
        className
      )}
      style={{ fontSize, ...style }}
    >
      <Icon className={cn('shrink-0', ICON_TONE[tone])} style={{ width: fontSize, height: fontSize }} aria-hidden />
      {children}
    </span>
  );
}
