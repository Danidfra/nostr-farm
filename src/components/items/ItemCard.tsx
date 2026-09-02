import { Copy, ImageOff } from 'lucide-react';

import { getPrimaryItemImage, type GameItemDefinition } from '@/inventory/package';
import { canEditItem } from '@/inventory/issuer';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { IssuerBadge, IssuerHandle } from './IssuerBadge';

interface ItemCardProps {
  item: GameItemDefinition;
  signerPubkey: string | null;
  onEdit: (item: GameItemDefinition) => void;
  onDerive: (item: GameItemDefinition) => void;
  onCopyAddress: (address: string) => void;
}

/**
 * One registry row.
 *
 * The image is resolved with the package's `getPrimaryItemImage`, which
 * implements the spec's rule — first unmarked image, else first valid image,
 * else none — rather than a second copy of it here.
 */
export function ItemCard({ item, signerPubkey, onEdit, onDerive, onCopyAddress }: ItemCardProps) {
  const image = getPrimaryItemImage(item);
  const editable = canEditItem(signerPubkey, item.issuer);

  return (
    <Card className="overflow-hidden">
      <CardContent className="flex gap-3 p-3">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md border bg-muted">
          {image ? (
            <img src={image} alt={item.name} className="h-full w-full object-contain" style={{ imageRendering: 'pixelated' }} />
          ) : (
            <ImageOff className="h-6 w-6 text-muted-foreground" />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-semibold">{item.name}</h3>
            <IssuerBadge pubkey={item.issuer} />
            {item.rarity && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs capitalize text-amber-700 dark:text-amber-400">
                {item.rarity}
              </span>
            )}
          </div>

          <code className="block truncate text-xs text-muted-foreground" title={item.address}>
            {item.id}
          </code>

          <div className="flex flex-wrap gap-1 text-xs">
            <Facet label={item.type} />
            {item.category && <Facet label={item.category} />}
            {item.contexts.map((context) => (
              <Facet key={context} label={context} tone="context" />
            ))}
            {item.topics.map((topic) => (
              <Facet key={topic} label={`#${topic}`} tone="topic" />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <IssuerHandle pubkey={item.issuer} />
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => onCopyAddress(item.address)}>
              <Copy className="mr-1 h-3 w-3" />
              Copy address
            </Button>
            {editable ? (
              <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => onEdit(item)}>
                Edit
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => onDerive(item)}>
                Use as template
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Facet({ label, tone }: { label: string; tone?: 'context' | 'topic' }) {
  const classes =
    tone === 'context'
      ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
      : tone === 'topic'
        ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
        : 'bg-muted text-muted-foreground';
  return <span className={`rounded px-1.5 py-0.5 ${classes}`}>{label}</span>;
}
