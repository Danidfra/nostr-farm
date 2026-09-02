import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_CONFIG_STORAGE_KEY } from './theme-storage';
import {
  THEMES,
  applyStoredTheme,
  applyThemeClass,
  isTheme,
  prefersDarkNow,
  readStoredTheme,
  resolveTheme,
} from './theme';

/** Point `matchMedia` at a fixed OS preference. */
function setSystemPrefersDark(prefersDark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: prefersDark && query.includes('dark'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }))
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('light', 'dark');
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('theme values', () => {
  it('offers light, dark and system', () => {
    expect(THEMES).toEqual(['light', 'dark', 'system']);
  });

  it('recognises only valid themes', () => {
    for (const theme of THEMES) expect(isTheme(theme)).toBe(true);
    expect(isTheme('sepia')).toBe(false);
    expect(isTheme(undefined)).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(1)).toBe(false);
  });
});

describe('resolveTheme', () => {
  it('honours an explicit choice regardless of the OS', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('follows the OS in system mode', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('applyThemeClass', () => {
  it('adds the dark class and removes light', () => {
    const root = document.documentElement;
    root.classList.add('light');

    applyThemeClass(root, 'dark');
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.classList.contains('light')).toBe(false);
  });

  it('adds the light class and removes dark', () => {
    const root = document.documentElement;
    root.classList.add('dark');

    applyThemeClass(root, 'light');
    expect(root.classList.contains('light')).toBe(true);
    expect(root.classList.contains('dark')).toBe(false);
  });

  it('never leaves both classes on at once, however often it runs', () => {
    const root = document.documentElement;
    for (const resolved of ['dark', 'light', 'dark', 'dark'] as const) applyThemeClass(root, resolved);

    expect(root.classList.contains('dark')).toBe(true);
    expect(root.classList.contains('light')).toBe(false);
  });

  it('leaves unrelated classes alone', () => {
    const root = document.documentElement;
    root.classList.add('something-else');

    applyThemeClass(root, 'dark');
    expect(root.classList.contains('something-else')).toBe(true);
  });
});

describe('reading the persisted choice', () => {
  it('reads the theme out of the app config blob', () => {
    localStorage.setItem(APP_CONFIG_STORAGE_KEY, JSON.stringify({ theme: 'dark' }));
    expect(readStoredTheme(APP_CONFIG_STORAGE_KEY)).toBe('dark');
  });

  it('returns null when nothing is stored', () => {
    expect(readStoredTheme(APP_CONFIG_STORAGE_KEY)).toBeNull();
  });

  it('returns null for unusable stored data rather than throwing', () => {
    localStorage.setItem(APP_CONFIG_STORAGE_KEY, 'not json');
    expect(readStoredTheme(APP_CONFIG_STORAGE_KEY)).toBeNull();

    localStorage.setItem(APP_CONFIG_STORAGE_KEY, JSON.stringify({ theme: 'sepia' }));
    expect(readStoredTheme(APP_CONFIG_STORAGE_KEY)).toBeNull();

    localStorage.setItem(APP_CONFIG_STORAGE_KEY, JSON.stringify(['dark']));
    expect(readStoredTheme(APP_CONFIG_STORAGE_KEY)).toBeNull();
  });

  it('ignores other config keys', () => {
    localStorage.setItem(APP_CONFIG_STORAGE_KEY, JSON.stringify({ theme: 'light', relayMetadata: { relays: [] } }));
    expect(readStoredTheme(APP_CONFIG_STORAGE_KEY)).toBe('light');
  });
});

describe('applying the stored theme at startup', () => {
  it('applies a stored dark choice before anything renders', () => {
    setSystemPrefersDark(false);
    localStorage.setItem(APP_CONFIG_STORAGE_KEY, JSON.stringify({ theme: 'dark' }));

    expect(applyStoredTheme(APP_CONFIG_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('applies a stored light choice even when the OS prefers dark', () => {
    setSystemPrefersDark(true);
    localStorage.setItem(APP_CONFIG_STORAGE_KEY, JSON.stringify({ theme: 'light' }));

    expect(applyStoredTheme(APP_CONFIG_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('follows the OS when the stored choice is system', () => {
    setSystemPrefersDark(true);
    localStorage.setItem(APP_CONFIG_STORAGE_KEY, JSON.stringify({ theme: 'system' }));

    expect(applyStoredTheme(APP_CONFIG_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('defaults to system when nothing is stored', () => {
    setSystemPrefersDark(true);
    expect(applyStoredTheme(APP_CONFIG_STORAGE_KEY)).toBe('dark');

    setSystemPrefersDark(false);
    expect(applyStoredTheme(APP_CONFIG_STORAGE_KEY)).toBe('light');
  });

  it('survives an environment with no matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersDarkNow()).toBe(false);
    expect(() => applyStoredTheme(APP_CONFIG_STORAGE_KEY)).not.toThrow();
  });
});
