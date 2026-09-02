import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import type { NostrEvent } from '@nostrify/nostrify';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import {
  KIND_GAME_ITEM_DEFINITION,
  parseGameItemDefinitionResult,
  type UnsignedEventTemplate,
} from '@/inventory/package';
import { ITEM_REGISTRY_RELAYS } from '@/inventory/constants';
import { upsertDefinitionRecord, type ItemDefinitionRecord } from './useItemDefinitions';

export interface RelayPublishOutcome {
  relay: string;
  ok: boolean;
  error?: string;
}

export interface PublishItemDefinitionResult {
  /** The signed event, exactly as offered to the relays. */
  event: NostrEvent;
  record: ItemDefinitionRecord | null;
  outcomes: RelayPublishOutcome[];
  acceptedRelays: string[];
  rejectedRelays: RelayPublishOutcome[];
  /** True when at least one relay accepted the event. */
  reachedAnyRelay: boolean;
}

const PUBLISH_TIMEOUT_MS = 8000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sign a kind:31632 template with the connected signer and offer it to every
 * registry relay.
 *
 * This deliberately does not go through `useNostrPublish`: that helper writes
 * to the single configured game relay and reports success generously, which is
 * right for gameplay writes and wrong for an authoring tool whose whole job is
 * to tell you what actually reached the network. Here every relay's answer is
 * reported individually and a publication that reached nobody says so.
 *
 * There is no second signer: the signature comes from
 * `useCurrentUser().user.signer`, the same account object the rest of the app
 * uses. No key material is read, stored or passed around.
 *
 * The mutation is invoked from exactly one place — the explicit "Sign and
 * publish" button in the review dialog. It is never wired to a form change, a
 * blur, or the completion of an upload.
 */
export function usePublishItemDefinition() {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      template,
    }: {
      template: UnsignedEventTemplate<typeof KIND_GAME_ITEM_DEFINITION>;
    }): Promise<PublishItemDefinitionResult> => {
      if (!user?.signer) throw new Error('No signer is available. Sign in before publishing.');

      // The template is signed EXACTLY as reviewed. Nothing is appended,
      // removed or reordered here: the review dialog renders this same
      // kind/content/tags, and a publisher that quietly added a tag would make
      // that claim false. Tags the app wants on every event (`client`) are
      // added during template construction — see `CLIENT_TAG` in form-event.ts.
      let event: NostrEvent;
      try {
        event = await user.signer.signEvent({
          kind: template.kind,
          content: template.content,
          tags: template.tags.map((tag) => [...tag]),
          created_at: Math.floor(Date.now() / 1000),
        });
      } catch (error) {
        throw new Error(`Signing was rejected: ${describeError(error)}`);
      }

      const outcomes = await Promise.all(
        ITEM_REGISTRY_RELAYS.map(async (relay): Promise<RelayPublishOutcome> => {
          try {
            await nostr.relay(relay).event(event, { signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS) });
            return { relay, ok: true };
          } catch (error) {
            return { relay, ok: false, error: describeError(error) };
          }
        })
      );

      const acceptedRelays = outcomes.filter((o) => o.ok).map((o) => o.relay);
      const parsed = parseGameItemDefinitionResult(event, { mode: 'permissive' });

      return {
        event,
        record: parsed.ok
          ? {
              address: parsed.value.address,
              event,
              definition: parsed.value,
              warnings: parsed.warnings.map((w) => `${w.code}: ${w.message}`),
              relays: acceptedRelays,
            }
          : null,
        outcomes,
        acceptedRelays,
        rejectedRelays: outcomes.filter((o) => !o.ok),
        reachedAnyRelay: acceptedRelays.length > 0,
      };
    },

    onSuccess: (result) => {
      if (!result.record || !result.reachedAnyRelay) return;
      upsertDefinitionRecord(queryClient, result.record);
    },
  });
}
