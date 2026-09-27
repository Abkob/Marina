import { useEffect, useState } from 'react';

export const MOBILE_SCHEDULE_PREFERENCES = 'marina-mobile-schedule-v1';
type Preferences = { compact: boolean; view: 'agenda' | 'day' };

function readPreferences(): Preferences {
  const fallback: Preferences = { compact: window.matchMedia('(max-width: 389px)').matches, view: 'agenda' };
  try {
    const saved = JSON.parse(window.localStorage.getItem(MOBILE_SCHEDULE_PREFERENCES) ?? 'null');
    return {
      compact: typeof saved?.compact === 'boolean' ? saved.compact : fallback.compact,
      view: saved?.view === 'day' || saved?.view === 'agenda' ? saved.view : fallback.view,
    };
  } catch { return fallback; }
}

/** Device preferences survive page changes and reopening the Home Screen app. */
export function useMobileSchedulePreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(() => {
    try { window.localStorage.setItem(MOBILE_SCHEDULE_PREFERENCES, JSON.stringify(preferences)); } catch { /* Private/storage-limited sessions still work. */ }
  }, [preferences]);
  return {
    ...preferences,
    setCompact: (compact: boolean) => setPreferences(current => ({ ...current, compact })),
    setView: (view: Preferences['view']) => setPreferences(current => ({ ...current, view })),
  };
}
