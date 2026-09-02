/**
 * Where the app config (including the theme) is persisted.
 *
 * Its own module so `main.tsx` can apply the stored theme before importing the
 * React tree, without dragging providers into the startup path.
 */
export const APP_CONFIG_STORAGE_KEY = 'nostr-worlds:app-config';
