import type { Theme } from '@/contexts/AppContext';

/**
 * Theme resolution and application.
 *
 * Tailwind is configured with `darkMode: ["class"]`, so the whole app —
 * pages, cards, dialogs, forms — follows a single class on `<html>`. Nothing
 * needs per-component dark handling beyond the tokens already in `index.css`.
 */

export const THEMES: readonly Theme[] = ['light', 'dark', 'system'] as const;

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** The concrete appearance a theme setting resolves to. */
export type ResolvedTheme = 'light' | 'dark';

export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
}

/** Put exactly one of `light`/`dark` on the root element. */
export function applyThemeClass(root: Element, resolved: ResolvedTheme): void {
  root.classList.remove('light', 'dark');
  root.classList.add(resolved);
}

/** Does the environment currently prefer a dark appearance? */
export function prefersDarkNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

/**
 * Read the persisted theme out of the app config blob written by
 * `AppProvider`, without pulling React in.
 *
 * Used by {@link applyStoredTheme} at startup. Returns `null` when there is no
 * stored preference, the value is unusable, or storage is unavailable.
 */
export function readStoredTheme(storageKey: string): Theme | null {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const theme = (parsed as { theme?: unknown }).theme;
    return isTheme(theme) ? theme : null;
  } catch {
    return null;
  }
}

/**
 * Apply the stored theme before React renders.
 *
 * This SPA has no server-rendered HTML, so there is no hydration mismatch to
 * worry about — but there is still a flash: the document paints with whatever
 * the stylesheet defaults to, then React mounts and an effect switches the
 * class. Running this synchronously from `main.tsx`, before `createRoot`,
 * removes that gap. It cannot be an inline `<script>` in index.html because the
 * page's CSP is `script-src 'self'`.
 *
 * `AppProvider` remains the source of truth once mounted; this only sets the
 * initial class.
 */
export function applyStoredTheme(storageKey: string, fallback: Theme = 'system'): ResolvedTheme {
  const theme = readStoredTheme(storageKey) ?? fallback;
  const resolved = resolveTheme(theme, prefersDarkNow());
  if (typeof document !== 'undefined') applyThemeClass(document.documentElement, resolved);
  return resolved;
}
