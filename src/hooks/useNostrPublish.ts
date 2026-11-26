import { useNostr } from "@nostrify/react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { useCurrentUser } from "./useCurrentUser";
import { publishToRelays } from "@/nostr/publish";
import { GAME_RELAYS } from "@/nostr/relays";
import { relaySync } from "@/nostr/relay-sync";
import { replaceableAddress, stampReplaceable } from "@/nostr/created-at";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * What to publish. `replaces` is the event this write replaces, as the caller
 * last read it from the relays; it is never signed or sent.
 */
export type PublishTemplate = Partial<Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>> & {
  replaces?: Pick<NostrEvent, 'created_at'>;
};

export function useNostrPublish(): UseMutationResult<NostrEvent, Error, PublishTemplate> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: async (t: PublishTemplate) => {
      if (!user) {
        throw new Error("User is not logged in");
      }

      const tags = t.tags ?? [];

      // Add the client tag if it doesn't exist
      if (location.protocol === "https:" && !tags.some(([name]) => name === "client")) {
        tags.push(["client", location.hostname]);
      }

      // Harden created_at timestamp
      const now = Math.floor(Date.now() / 1000);
      const providedTimestamp = t.created_at;
      let finalTimestamp = providedTimestamp ?? now;

      // A replaceable or addressable write without an explicit timestamp is
      // stamped strictly after the event it replaces, within a bounded skew
      // (see src/nostr/created-at.ts), so a second write in the same second
      // still wins on the relays.
      const address = providedTimestamp === undefined ? replaceableAddress(t.kind!, user.pubkey, tags) : undefined;
      if (address !== undefined) {
        const stamp = stampReplaceable(address, t.replaces?.created_at, now);
        finalTimestamp = stamp.createdAt;
        if (stamp.previousAhead && process.env.NODE_ENV === 'development') {
          console.warn('[useNostrPublish] The replaced event is dated too far ahead to follow; it keeps winning until its time has passed.', {
            address,
            previous: t.replaces?.created_at,
            now,
          });
        }
      }

      // Clamp timestamps that are more than 5 minutes in the future
      const maxFutureOffset = 5 * 60; // 5 minutes in seconds
      if (finalTimestamp > now + maxFutureOffset) {
        if (process.env.NODE_ENV === 'development') {
          console.warn('[useNostrPublish] Timestamp clamping:', {
            provided: providedTimestamp,
            now,
            diff: finalTimestamp - now,
            clamped: now,
            reason: 'Timestamp was more than 5 minutes in the future',
          });
        }
        finalTimestamp = now;
      }

      // Development logging for timestamp debugging
      if (process.env.NODE_ENV === 'development' && providedTimestamp !== undefined) {
        console.debug('[useNostrPublish] Timestamp validation:', {
          original: providedTimestamp,
          final: finalTimestamp,
          now,
          delta: finalTimestamp - now,
        });
      }

      // Sign the event once with validated timestamp
      const event = await user.signer.signEvent({
        kind: t.kind!,
        content: t.content ?? "",
        tags,
        created_at: finalTimestamp,
      });

      // Publish to configured relays with detailed error handling. Each
      // relay's verdict goes to the sync ledger as it arrives, including a
      // primary relay that answers after this call has already returned.
      const publishResult = await publishToRelays(nostr, event, GAME_RELAYS, {
        onDelivery: (published, result) => relaySync.recordDeliveries(published, [result]),
      });

      // Store publish metadata for logging (but return event for backward compatibility)
      if (process.env.NODE_ENV === 'development') {
        console.debug('[useNostrPublish] Publish result:', {
          eventId: event.id,
          kind: event.kind,
          publishResult,
        });
      }

      return event;
    },
    onError: (error) => {
      // Enhanced error logging with relay details
      console.error("Failed to publish event:", error);
    },
    onSuccess: (event) => {
      if (process.env.NODE_ENV === 'development') {
        console.debug('[useNostrPublish] published', { kind: event.kind, id: event.id });
      }
    },
  });
}