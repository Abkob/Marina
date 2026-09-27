// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePersistentDraft } from '../usePersistentDraft';

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
  } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('phone drafts', () => {
  it('keeps independent task drafts when switching tasks and reopening Work', () => {
    const { result, rerender, unmount } = renderHook(({ id }) => usePersistentDraft(id), { initialProps: { id: 'work:a' } });
    act(() => result.current[1]('First task note'));
    rerender({ id: 'work:b' });
    expect(result.current[0]).toBe('');
    act(() => result.current[1]('Second task note'));
    rerender({ id: 'work:a' });
    expect(result.current[0]).toBe('First task note');
    unmount();
    const reopened = renderHook(() => usePersistentDraft('work:b'));
    expect(reopened.result.current[0]).toBe('Second task note');
  });
  it('clears a saved draft without clearing another page’s draft', () => {
    values.set('marina-draft:journal', 'Keep me');
    const { result } = renderHook(() => usePersistentDraft('capture'));
    act(() => result.current[1]('Save me'));
    act(() => result.current[1](''));
    expect(values.has('marina-draft:capture')).toBe(false);
    expect(values.get('marina-draft:journal')).toBe('Keep me');
  });
  it('keeps typing usable when storage is full or unavailable', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    const { result } = renderHook(() => usePersistentDraft('capture'));
    act(() => result.current[1]('Still here'));
    expect(result.current[0]).toBe('Still here');
  });
});
