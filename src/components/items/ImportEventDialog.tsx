import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { importEventJson, type ImportMode, type ImportedEvent } from '@/inventory/registry/form-event';

interface ImportEventDialogProps {
  open: boolean;
  onClose: () => void;
  signerPubkey: string | null;
  onImported: (imported: ImportedEvent, mode: ImportMode) => void;
}

/**
 * Paste a kind:31632 event and load it into the editor.
 *
 * Parsing goes through `importEventJson`, which reuses the registry's own
 * `eventToForm` path — there is no second parser, so tag handling, image
 * markers and unknown-tag preservation behave identically to loading an item
 * from a relay.
 *
 * Importing populates the form and nothing else: it never signs and never
 * publishes.
 */
export function ImportEventDialog({ open, onClose, signerPubkey, onImported }: ImportEventDialogProps) {
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportedEvent | null>(null);

  const reset = () => {
    setRaw('');
    setError(null);
    setPreview(null);
  };

  const parse = () => {
    const result = importEventJson(raw, { signerPubkey });
    if (!result.ok) {
      setError(result.error);
      setPreview(null);
      return;
    }
    setError(null);
    setPreview(result.value);
  };

  const load = (mode: ImportMode) => {
    const result = importEventJson(raw, { signerPubkey, mode });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onImported(result.value, mode);
    reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-auto">
        <DialogHeader>
          <DialogTitle>Import event JSON</DialogTitle>
          <DialogDescription>
            Paste a kind:31632 event — a full signed event, or a bare{' '}
            <code>{'{ kind, content, tags }'}</code> object. Nothing is signed or published.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          rows={12}
          value={raw}
          placeholder='{ "kind": 31632, "content": "…", "tags": [["d","farm:produce:carrot"], …] }'
          onChange={(e) => {
            setRaw(e.target.value);
            setError(null);
            setPreview(null);
          }}
          className="font-mono text-xs"
          aria-label="Event JSON"
        />

        {error && (
          <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{error}</p>
        )}

        {preview && (
          <div className="space-y-2 rounded border p-3 text-sm">
            <p>
              <span className="font-medium">{preview.form.name}</span>{' '}
              <code className="text-xs text-muted-foreground">{preview.form.d}</code>
            </p>
            <p className="text-xs text-muted-foreground">
              {preview.form.images.length} image{preview.form.images.length === 1 ? '' : 's'} ·{' '}
              {preview.form.contexts.length} context{preview.form.contexts.length === 1 ? '' : 's'} ·{' '}
              {preview.form.topics.length} topic{preview.form.topics.length === 1 ? '' : 's'}
              {preview.form.extraTags.length > 0 && ` · ${preview.form.extraTags.length} preserved tag(s)`}
            </p>
            {preview.source.address && (
              <p className="text-xs">
                Source address: <code className="break-all">{preview.source.address}</code>
              </p>
            )}
            {preview.warnings.map((warning) => (
              <p key={warning} className="text-xs text-amber-700 dark:text-amber-400">
                {warning}
              </p>
            ))}
            {!preview.canLoadAsExisting && (
              <p className="text-xs text-muted-foreground">
                Imports as a new item: its id stays editable and publishing will not replace anything.
                {preview.source.isSignedEvent
                  ? ' This event was signed by another key, so it cannot be edited in place.'
                  : ' Only a signed event from your own key can be edited in place.'}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>
            Cancel
          </Button>
          {!preview ? (
            <Button onClick={parse} disabled={raw.trim() === ''}>
              Parse
            </Button>
          ) : (
            <>
              {preview.canLoadAsExisting && (
                <Button variant="outline" onClick={() => load('existing')}>
                  Load as existing event
                </Button>
              )}
              <Button onClick={() => load('template')}>Import as new item</Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
