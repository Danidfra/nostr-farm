import { Check, Copy, Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { describeSigner } from '@/inventory/issuer';
import type { KIND_GAME_ITEM_DEFINITION, UnsignedEventTemplate } from '@/inventory/package';
import type { PublishItemDefinitionResult } from '@/hooks/items/usePublishItemDefinition';
import { IssuerBadge } from './IssuerBadge';

interface PublishReviewDialogProps {
  open: boolean;
  onClose: () => void;
  template: UnsignedEventTemplate<typeof KIND_GAME_ITEM_DEFINITION> | null;
  error: string | null;
  signerPubkey: string | null;
  address: string | null;
  isEditing: boolean;
  isPublishing: boolean;
  result: PublishItemDefinitionResult | null;
  onPublish: () => void;
  onCopyAddress: (address: string) => void;
}

/**
 * The last thing between a form and a signature.
 *
 * The exact unsigned event is shown — kind, content, tags — because that, not
 * the form, is what gets signed. Publishing happens only from the button here.
 */
export function PublishReviewDialog({
  open,
  onClose,
  template,
  error,
  signerPubkey,
  address,
  isEditing,
  isPublishing,
  result,
  onPublish,
  onCopyAddress,
}: PublishReviewDialogProps) {
  const signer = describeSigner(signerPubkey);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-auto">
        <DialogHeader>
          <DialogTitle>{result ? 'Publish result' : isEditing ? 'Review update' : 'Review new item'}</DialogTitle>
          <DialogDescription>
            {result
              ? 'The event has been signed and offered to the registry relays.'
              : 'This is the exact event that will be signed. Nothing is published until you confirm.'}
          </DialogDescription>
        </DialogHeader>

        {error && <p className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

        {!result && template && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {signerPubkey && <IssuerBadge pubkey={signerPubkey} />}
              <span className="text-muted-foreground">signing as</span>
              <code className="text-xs">{signer.short}</code>
            </div>

            {isEditing && (
              <p className="rounded border border-sky-500/40 bg-sky-500/10 p-2 text-xs">
                kind:31632 is addressable. Publishing with the same author and <code>d</code> replaces the existing
                definition at this address.
              </p>
            )}
            {!signer.isOfficialIssuer && signer.canPublish && (
              <p className="rounded border border-muted bg-muted/40 p-2 text-xs text-muted-foreground">
                You are not the official Farm issuer, so this publishes as an <strong>External Item</strong> under your own
                key. That is a normal, valid item — it just will not be shown as official.
              </p>
            )}

            {address && (
              <p className="text-xs">
                Address: <code className="break-all">{address}</code>
              </p>
            )}

            <pre className="max-h-80 overflow-auto rounded bg-muted p-3 font-mono text-xs">
              {JSON.stringify({ kind: template.kind, content: template.content, tags: template.tags }, null, 2)}
            </pre>
          </div>
        )}

        {result && (
          <div className="space-y-3">
            {result.record && (
              <div className="flex flex-wrap items-center gap-2">
                <IssuerBadge pubkey={result.event.pubkey} />
                <span className="font-medium">{result.record.definition.name}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <code className="break-all">{result.record?.address ?? address}</code>
              {(result.record?.address ?? address) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  onClick={() => onCopyAddress(result.record?.address ?? address!)}
                >
                  <Copy className="mr-1 h-3 w-3" />
                  Copy
                </Button>
              )}
            </div>

            <ul className="space-y-1 text-sm">
              {result.outcomes.map((outcome) => (
                <li key={outcome.relay} className="flex items-center gap-2">
                  {outcome.ok ? (
                    <Check className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <X className="h-4 w-4 text-destructive" />
                  )}
                  <code className="text-xs">{outcome.relay}</code>
                  {outcome.error && <span className="text-xs text-muted-foreground">{outcome.error}</span>}
                </li>
              ))}
            </ul>

            {!result.reachedAnyRelay && (
              <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
                No relay accepted the event. Nothing was published.
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button disabled={!template || !signer.canPublish || isPublishing} onClick={onPublish}>
              {isPublishing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {signer.canPublish ? 'Sign and publish' : 'Sign in to publish'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
