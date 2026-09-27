// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMobileNavigation } from '../useMobileNavigation';
import { useAppStore } from '../../store/useAppStore';
import { appLocationUrl, readAppLocation } from '../../utils/appNavigation';
vi.mock('zustand/middleware', () => ({ persist: (creator: unknown) => creator }));
beforeEach(() => {
  history.replaceState({}, '', '/');
  useAppStore.setState({ currentTab: 'Schedule', selectedGoalId: null, focusedTaskId: null, focusedResourceId: null });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('records goal and task navigation so Safari back and forward stay inside the app', () => {
  renderHook(() => useMobileNavigation(true));
  act(() => useAppStore.getState().navigateToGoal('goal 1'));
  expect(window.location.search).toBe('?view=goals&goal=goal+1');
  act(() => useAppStore.getState().setFocusedTaskId('task-1'));
  expect(window.location.search).toContain('task=task-1');
  const push = vi.spyOn(history, 'pushState');
  act(() => {
    history.replaceState({}, '', '/?view=goals&goal=goal+1');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(useAppStore.getState().selectedGoalId).toBe('goal 1');
  expect(useAppStore.getState().focusedTaskId).toBeNull();
  expect(push).not.toHaveBeenCalled();
  act(() => {
    history.replaceState({}, '', '/?view=goals&goal=goal+1&task=task-1');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(useAppStore.getState().focusedTaskId).toBe('task-1');
});
it('does not add history for unrelated drafts, toasts, or a repeated page', () => {
  renderHook(() => useMobileNavigation(true));
  const push = vi.spyOn(history, 'pushState');
  act(() => useAppStore.setState({ copilotDraft: 'Hello', currentTab: 'Schedule' }));
  expect(push).not.toHaveBeenCalled();
});
it('retains deep links on refresh and discards details that belong to another page', () => {
  expect(readAppLocation(new URL('https://example.test/?view=resources&resource=file1&task=other'))).toEqual({ currentTab: 'Resources', focusedResourceId: 'file1', selectedGoalId: null, focusedTaskId: null });
  expect(readAppLocation(new URL('https://example.test/?view=unknown'))).toBeNull();
  expect(appLocationUrl({ currentTab: 'Work', selectedGoalId: 'old', focusedTaskId: 'old', focusedResourceId: 'old' }, 'https://example.test/?view=goals&goal=old&task=old')).toBe('/?view=work');
});
