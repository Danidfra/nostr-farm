import { useEffect, useState } from 'react';

import { systemClock, type UnixSeconds } from '@/farm/time';

/**
 * The application's single source of "now".
 *
 * The pure domain never reads a clock, so every time-dependent render goes
 * through here. Ticking on an interval keeps growth bars alive without every
 * component calling `Date.now()` on its own schedule.
 */
export function useNowSeconds(intervalMs = 1000): UnixSeconds {
  const [now, setNow] = useState(() => systemClock.now());

  useEffect(() => {
    setNow(systemClock.now());
    const id = setInterval(() => setNow(systemClock.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
