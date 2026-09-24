// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileNav } from '../MobileNav';
import { MobileHeader } from '../MobileHeader';
import { useAppStore } from '../../store/useAppStore';

vi.mock('../Header', () => ({ GlobalSearch: () => <input aria-label="Search everything" /> }));
vi.mock('zustand/middleware', () => ({ persist: (creator: unknown) => creator }));
beforeEach(() => useAppStore.setState({ currentTab: 'Schedule', selectedGoalId: null, focusedTaskId: null, focusedResourceId: null }));
afterEach(cleanup);

describe('mobile navigation', () => {
  it('keeps Capture selected in Journal and Schedule selected in Gantt', () => {
    useAppStore.setState({ currentTab: 'Journal' });
    const { unmount } = render(<MobileNav />);
    expect(screen.getByRole('button', { name: 'Open Capture' }).getAttribute('aria-current')).toBe('page');
    unmount();
    useAppStore.setState({ currentTab: 'Gantt' });
    render(<MobileNav />);
    expect(screen.getByRole('button', { name: 'Open Schedule' }).getAttribute('aria-current')).toBe('page');
  });

  it('finds a secondary page and closes the menu when navigating', () => {
    render(<MobileNav />);
    fireEvent.click(screen.getByRole('button', { name: 'Open all pages' }));
    const dialog = screen.getByRole('dialog', { name: 'Your workspace' });
    fireEvent.change(within(dialog).getByLabelText('Find a page'), { target: { value: 'storage' } });
    expect(within(dialog).queryByRole('button', { name: 'Open Copilot' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open Usage' }));
    expect(useAppStore.getState().currentTab).toBe('Usage');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('keeps the goal detail when switching tabs and returns to the list on a second tap', () => {
    useAppStore.setState({ currentTab: 'Goals', selectedGoalId: 'goal-1', focusedTaskId: 'task-1' });
    render(<MobileNav />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Goals' }));
    expect(useAppStore.getState().focusedTaskId).toBe('task-1');
    fireEvent.click(screen.getByRole('button', { name: 'Open Goals' }));
    expect(useAppStore.getState().selectedGoalId).toBeNull();
    expect(useAppStore.getState().focusedTaskId).toBeNull();
  });

  it('supports dismissing the menu and restoring focus', () => {
    render(<MobileNav />);
    const trigger = screen.getByRole('button', { name: 'Open all pages' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('moves back from a task to its goal, then to the goal list', () => {
    useAppStore.setState({ currentTab: 'Goals', selectedGoalId: 'goal-1', focusedTaskId: 'task-1' });
    render(<MobileHeader />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to goal' }));
    expect(useAppStore.getState().selectedGoalId).toBe('goal-1');
    expect(useAppStore.getState().focusedTaskId).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to goals' }));
    expect(useAppStore.getState().selectedGoalId).toBeNull();
  });

  it('opens search from any page and can return to the resource library', () => {
    useAppStore.setState({ currentTab: 'Resources', focusedResourceId: 'resource-1' });
    render(<MobileHeader />);
    fireEvent.click(screen.getByRole('button', { name: 'Search workspace' }));
    expect(screen.getByRole('dialog', { name: 'Search your workspace' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to resources' }));
    expect(useAppStore.getState().focusedResourceId).toBeNull();
  });
});
