import { useSyncExternalStore } from 'react';

export const MOBILE_LAYOUT_QUERY = '(max-width: 767px), (max-width: 1023px) and (max-height: 500px)';

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    callback => {
      const media = window.matchMedia(query);
      media.addEventListener('change', callback);
      return () => media.removeEventListener('change', callback);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
