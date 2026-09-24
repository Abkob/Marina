import { useEffect, useRef, useState } from 'react';
import { swipeDirection } from '../utils/calendarGestures';

/** Horizontal swipes leave vertical scrolling and browser pinch zoom alone. */
export function useCalendarSwipe(onSwipe: (direction: -1 | 1) => void) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const callback = useRef(onSwipe);
  callback.current = onSwipe;
  useEffect(() => {
    if (!element) return;
    let start: { x: number; y: number; scrolled: boolean } | null = null;
    let suppressClickUntil = 0;
    const touchStart = (event: TouchEvent) => {
      if (event.target instanceof Element && event.target.closest('input, select, textarea')) { start = null; return; }
      start = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY, scrolled: false } : null;
    };
    const touchMove = (event: TouchEvent) => {
      if (!start || event.touches.length !== 1) { start = null; return; }
      const dx = event.touches[0].clientX - start.x;
      const dy = event.touches[0].clientY - start.y;
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) start.scrolled = true;
      if (!start.scrolled && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.6 && event.cancelable) event.preventDefault();
    };
    const touchEnd = (event: TouchEvent) => {
      const point = event.changedTouches[0];
      if (start && !start.scrolled && point) {
        const direction = swipeDirection(point.clientX - start.x, point.clientY - start.y);
        if (direction) { suppressClickUntil = Date.now() + 500; callback.current(direction); }
      }
      start = null;
    };
    const cancel = () => { start = null; };
    const click = (event: MouseEvent) => {
      if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); }
    };
    element.addEventListener('touchstart', touchStart, { passive: true });
    element.addEventListener('touchmove', touchMove, { passive: false });
    element.addEventListener('touchend', touchEnd);
    element.addEventListener('touchcancel', cancel);
    element.addEventListener('click', click, true);
    return () => {
      element.removeEventListener('touchstart', touchStart);
      element.removeEventListener('touchmove', touchMove);
      element.removeEventListener('touchend', touchEnd);
      element.removeEventListener('touchcancel', cancel);
      element.removeEventListener('click', click, true);
    };
  }, [element]);
  return setElement;
}
