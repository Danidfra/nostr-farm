import { describe, expect, it, vi } from 'vitest';
import type { NostrEvent, NPool } from '@nostrify/nostrify';

import type { DeliveryResult } from '@/lib/relay-routing';
import { OPTIONAL_RELAY_GRACE_MS, PublishError, publishToRelays } from './publish';
import { GAME_RELAYS, PRIMARY_RELAY_URL, REQUIRED_GAME_RELAY_URLS } from './relays';

/** Publishing game state to the primary relay and the required one, against fake relays only. */
const PILOT_REFUSAL = 'blocked: this relay is in pilot mode; author is not on the write list';
const REQUIRED = REQUIRED_GAME_RELAY_URLS[0];

const EVENT: NostrEvent = {
  id: 'e'.repeat(64),
  kind: 31417,
  pubkey: 'a'.repeat(64),
  created_at: 1_700_000_000,
  content: '',
  sig: 'x'.repeat(128),
  tags: [['d', 'slot:farm.field:1:1']],
};

type Behaviour = 'accept' | 'never' | Error;

function pool(behaviour: Record<string, Behaviour>) {
  const received: { relay: string; event: NostrEvent }[] = [];
  const nostr = {
    relay: (url: string) => ({
      event: async (event: NostrEvent, opts?: { signal?: AbortSignal }) => {
        received.push({ relay: url, event });
        const how = behaviour[url] ?? 'accept';
        if (how === 'accept') return;
        if (how instanceof Error) throw how;
        await new Promise<void>((resolve) => opts?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        const timeout = new Error('The operation timed out');
        timeout.name = 'TimeoutError';
        throw timeout;
      },
    }),
  } as unknown as NPool;
  return { nostr, received };
}

describe('the relay table', () => {
  it('lists the primary relay first and does not make it required', () => {
    expect(GAME_RELAYS[0]).toMatchObject({ url: PRIMARY_RELAY_URL, primary: true });
    expect(GAME_RELAYS[0].required).toBeUndefined();
    expect(REQUIRED_GAME_RELAY_URLS).not.toContain(PRIMARY_RELAY_URL);
    expect(REQUIRED_GAME_RELAY_URLS.length).toBeGreaterThan(0);
  });
});

describe('publishToRelays', () => {
  it('sends the same signed event to every relay and reports each verdict', async () => {
    const { nostr, received } = pool({});
    const result = await publishToRelays(nostr, EVENT, GAME_RELAYS);

    expect(received.map((r) => r.relay)).toEqual(GAME_RELAYS.map((r) => r.url));
    expect(received.every((r) => r.event === EVENT)).toBe(true);
    expect(result.deliveries).toEqual(GAME_RELAYS.map((r) => ({ relay: r.url, verdict: 'accepted' })));
    expect(result).toMatchObject({ success: true, primaryPending: false, primaryRejected: false });
  });

  it('succeeds when the primary relay refuses the author and the required relay accepts', async () => {
    const { nostr } = pool({ [PRIMARY_RELAY_URL]: new Error(PILOT_REFUSAL) });
    const seen: DeliveryResult[] = [];
    const result = await publishToRelays(nostr, EVENT, GAME_RELAYS, { onDelivery: (_event, delivery) => seen.push(delivery) });

    expect(result.success).toBe(true);
    expect(result.succeeded).toEqual([REQUIRED]);
    expect(result.primaryRejected).toBe(true);
    expect(result.primaryPending).toBe(false);
    expect(seen).toContainEqual({ relay: PRIMARY_RELAY_URL, verdict: 'rejected', message: PILOT_REFUSAL });
  });

  it('degrades an event the primary relay finds too large to "held by the others", not to a failure', async () => {
    const { nostr } = pool({ [PRIMARY_RELAY_URL]: new Error('invalid: event too large') });
    const result = await publishToRelays(nostr, EVENT, GAME_RELAYS);

    expect(result).toMatchObject({ success: true, primaryRejected: true });
  });

  it('does not keep the player waiting for a primary relay that is not answering', async () => {
    vi.useFakeTimers();
    try {
      const { nostr } = pool({ [PRIMARY_RELAY_URL]: 'never' });
      const seen: DeliveryResult[] = [];
      const publishing = publishToRelays(nostr, EVENT, GAME_RELAYS, { timeout: 5000, onDelivery: (_event, delivery) => seen.push(delivery) });

      await vi.advanceTimersByTimeAsync(OPTIONAL_RELAY_GRACE_MS + 1);
      const result = await publishing;

      expect(result.success).toBe(true);
      expect(result.primaryPending).toBe(true);
      expect(result.deliveries[0]).toMatchObject({ relay: PRIMARY_RELAY_URL, verdict: 'retry' });
      // Its real verdict still arrives, later, for the ledger.
      expect(seen.map((d) => d.relay)).toEqual([REQUIRED]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(seen).toContainEqual(expect.objectContaining({ relay: PRIMARY_RELAY_URL, verdict: 'retry' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('still fails when the required relay refuses, even though the primary relay accepted', async () => {
    const { nostr } = pool({ [REQUIRED]: new Error('rate-limited: slow down') });

    const error = await publishToRelays(nostr, EVENT, GAME_RELAYS).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PublishError);
    expect((error as PublishError).result).toMatchObject({ success: false, succeeded: [PRIMARY_RELAY_URL] });
    expect((error as PublishError).result.primaryPending).toBe(false);
  });
});
