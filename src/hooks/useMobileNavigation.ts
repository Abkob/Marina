import { useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { appLocationKey, appLocationUrl, readAppLocation, type AppLocation } from '../utils/appNavigation';

export function useMobileNavigation(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const snapshot = (): AppLocation => {
      const { currentTab, selectedGoalId, focusedTaskId, focusedResourceId } = useAppStore.getState();
      return { currentTab, selectedGoalId, focusedTaskId, focusedResourceId };
    };
    const positions = new Map<string, number>();
    let currentKey = appLocationKey(snapshot());
    let fromHistory = false;
    let frame = 0;
    const previousScrollRestoration = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    history.replaceState({ ...history.state, marinaLocation: snapshot() }, '', appLocationUrl(snapshot(), window.location.href));
    const restoreScroll = (top: number) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => window.scrollTo({ top, behavior: 'instant' })); });
    };
    const unsubscribe = useAppStore.subscribe(() => {
      const next = snapshot();
      const key = appLocationKey(next);
      if (key === currentKey) return;
      const previousKey = currentKey;
      const lockedTop = document.body.style.position === 'fixed' ? -parseFloat(document.body.style.top) : null;
      positions.set(previousKey, lockedTop !== null && Number.isFinite(lockedTop) ? lockedTop : window.scrollY);
      currentKey = key;
      if (!fromHistory) history.pushState({ marinaLocation: next, marinaPreviousKey: previousKey }, '', appLocationUrl(next, window.location.href));
      restoreScroll(positions.get(key) ?? 0);
    });
    const pop = () => {
      const next = readAppLocation(new URL(window.location.href));
      if (!next) return;
      fromHistory = true;
      useAppStore.setState(next);
      fromHistory = false;
    };
    const reselect = () => { positions.set(currentKey, 0); restoreScroll(0); };
    window.addEventListener('popstate', pop);
    window.addEventListener('marina:tab-reselect', reselect);
    return () => {
      unsubscribe(); cancelAnimationFrame(frame); history.scrollRestoration = previousScrollRestoration;
      window.removeEventListener('popstate', pop); window.removeEventListener('marina:tab-reselect', reselect);
    };
  }, [enabled]);
}
