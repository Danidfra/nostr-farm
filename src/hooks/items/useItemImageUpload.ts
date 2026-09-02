import { useCallback, useState } from 'react';

import { useUploadFile } from '@/hooks/useUploadFile';
import { nextRowId } from '@/inventory/registry/form-model';
import {
  suggestMarkerFromFilename,
  urlFromUploadTags,
  type UploadEntry,
} from '@/inventory/registry/image-upload';

export interface ItemImageUploadApi {
  entries: UploadEntry[];
  /** Queue files with suggested markers. Uploads nothing yet. */
  addFiles: (files: readonly File[]) => void;
  setMarker: (id: string, marker: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** Upload every queued file; resolves with the rows that succeeded. */
  uploadAll: () => Promise<{ url: string; marker: string }[]>;
  isUploading: boolean;
}

/**
 * A Blossom upload queue for item artwork.
 *
 * Files upload sequentially rather than in parallel. Each upload signs a
 * Blossom authorization, and a NIP-07 extension or a remote bunker prompting
 * for five signatures at once is a worse experience than five in a row — and on
 * some signers it simply fails.
 *
 * Finishing an upload does exactly one thing: it produces a URL. It never
 * signs an item definition, never publishes, and never touches the rest of the
 * form on its own.
 */
export function useItemImageUpload(): ItemImageUploadApi {
  const { mutateAsync: uploadFile } = useUploadFile();
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const addFiles = useCallback((files: readonly File[]) => {
    setEntries((previous) => [
      ...previous,
      ...files.map((file) => ({
        id: nextRowId('upload'),
        file,
        filename: file.name,
        marker: suggestMarkerFromFilename(file.name),
        status: 'queued' as const,
      })),
    ]);
  }, []);

  const setMarker = useCallback((id: string, marker: string) => {
    setEntries((previous) => previous.map((entry) => (entry.id === id ? { ...entry, marker } : entry)));
  }, []);

  const remove = useCallback((id: string) => {
    setEntries((previous) => previous.filter((entry) => entry.id !== id));
  }, []);

  const clear = useCallback(() => setEntries([]), []);

  const uploadAll = useCallback(async () => {
    const pending = entries.filter((entry) => entry.status === 'queued' || entry.status === 'error');
    if (pending.length === 0) return [];

    setIsUploading(true);
    const uploaded: { url: string; marker: string }[] = [];

    try {
      for (const entry of pending) {
        setEntries((previous) =>
          previous.map((e) => (e.id === entry.id ? { ...e, status: 'uploading', error: undefined } : e))
        );
        try {
          const url = urlFromUploadTags(await uploadFile(entry.file));
          if (!url) throw new Error('The upload returned no URL.');
          uploaded.push({ url, marker: entry.marker });
          setEntries((previous) => previous.map((e) => (e.id === entry.id ? { ...e, status: 'done', url } : e)));
        } catch (error) {
          setEntries((previous) =>
            previous.map((e) => (e.id === entry.id ? { ...e, status: 'error', error: (error as Error).message } : e))
          );
        }
      }
    } finally {
      setIsUploading(false);
    }

    return uploaded;
  }, [entries, uploadFile]);

  return { entries, addFiles, setMarker, remove, clear, uploadAll, isUploading };
}
