// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMobileViewport } from '../useMobileViewport';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function setup() {
  const viewport = Object.assign(new EventTarget(), { height: 812, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 812);
  const input = document.createElement('textarea');
  document.body.append(input);
  const hook = renderHook(useMobileViewport);
  return { viewport, input, ...hook };
}

describe('iPhone keyboard viewport', () => {
  it('follows visible height and offset, and keeps navigation hidden through keyboard dismissal', async () => {
    const { viewport, input } = setup();
    act(() => { input.focus(); viewport.height = 462; viewport.offsetTop = 38; viewport.dispatchEvent(new Event('resize')); });
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-mobile-keyboard'));
    expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe('462px');
    expect(document.documentElement.style.getPropertyValue('--app-viewport-top')).toBe('38px');
    act(() => { input.blur(); viewport.dispatchEvent(new Event('scroll')); });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(document.documentElement).toHaveAttribute('data-mobile-keyboard');
    act(() => { viewport.height = 812; viewport.offsetTop = 0; viewport.dispatchEvent(new Event('resize')); });
    await waitFor(() => expect(document.documentElement).not.toHaveAttribute('data-mobile-keyboard'));
  });

  it('does not mistake pinch zoom for a keyboard', async () => {
    const { viewport, input } = setup();
    act(() => { input.focus(); viewport.scale = 2; viewport.height = 400; viewport.dispatchEvent(new Event('resize')); });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(document.documentElement).not.toHaveAttribute('data-mobile-keyboard');
    expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe('812px');
  });

  it('cleans up viewport styles and pending updates on unmount', async () => {
    const { viewport, unmount } = setup();
    act(() => { viewport.height = 450; viewport.dispatchEvent(new Event('resize')); });
    unmount();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe('');
    expect(document.documentElement).not.toHaveAttribute('data-mobile-keyboard');
  });
});
