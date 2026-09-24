import { useEffect } from 'react';

/** Keep chat, sheets and navigation inside the visible area above the iOS keyboard. */
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let keyboardOpen = false;
    let frame = 0;
    const update = () => {
      if (viewport.scale !== 1) return; // Preserve normal browser pinch zoom.
      root.style.setProperty('--app-viewport-height', `${viewport.height}px`);
      root.style.setProperty('--app-viewport-top', `${viewport.offsetTop}px`);
      const editable = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
      // iOS blurs the input before its keyboard finishes closing. Keep the
      // navigation out of the way until the visible viewport actually recovers.
      const covered = Math.max(window.innerHeight, root.clientHeight) - viewport.height > 140;
      keyboardOpen = covered && Boolean(editable || keyboardOpen);
      root.toggleAttribute('data-mobile-keyboard', keyboardOpen);
    };
    const scheduleUpdate = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    update();
    viewport.addEventListener('resize', scheduleUpdate);
    viewport.addEventListener('scroll', scheduleUpdate);
    document.addEventListener('focusin', scheduleUpdate);
    document.addEventListener('focusout', scheduleUpdate);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', scheduleUpdate);
      viewport.removeEventListener('scroll', scheduleUpdate);
      document.removeEventListener('focusin', scheduleUpdate);
      document.removeEventListener('focusout', scheduleUpdate);
      root.removeAttribute('data-mobile-keyboard');
      root.style.removeProperty('--app-viewport-height');
      root.style.removeProperty('--app-viewport-top');
    };
  }, []);
}
