import { describe, expect, it } from 'vitest';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

import { FakeRelayNetwork } from '@/test/fake-relay';
import { FARM_OWNER, worldEvent } from '@/test/farm-fixtures';
import { KIND_WORLD_STATE } from './kinds';
import { describeReads, readFromRelays, readUntilEose, type ReqRelay } from './query';

const A = 'wss://a.example';
const B = 'wss://b.example';
const FILTER: NostrFilter = { kinds: [KIND_WORLD_STATE], authors: [FARM_OWNER], limit: 20 };

/** A relay scripted to emit exactly these messages, then end, or throw. */
function scripted(messages: (readonly [string, ...unknown[]])[], end: 'return' | Error = 'return'): ReqRelay {
  return {
    async *req(_filters, opts) {
      for (const message of messages) {
        if (opts?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        yield message;
      }
      if (end !== 'return') throw end;
    },
  };
}

describe('readUntilEose', () => {
  it('is complete only once the relay says EOSE, with the events that arrived', async () => {
    const event = worldEvent();
    const read = await readUntilEose(scripted([['EVENT', 'sub', event], ['EOSE', 'sub']]), A, [FILTER]);
    expect(read).toEqual({ relay: A, outcome: 'complete', events: [event] });
  });

  it('reports a CLOSED message as closed, keeping what came before it', async () => {
    const event = worldEvent();
    const read = await readUntilEose(scripted([['EVENT', 'sub', event], ['CLOSED', 'sub', 'auth-required: please']]), A, [FILTER]);
    expect(read.outcome).toBe('closed');
    expect(read.events).toEqual([event]);
    expect(read.error).toBe('auth-required: please');
  });

  it('reports a stream that ends without EOSE as closed, which is how Nostrify surfaces CLOSED', async () => {
    const read = await readUntilEose(scripted([]), A, [FILTER]);
    expect(read.outcome).toBe('closed');
    expect(read.events).toEqual([]);
  });

  it('reports an aborted read as a timeout', async () => {
    // A relay that, like Nostrify's, throws AbortError once its signal fires.
    const relay: ReqRelay = {
      async *req(_filters, opts) {
        yield* [] as (readonly [string, ...unknown[]])[];
        await new Promise<void>((resolve) => opts?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        throw new DOMException('The signal has been aborted', 'AbortError');
      },
    };
    const read = await readUntilEose(relay, A, [FILTER], AbortSignal.timeout(20));
    expect(read.outcome).toBe('timeout');
  });

  it('reports any other failure as an error, never by throwing', async () => {
    const read = await readUntilEose(scripted([], new Error('connection refused')), A, [FILTER]);
    expect(read.outcome).toBe('error');
    expect(read.error).toBe('connection refused');
  });
});

describe('readFromRelays', () => {
  it('merges relays, deduplicates by id, and is complete only when every relay said EOSE', async () => {
    const network = new FakeRelayNetwork();
    const event = worldEvent();
    network.seed(event);

    const read = await readFromRelays(network.pool, [A, B], [FILTER], { timeoutMs: 1000 });

    expect(read.events).toEqual([event]);
    expect(read.reads.map((r) => r.outcome)).toEqual(['complete', 'complete']);
    expect(read.allComplete).toBe(true);
    expect(read.anyComplete).toBe(true);
  });

  it('is partial when one relay closes before EOSE, even though the other finished', async () => {
    const network = new FakeRelayNetwork();
    network.closeBeforeEose(B);

    const read = await readFromRelays(network.pool, [A, B], [FILTER], { timeoutMs: 1000 });

    expect(read.reads.map((r) => r.outcome)).toEqual(['complete', 'closed']);
    expect(read.allComplete).toBe(false);
    expect(read.anyComplete).toBe(true);
  });

  it('times out a relay that never answers without losing the others', async () => {
    const network = new FakeRelayNetwork();
    const event = worldEvent();
    network.seed(event);
    network.silence(B);

    const read = await readFromRelays(network.pool, [A, B], [FILTER], { timeoutMs: 50 });

    expect(read.events).toEqual([event]);
    expect(read.reads.map((r) => r.outcome)).toEqual(['complete', 'timeout']);
    expect(read.allComplete).toBe(false);
  });

  it('treats a relay that throws as an error and not as empty', async () => {
    const network = new FakeRelayNetwork();
    network.failRelay(A);

    const read = await readFromRelays(network.pool, [A], [FILTER], { timeoutMs: 1000 });

    expect(read.reads[0].outcome).toBe('error');
    expect(read.allComplete).toBe(false);
    expect(read.anyComplete).toBe(false);
  });

  it('keeps an event one relay holds and the other withholds', async () => {
    const network = new FakeRelayNetwork();
    const event = worldEvent();
    network.seed(event);
    network.withhold(B, event.id);

    const read = await readFromRelays(network.pool, [A, B], [FILTER], { timeoutMs: 1000 });

    expect(read.events).toEqual([event]);
    expect(read.reads.find((r) => r.relay === B)?.events).toEqual([]);
    expect(read.allComplete).toBe(true);
  });

  it('describes every relay outcome on one line', () => {
    const line = describeReads([
      { relay: A, outcome: 'complete', events: [] as NostrEvent[] },
      { relay: B, outcome: 'closed', events: [], error: 'rate-limited' },
    ]);
    expect(line).toBe(`${A}: complete; ${B}: closed (rate-limited)`);
  });
});
