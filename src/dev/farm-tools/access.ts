import { DEV_TOOLS_ENABLED } from '@/dev/enabled';
import { FARM_OFFICIAL_ISSUER_PUBKEY } from '@/inventory/constants';
import { useCurrentUser } from '@/hooks/useCurrentUser';

/**
 * Who may use the live developer tools on the field.
 *
 * The one identity the repository already treats as "the Farm": the official
 * item issuer. It is a public key, fixed in source, and no secret for it exists
 * anywhere in this application. To hand the tools to a different developer
 * identity, change this one line; nothing else knows the key.
 */
export const DEV_FARM_TOOLS_PUBKEY: string = FARM_OFFICIAL_ISSUER_PUBKEY;

export interface DevFarmToolsAccessInput {
  /** The build-time literal: `DEV_TOOLS_ENABLED`. */
  enabled: boolean;
  /** The signed-in user's hex public key, or `undefined` when logged out. */
  pubkey: string | undefined;
}

/**
 * The tools are available when, and only when, the build opted in AND the
 * signed-in public key is the authorized one.
 *
 * NOT A SECURITY BOUNDARY. This is a client-side convenience gate: it decides
 * whether a panel renders and whether a hook agrees to sign. Every event it
 * can publish is a normal, owner-signed Farm event the same user could publish
 * by other means, and nothing server-side trusts this check. What it
 * guarantees is narrower: no private key or secret in source, no tool in a
 * default production build, and no panel for anybody but the authorized key.
 */
export function canUseDevFarmTools({ enabled, pubkey }: DevFarmToolsAccessInput): boolean {
  if (!enabled) return false;
  if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey)) return false;
  return pubkey.toLowerCase() === DEV_FARM_TOOLS_PUBKEY;
}

/** The gate as the app sees it: this build, this session. */
export function useDevFarmToolsAccess(): boolean {
  const { user } = useCurrentUser();
  return canUseDevFarmTools({ enabled: DEV_TOOLS_ENABLED, pubkey: user?.pubkey });
}
