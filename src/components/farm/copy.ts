/**
 * Player-facing words, in one place.
 *
 * Everything a player reads that is not data lives here, so the tone can be
 * kept consistent and the protocol vocabulary (relays, kinds, snapshots,
 * settlement) stays out of the game unless a player opens a "how it works"
 * disclosure on purpose.
 */

/** Why an action was refused, keyed by the domain's stable reason codes. */
export const ACTION_REJECTION_MESSAGES: Record<string, string> = {
  unknown_action: 'That action does not exist.',
  unknown_crop: 'That crop is not in the catalog.',
  slot_occupied: 'Something is already growing here.',
  slot_empty: 'There is nothing planted here.',
  plant_rotten: 'This crop has rotted. Clear it first.',
  plant_not_rotten: 'This crop is still alive.',
  not_ready: 'This crop is not ready to harvest yet.',
  already_saturated: 'This crop is already as wet as it can get.',
};

export const APP_NAME = 'Nostr Farm';

export const WELCOME = {
  eyebrow: 'A cozy farming game on Nostr',
  title: 'Grow a little farm that is truly yours.',
  description:
    'Plant, water and harvest. Your farm is saved to your Nostr identity, so it is yours on any device, and other Nostr games can use what you grow.',
  points: [
    { title: 'Plant, water, harvest', text: 'Crops grow while they are wet and rot if you forget them.' },
    { title: 'Yours by key', text: 'No account with us. Your farm belongs to your Nostr key.' },
    { title: 'Produce travels', text: 'What you harvest can be used in other Nostr games.' },
  ],
  howTitle: 'How does it work?',
  how: 'Every action on your farm is a signed Nostr event on public relays. Any app that reads the same format can see your farm and your produce, and nothing here needs a server of ours.',
} as const;

export const CREATE_FARM = {
  title: 'Name your farm',
  description: 'Choose a name. It is shown above your field.',
  placeholder: 'My Farm',
  defaultName: 'My Farm',
  action: 'Start farming',
  busy: 'Preparing your field…',
  howTitle: 'What gets saved?',
  how: 'Two signed events on the game relay: your farm and its field. Crops are saved as you plant them.',
} as const;

export const LOADING = {
  field: 'Walking to your field…',
} as const;

export const ERRORS = {
  farmTitle: 'We could not reach your farm',
  farmMessage: 'The relay did not answer in time. Your farm is still there; try again in a moment.',
  artworkTitle: 'The farm artwork did not load',
  artworkMessage: 'The pictures for your field could not be fetched. Check your connection and try again.',
  retry: 'Try again',
  detailsTitle: 'Details',
} as const;

export const HUD = {
  tagline: 'A cozy farming game on Nostr',
  trayLabel: 'Your produce',
  loading: 'Checking your basket…',
  empty: 'Basket empty',
  emptyHint: 'Harvest a crop to fill it.',
  unresolved: 'Produce unavailable',
  unresolvedHint: 'Your produce records could not be verified right now, so no balance is shown. This usually clears on its own.',
  menuLabel: 'player menu',
  switchAccount: 'Switch account',
  addAccount: 'Add another account',
  itemRegistry: 'Item Registry',
  appearance: 'Appearance',
  about: 'About this farm',
  aboutDescription: 'The technical facts behind your field.',
  logOut: 'Log out',
  copyKey: 'Copy your public key',
  copied: 'Copied your public key',
  copyFailed: 'Could not copy',
} as const;

export const CLEAR_ROTTEN = {
  title: 'Clear this rotten crop?',
  description: 'The plot goes back to bare soil. There is nothing left to harvest from it.',
  cancel: 'Keep it',
  confirm: 'Clear the plot',
} as const;

export const HARVEST_TOAST = {
  description: 'Added to your basket.',
} as const;

export const PRODUCE_CHANGE = {
  usedElsewhere: 'Used in another Nostr game',
  usedIn: (client: string) => `Used in ${client}`,
  harvested: 'Harvested here',
  updated: 'Balance updated',
  updatedElsewhere: 'Balance updated elsewhere',
} as const;
