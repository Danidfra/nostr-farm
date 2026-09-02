import { BadgeCheck, User } from 'lucide-react';

import { describeIssuer, issuerLabel } from '@/inventory/issuer';
import { cn } from '@/lib/utils';

/**
 * The official/external distinction, rendered the same way everywhere.
 *
 * External is styled as neutral information, not as a warning: an item from
 * another issuer is a normal, valid item. What the badge guarantees is that an
 * external item can never be mistaken for an official one.
 */
export function IssuerBadge({ pubkey, className }: { pubkey: string; className?: string }) {
  const issuer = describeIssuer(pubkey);
  const Icon = issuer.isOfficial ? BadgeCheck : User;

  return (
    <span
      title={issuer.npub ?? issuer.pubkey}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        issuer.isOfficial
          ? 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400'
          : 'bg-muted text-muted-foreground',
        className
      )}
    >
      <Icon className="h-3 w-3" />
      {issuerLabel(issuer.kind)}
    </span>
  );
}

/** The abbreviated, inspectable issuer identity. */
export function IssuerHandle({ pubkey, className }: { pubkey: string; className?: string }) {
  const issuer = describeIssuer(pubkey);
  return (
    <code className={cn('text-xs text-muted-foreground', className)} title={issuer.npub ?? issuer.pubkey}>
      {issuer.short}
    </code>
  );
}
