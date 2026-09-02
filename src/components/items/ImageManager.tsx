import { useRef } from 'react';
import { Loader2, Trash2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MARKER_OPTIONS, PRIMARY_MARKER, blankImageRow, type ImageRow } from '@/inventory/registry/form-model';
import { SUGGESTABLE_MARKERS } from '@/inventory/registry/image-upload';
import type { ItemImageUploadApi } from '@/hooks/items/useItemImageUpload';

interface ImageManagerProps {
  rows: ImageRow[];
  onChange: (rows: ImageRow[]) => void;
  upload: ItemImageUploadApi;
  canUpload: boolean;
}

const MARKER_LABEL = (marker: string) => (marker === PRIMARY_MARKER ? 'primary (unmarked)' : marker);

/**
 * Image rows plus the Blossom upload queue.
 *
 * An upload does exactly one thing: it puts a URL into a row. It never signs
 * anything and never publishes — that is a separate, explicit action.
 */
export function ImageManager({ rows, onChange, upload, canUpload }: ImageManagerProps) {
  const fileInput = useRef<HTMLInputElement>(null);

  const primaryCount = rows.filter((row) => row.marker === PRIMARY_MARKER && row.url.trim() !== '').length;

  /**
   * Apply whatever succeeded and keep whatever failed.
   *
   * Only the successful entries are cleared from the queue. A failed upload
   * stays visible with its error so it can be retried, and because `uploadAll`
   * skips entries that are already `done`, a retry never re-applies an image
   * that already landed.
   */
  const applyUploads = async () => {
    const uploaded = await upload.uploadAll();
    if (uploaded.length > 0) {
      onChange([
        ...rows.filter((row) => row.url.trim() !== ''),
        ...uploaded.map((entry) => ({ ...blankImageRow(entry.marker), url: entry.url })),
      ]);
    }
    upload.removeCompleted();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">Images</Label>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...rows, blankImageRow()])}>
          Add URL row
        </Button>
      </div>

      {primaryCount === 0 && rows.length > 0 && (
        <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
          No unmarked image. Clients that ignore view markers will fall back to whichever view comes first, which may be a
          back or side pose. Publishing exactly one unmarked image is recommended.
        </p>
      )}
      {primaryCount > 1 && (
        <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          More than one unmarked image: the canonical image is ambiguous and different clients may pick differently.
        </p>
      )}

      {rows.map((row, index) => (
        <div key={row.id} className="flex gap-2">
          <Input
            value={row.url}
            placeholder="https://…"
            aria-label={`Image URL ${index + 1}`}
            onChange={(e) => onChange(rows.map((r) => (r.id === row.id ? { ...r, url: e.target.value } : r)))}
          />
          <Select
            value={row.marker}
            onValueChange={(marker) => onChange(rows.map((r) => (r.id === row.id ? { ...r, marker } : r)))}
          >
            <SelectTrigger className="w-52" aria-label={`Marker ${index + 1}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MARKER_OPTIONS.map((marker) => (
                <SelectItem key={marker || 'primary'} value={marker || PRIMARY_MARKER}>
                  {MARKER_LABEL(marker)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Remove image ${index + 1}`}
            onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <div className="rounded-lg border border-dashed p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={!canUpload} onClick={() => fileInput.current?.click()}>
            <Upload className="mr-2 h-4 w-4" />
            Choose images
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              upload.addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <span className="text-xs text-muted-foreground">
            {canUpload ? 'Uploaded to Blossom; the returned URL fills an image row.' : 'Sign in to upload.'}
          </span>
        </div>

        {upload.entries.length > 0 && (
          <div className="mt-3 space-y-2">
            {upload.entries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-2 text-xs">
                <span className="w-40 truncate" title={entry.filename}>{entry.filename}</span>
                <Select value={entry.marker} onValueChange={(marker) => upload.setMarker(entry.id, marker)}>
                  <SelectTrigger className="h-7 w-48" aria-label={`Marker for ${entry.filename}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUGGESTABLE_MARKERS.map((marker) => (
                      <SelectItem key={marker || 'primary'} value={marker || PRIMARY_MARKER}>
                        {MARKER_LABEL(marker)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className={entry.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
                  {entry.status === 'error' ? entry.error : entry.status}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="ml-auto h-6 w-6"
                  aria-label={`Remove ${entry.filename} from the queue`}
                  onClick={() => upload.remove(entry.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" disabled={upload.isUploading || !upload.hasPending} onClick={applyUploads}>
                {upload.isUploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {upload.hasFailures ? 'Retry failed uploads' : 'Upload to Blossom'}
              </Button>
              {upload.hasFailures && (
                <span className="text-xs text-muted-foreground">
                  Successful uploads were applied; failures stay listed for retry.
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
