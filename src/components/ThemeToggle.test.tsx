import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '@/components/AppProvider';
import type { AppConfig } from '@/contexts/AppContext';
import { useTheme } from '@/hooks/useTheme';
import { APP_CONFIG_STORAGE_KEY } from '@/lib/theme-storage';
import { ThemeToggle } from './ThemeToggle';

const defaultConfig: AppConfig = {
  theme: 'system',
  relayMetadata: { relays: [], updatedAt: 0 },
};

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

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AppProvider storageKey={APP_CONFIG_STORAGE_KEY} defaultConfig={defaultConfig}>
    {children}
  </AppProvider>
);

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('light', 'dark');
  setSystemPrefersDark(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('choosing a theme', () => {
  it('applies dark to the document root', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => result.current.setTheme('dark'));

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('switches back to light, removing the dark class', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => result.current.setTheme('dark'));
    act(() => result.current.setTheme('light'));

    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('follows the OS preference in system mode', () => {
    setSystemPrefersDark(true);
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => result.current.setTheme('system'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('persists the choice', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => result.current.setTheme('dark'));

    expect(JSON.parse(localStorage.getItem(APP_CONFIG_STORAGE_KEY)!)).toMatchObject({ theme: 'dark' });
  });

  it('restores the persisted choice on a fresh mount', () => {
    localStorage.setItem(APP_CONFIG_STORAGE_KEY, JSON.stringify({ theme: 'dark' }));

    const { result } = renderHook(() => useTheme(), { wrapper });

    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('defaults to system when nothing was ever chosen', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('system');
  });
});

describe('ThemeToggle', () => {
  it('renders a control labelled with the active appearance', () => {
    localStorage.setItem(APP_CONFIG_STORAGE_KEY, JSON.stringify({ theme: 'dark' }));
    render(<ThemeToggle />, { wrapper });

    expect(screen.getByRole('button', { name: 'Appearance: Dark' })).toBeInTheDocument();
  });

  it('reflects the system setting', () => {
    render(<ThemeToggle />, { wrapper });
    expect(screen.getByRole('button', { name: 'Appearance: System' })).toBeInTheDocument();
  });
});
