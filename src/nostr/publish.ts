import type { NostrEvent, NPool } from '@nostrify/nostrify';
import type { RelayConfig } from './relays';

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
 * - Publishes to all relays in parallel
 * - Tracks success/failure for each relay
 * - Requires at least one "required" relay to succeed
 * - Returns detailed results for debugging
 * 
 * @param nostr - NPool instance from useNostr()
 * @param event - Signed Nostr event
 * @param relays - List of relay configurations
 * @param timeout - Timeout per relay in milliseconds (default: 5000)
 * @returns PublishResult with success status and relay details
 * @throws PublishError if all required relays fail
 */
export async function publishToRelays(
  nostr: NPool,
  event: NostrEvent,
  relays: readonly RelayConfig[],
  timeout: number = 5000
): Promise<PublishResult> {
  if (relays.length === 0) {
    throw new PublishError('No relays configured for publishing', {
      success: false,
      succeeded: [],
      failed: [],
    });
  }

  // Publish to all relays in parallel
  const results = await Promise.allSettled(
    relays.map(async (relayConfig) => {
      try {
        const relay = nostr.relay(relayConfig.url);
        await relay.event(event, { signal: AbortSignal.timeout(timeout) });
        return { relay: relayConfig.url, success: true as const };
      } catch (error) {
        // Log detailed error in development
        if (process.env.NODE_ENV === 'development') {
          console.debug(`[publishToRelays] Failed to publish to ${relayConfig.url}:`, error);
        }
        return { relay: relayConfig.url, success: false as const, error };
      }
    })
  );

  // Aggregate results
  const succeeded: string[] = [];
  const failed: Array<{ relay: string; error: unknown }> = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const relayConfig = relays[i];

    if (result.status === 'fulfilled') {
      if (result.value.success) {
        succeeded.push(result.value.relay);
      } else {
        failed.push({ relay: result.value.relay, error: result.value.error });
      }
    } else {
      // Promise was rejected
      failed.push({ relay: relayConfig.url, error: result.reason });
    }
  }

  // Check if at least one required relay succeeded
  const requiredRelays = relays.filter((r) => r.required);
  const requiredSucceeded = requiredRelays.filter((r) => succeeded.includes(r.url));

  const success = requiredRelays.length === 0 || requiredSucceeded.length > 0;

  const publishResult: PublishResult = {
    success,
    succeeded,
    failed,
  };

  // Log results in development
  if (process.env.NODE_ENV === 'development') {
    console.debug('[publishToRelays]', {
      event: { kind: event.kind, id: event.id },
      succeeded: succeeded.length,
      failed: failed.length,
      requiredSucceeded: requiredSucceeded.length,
      requiredTotal: requiredRelays.length,
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
