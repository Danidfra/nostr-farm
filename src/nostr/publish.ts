import type { NostrEvent, NPool } from '@nostrify/nostrify';

import { summarizeDelivery, type DeliveryResult } from '@/lib/relay-routing';
import { deliveryFromError } from './relay-sync';
import { PRIMARY_RELAY_URL, type RelayConfig } from './relays';

/**
 * Result of publishing to relays
 */
export interface PublishResult {
  /** Whether publishing succeeded (at least one required relay succeeded) */
  success: boolean;
  /** List of relay URLs that succeeded */
  succeeded: string[];
  /** List of relays that failed with error details */
  failed: Array<{ relay: string; error: unknown }>;
  /** What each destination said, one entry per relay, in the order given. */
  deliveries: DeliveryResult[];
  /** The event is held elsewhere and the primary relay gave no verdict; it will be offered again. */
  primaryPending: boolean;
  /** The event is held elsewhere and the primary relay refused it (for instance, a write list). */
  primaryRejected: boolean;
}

/** How long a relay that is not required may keep a successful publish waiting. */
export const OPTIONAL_RELAY_GRACE_MS = 1500;

export interface PublishOptions {
  /** Timeout per relay in milliseconds (default: 5000). */
  timeout?: number;
  /**
   * Called once per relay with its verdict, as soon as it is known. A relay
   * that is not required and answers after the publish has already returned
   * still reports here, which is how its late verdict reaches the ledger.
   */
  onDelivery?: (event: NostrEvent, result: DeliveryResult) => void;
}

/**
 * Publish error with detailed relay information
 */
export class PublishError extends Error {
  constructor(
    message: string,
    public result: PublishResult
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

/**
 * Publish a signed event to multiple relays with structured error handling
 *
 * Strategy:
 * - Publishes the same signed event to all relays in parallel
 * - Tracks the verdict of each relay
 * - Requires at least one "required" relay to succeed
 * - Does not make the player wait for a relay that is not required: once a
 *   required relay has accepted and every required relay has answered, the
 *   others get `OPTIONAL_RELAY_GRACE_MS` more and are then reported as
 *   pending (`retry`). Their real verdict still arrives through `onDelivery`.
 *
 * A primary relay that refuses the event or does not answer therefore never
 * fails the action: the result says `primaryRejected` or `primaryPending`.
 *
 * @param nostr - NPool instance from useNostr()
 * @param event - Signed Nostr event
 * @param relays - List of relay configurations
 * @param options - Per-relay timeout, and a listener for each relay's verdict
 * @returns PublishResult with success status and relay details
 * @throws PublishError if all required relays fail
 */
export async function publishToRelays(
  nostr: NPool,
  event: NostrEvent,
  relays: readonly RelayConfig[],
  options: number | PublishOptions = {}
): Promise<PublishResult> {
  const { timeout = 5000, onDelivery } = typeof options === 'number' ? { timeout: options } : options;

  if (relays.length === 0) {
    throw new PublishError('No relays configured for publishing', {
      success: false,
      succeeded: [],
      failed: [],
      deliveries: [],
      primaryPending: false,
      primaryRejected: false,
    });
  }

  const settled = new Map<string, { delivery: DeliveryResult; error?: unknown }>();
  let wake: (() => void) | undefined;

  // Publish to all relays in parallel
  const attempts = relays.map(async (relayConfig) => {
    let outcome: { delivery: DeliveryResult; error?: unknown };
    try {
      const relay = nostr.relay(relayConfig.url);
      await relay.event(event, { signal: AbortSignal.timeout(timeout) });
      outcome = { delivery: { relay: relayConfig.url, verdict: 'accepted' } };
    } catch (error) {
      // Log detailed error in development
      if (process.env.NODE_ENV === 'development') {
        console.debug(`[publishToRelays] Failed to publish to ${relayConfig.url}:`, error);
      }
      outcome = { delivery: deliveryFromError(relayConfig.url, error), error };
    }
    settled.set(relayConfig.url, outcome);
    onDelivery?.(event, outcome.delivery);
    wake?.();
  });

  const requiredRelays = relays.filter((r) => r.required);
  const accepted = (url: string) => settled.get(url)?.delivery.verdict === 'accepted';
  const requiredDone = () =>
    requiredRelays.length > 0 && requiredRelays.every((r) => settled.has(r.url)) && requiredRelays.some((r) => accepted(r.url));

  // Wait for every relay, or, once the required ones have accepted, a short
  // while longer for the rest.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let graceOver = false;
  while (settled.size < relays.length && !graceOver) {
    // Every required relay has answered and none accepted: the publish has failed, whatever the others say later.
    if (requiredRelays.length > 0 && requiredRelays.every((r) => settled.has(r.url)) && !requiredRelays.some((r) => accepted(r.url))) break;
    if (requiredDone() && graceTimer === undefined) {
      graceTimer = setTimeout(() => {
        graceOver = true;
        wake?.();
      }, OPTIONAL_RELAY_GRACE_MS);
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  clearTimeout(graceTimer);
  wake = undefined;
  void Promise.allSettled(attempts);

  // Aggregate results
  const succeeded: string[] = [];
  const failed: Array<{ relay: string; error: unknown }> = [];
  const deliveries: DeliveryResult[] = [];

  for (const relayConfig of relays) {
    const outcome = settled.get(relayConfig.url);
    if (!outcome) {
      // Not required and still silent: not a failure, not yet a success.
      deliveries.push({ relay: relayConfig.url, verdict: 'retry', message: 'no answer yet' });
      continue;
    }
    deliveries.push(outcome.delivery);
    if (outcome.delivery.verdict === 'accepted') succeeded.push(relayConfig.url);
    else failed.push({ relay: relayConfig.url, error: outcome.error });
  }

  // Check if at least one required relay succeeded
  const requiredSucceeded = requiredRelays.filter((r) => succeeded.includes(r.url));

  const success = requiredRelays.length === 0 || requiredSucceeded.length > 0;
  const summary = summarizeDelivery(deliveries, PRIMARY_RELAY_URL);

  const publishResult: PublishResult = {
    success,
    succeeded,
    failed,
    deliveries,
    primaryPending: success && summary.primaryPending,
    primaryRejected: success && summary.primaryRejected,
  };

  // Log results in development
  if (process.env.NODE_ENV === 'development') {
    console.debug('[publishToRelays]', {
      event: { kind: event.kind, id: event.id },
      succeeded: succeeded.length,
      failed: failed.length,
      requiredSucceeded: requiredSucceeded.length,
      requiredTotal: requiredRelays.length,
      primaryPending: publishResult.primaryPending,
      primaryRejected: publishResult.primaryRejected,
    });
  }

  // Throw only if all required relays failed
  if (!success) {
    const errorMessage = `Failed to publish to required relays. ${failed.length} relay(s) failed.`;
    const detailedErrors = failed.map((f) => `${f.relay}: ${f.error}`).join(', ');

    throw new PublishError(
      `${errorMessage} Details: ${detailedErrors}`,
      publishResult
    );
  }

  // Log warnings for non-required relay failures
  if (failed.length > 0 && process.env.NODE_ENV === 'development') {
    console.warn(
      `[publishToRelays] Some relays failed (non-critical):`,
      failed.map((f) => f.relay)
    );
  }

  return publishResult;
}
