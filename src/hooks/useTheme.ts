import { useAppContext } from '@/hooks/useAppContext';
import type { Theme } from '@/contexts/AppContext';

/** Read and change the app-wide theme. Persisted by `AppProvider`. */
export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const { config, updateConfig } = useAppContext();

  return {
    theme: config.theme,
    setTheme: (theme: Theme) => updateConfig((current) => ({ ...current, theme })),
  };
}
