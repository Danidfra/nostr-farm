import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/** The wooden rail the HUD sits on. Wraps onto two rows at phone widths. */
export function HudRail({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <header
      className={cn('farm-rail flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 sm:px-4', className)}
      {...props}
    />
  );
}

const hudPillVariants = cva(
  'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium leading-5 shadow-pill',
  {
    variants: {
      tone: {
        default: 'border-border bg-card text-card-foreground',
        warn: 'border-farm-harvest/50 bg-card text-card-foreground',
        quiet: 'border-transparent bg-card/70 text-muted-foreground',
      },
    },
    defaultVariants: { tone: 'default' },
  }
);

export interface HudPillProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof hudPillVariants> {}

/** A capsule on the rail: a status, a count, a small notice. */
export function HudPill({ className, tone, ...props }: HudPillProps) {
  return <span className={cn(hudPillVariants({ tone }), className)} {...props} />;
}
