import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FARM_OFFICIAL_ISSUER_PUBKEY } from '@/inventory/constants';
import { blankItemForm, nextRowId, PRIMARY_MARKER } from '@/inventory/registry/form-model';
import { formToUnsignedEvent } from '@/inventory/registry/form-event';

/** Everything the signer was asked to sign, in call order. */
const signed: { kind: number; content: string; tags: string[][]; created_at: number }[] = [];
const publishedTo: string[] = [];
let relayShouldFail = false;

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: {
      pubkey: FARM_OFFICIAL_ISSUER_PUBKEY,
      signer: {
        signEvent: async (template: { kind: number; content: string; tags: string[][]; created_at: number }) => {
          signed.push(structuredClone(template));
          return { ...template, id: 'a'.repeat(64), pubkey: FARM_OFFICIAL_ISSUER_PUBKEY, sig: 'b'.repeat(128) };
        },
      },
    },
  }),
}));

vi.mock('@nostrify/react', () => ({
  useNostr: () => ({
    nostr: {
      relay: (url: string) => ({
        event: async () => {
          if (relayShouldFail) throw new Error('refused');
          publishedTo.push(url);
        },
      }),
    },
  }),
}));

const { usePublishItemDefinition } = await import('./usePublishItemDefinition');

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function carrotTemplate() {
  const built = formToUnsignedEvent({
    ...blankItemForm(),
    d: 'farm:produce:carrot',
    name: 'Carrot',
    type: 'consumable',
    category: 'food',
    images: [{ id: nextRowId('image'), url: 'https://blossom.primal.net/carrot.png', marker: PRIMARY_MARKER }],
    topics: ['edible', 'vegetable'],
  });
  if (!built.ok) throw new Error(built.error);
  return built.value;
}

afterEach(() => {
  signed.length = 0;
  publishedTo.length = 0;
  relayShouldFail = false;
});

describe('the reviewed template is the signed event', () => {
  it('signs exactly the kind, content and tags that were reviewed', async () => {
    // This is the object the review dialog renders.
    const reviewed = carrotTemplate();
    const reviewedSnapshot = structuredClone(reviewed);

    const { result } = renderHook(() => usePublishItemDefinition(), { wrapper });
    await result.current.mutateAsync({ template: reviewed });

    await waitFor(() => expect(signed).toHaveLength(1));

    expect(signed[0].kind).toBe(reviewedSnapshot.kind);
    expect(signed[0].content).toBe(reviewedSnapshot.content);
    expect(signed[0].tags).toEqual(reviewedSnapshot.tags);
  });

  it('adds no tag the review did not show', async () => {
    const reviewed = carrotTemplate();
    const reviewedNames = reviewed.tags.map(([name]) => name).sort();

    const { result } = renderHook(() => usePublishItemDefinition(), { wrapper });
    await result.current.mutateAsync({ template: reviewed });

    expect(signed[0].tags.map(([name]) => name).sort()).toEqual(reviewedNames);
  });

  it('carries the client tag because the TEMPLATE has it, not the publisher', async () => {
    const reviewed = carrotTemplate();
    expect(reviewed.tags).toContainEqual(['client', 'nostr-farm']);

    const { result } = renderHook(() => usePublishItemDefinition(), { wrapper });
    await result.current.mutateAsync({ template: reviewed });

    expect(signed[0].tags.filter(([name]) => name === 'client')).toEqual([['client', 'nostr-farm']]);
  });

  it('does not mutate the reviewed template object', async () => {
    const reviewed = carrotTemplate();
    const before = structuredClone(reviewed);

    const { result } = renderHook(() => usePublishItemDefinition(), { wrapper });
    await result.current.mutateAsync({ template: reviewed });

    expect(reviewed).toEqual(before);
  });

  it('reports each relay individually and fails loudly when none accepted', async () => {
    relayShouldFail = true;
    const { result } = renderHook(() => usePublishItemDefinition(), { wrapper });
    const published = await result.current.mutateAsync({ template: carrotTemplate() });

    expect(published.reachedAnyRelay).toBe(false);
    expect(published.acceptedRelays).toEqual([]);
    expect(published.rejectedRelays.length).toBeGreaterThan(0);
  });
});
