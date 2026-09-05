/**
 * The secret-key backup file a new account downloads.
 *
 * The name says what the file is (a Nostr key backup), where it came from
 * and, through a short npub suffix, which account it is for, without putting
 * anything secret in the name. The same `<app>-nostr-key-backup-<npub>.txt`
 * shape is used by the other games in this ecosystem, so a tester's backups
 * sort together and are recognisable at a glance.
 *
 * The CONTENT is the bare `nsec1…` string and nothing else: it is exactly what
 * the login dialog's file upload expects back, and there is nothing else a
 * backup should carry.
 */
import { getPublicKey, nip19 } from 'nostr-tools';

export const NSEC_BACKUP_MIME = 'text/plain; charset=utf-8';

const FILENAME_PREFIX = 'nostr-farm-nostr-key-backup';

/**
 * `nostr-farm-nostr-key-backup-<8 npub chars>.txt` for a valid nsec.
 *
 * Throws on anything that is not an nsec, so a caller cannot download a file
 * whose name promises a key it does not contain.
 */
export function nsecBackupFilename(nsec: string): string {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== 'nsec') throw new Error('Not an nsec');
  const npub = nip19.npubEncode(getPublicKey(decoded.data));
  return `${FILENAME_PREFIX}-${npub.slice(5, 13)}.txt`;
}
