import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Filenames that should fail, so a partial batch can be simulated. */
const failing = new Set<string>();
/** Filenames whose upload "succeeds" but returns no usable url tag. */
const withoutUrl = new Set<string>();
const uploadCalls: string[] = [];

vi.mock('@/hooks/useUploadFile', () => ({
  useUploadFile: () => ({
    mutateAsync: async (file: File) => {
      uploadCalls.push(file.name);
      if (failing.has(file.name)) throw new Error('blossom said no');
      if (withoutUrl.has(file.name)) return [['x', '9f8e7d6c5b4a'], ['size', '1024']];
      return [['url', `https://blossom.primal.net/${file.name}`]];
    },
  }),
}));

const { useItemImageUpload } = await import('./useItemImageUpload');

const file = (name: string) => new File(['x'], name, { type: 'image/png' });

afterEach(() => {
  failing.clear();
  withoutUrl.clear();
  uploadCalls.length = 0;
});

describe('partial upload success', () => {
  it('applies what succeeded and keeps what failed', async () => {
    failing.add('carrot-back.png');
    const { result } = renderHook(() => useItemImageUpload());

    act(() => {
      result.current.addFiles([
        file('carrot-front.png'),
        file('carrot-side-right.png'),
        file('carrot-back.png'),
        file('carrot-side-left.png'),
      ]);
    });

    let uploaded: { url: string; marker: string }[] = [];
    await act(async () => {
      uploaded = await result.current.uploadAll();
    });

    expect(uploaded.map((entry) => entry.marker).sort()).toEqual(['front', 'side-left', 'side-right']);

    await waitFor(() => {
      expect(result.current.entries.filter((entry) => entry.status === 'done')).toHaveLength(3);
      expect(result.current.entries.filter((entry) => entry.status === 'error')).toHaveLength(1);
    });

    const failed = result.current.entries.find((entry) => entry.status === 'error');
    expect(failed?.filename).toBe('carrot-back.png');
    expect(failed?.error).toContain('blossom said no');
    expect(result.current.hasFailures).toBe(true);
  });

  it('keeps the failed entry after the successful ones are cleared', async () => {
    failing.add('carrot-back.png');
    const { result } = renderHook(() => useItemImageUpload());

    act(() => result.current.addFiles([file('carrot-front.png'), file('carrot-back.png')]));
    await act(async () => {
      await result.current.uploadAll();
    });

    // This is what the ImageManager does once it has applied the URLs.
    act(() => result.current.removeCompleted());

    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.entries[0].filename).toBe('carrot-back.png');
    expect(result.current.entries[0].status).toBe('error');
  });
});

describe('retry', () => {
  it('retries only the failure and does not re-upload what already succeeded', async () => {
    failing.add('carrot-back.png');
    const { result } = renderHook(() => useItemImageUpload());

    act(() => result.current.addFiles([file('carrot-front.png'), file('carrot-back.png')]));
    await act(async () => {
      await result.current.uploadAll();
    });
    expect(uploadCalls).toEqual(['carrot-front.png', 'carrot-back.png']);

    // The failure now succeeds.
    failing.clear();
    uploadCalls.length = 0;

    let retried: { url: string; marker: string }[] = [];
    await act(async () => {
      retried = await result.current.uploadAll();
    });

    // Only the previously failed file was attempted again.
    expect(uploadCalls).toEqual(['carrot-back.png']);
    expect(retried).toEqual([{ url: 'https://blossom.primal.net/carrot-back.png', marker: 'back' }]);
  });

  it('does not re-apply an image that already landed', async () => {
    const { result } = renderHook(() => useItemImageUpload());

    act(() => result.current.addFiles([file('carrot.png')]));
    await act(async () => {
      await result.current.uploadAll();
    });

    let second: { url: string; marker: string }[] = [];
    await act(async () => {
      second = await result.current.uploadAll();
    });

    expect(second).toEqual([]);
    expect(uploadCalls).toEqual(['carrot.png']);
  });

  it('treats a result with no usable url tag as a failure, not as an image', async () => {
    // The uploader answers with only a hash and a size. The old lenient
    // extractor would have turned the hash into an image URL.
    withoutUrl.add('carrot.png');
    const { result } = renderHook(() => useItemImageUpload());

    act(() => result.current.addFiles([file('carrot.png')]));

    let uploaded: { url: string; marker: string }[] = [];
    await act(async () => {
      uploaded = await result.current.uploadAll();
    });

    expect(uploaded).toEqual([]);
    await waitFor(() => expect(result.current.entries[0].status).toBe('error'));
    expect(result.current.entries[0].error).toContain('no URL');
    // And it stays retryable.
    expect(result.current.hasFailures).toBe(true);
  });
});

describe('queue housekeeping', () => {
  it('clear removes everything, removeCompleted removes only successes', async () => {
    failing.add('b.png');
    const { result } = renderHook(() => useItemImageUpload());

    act(() => result.current.addFiles([file('a.png'), file('b.png')]));
    await act(async () => {
      await result.current.uploadAll();
    });

    act(() => result.current.removeCompleted());
    expect(result.current.entries).toHaveLength(1);

    act(() => result.current.clear());
    expect(result.current.entries).toHaveLength(0);
    expect(result.current.hasFailures).toBe(false);
    expect(result.current.hasPending).toBe(false);
  });
});
