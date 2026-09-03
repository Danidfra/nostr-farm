import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * A paper panel: the one surface treatment the game's chrome shares.
 *
 * Thin on purpose. It fixes the surface, the title face and the description
 * tone so every gate screen, dialog body and menu reads as the same material;
 * layout inside is the caller's.
 */
export const Panel = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => <section ref={ref} className={cn('farm-paper p-6', className)} {...props} />
);
Panel.displayName = 'Panel';

export function PanelTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('font-display text-2xl font-semibold leading-tight tracking-tight text-balance', className)}
      {...props}
    />
  );
}

export function PanelDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm leading-relaxed text-muted-foreground', className)} {...props} />;
}
