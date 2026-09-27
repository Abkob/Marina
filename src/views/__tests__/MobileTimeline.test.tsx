// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MobileTimeline } from '../MobileTimeline';

const mocks = vi.hoisted(() => ({ goal: vi.fn(), focus: vi.fn(), work: vi.fn(), tab: vi.fn() }));
vi.mock('../../store/useAppStore', () => ({ useAppStore: () => ({ navigateToGoal: mocks.goal, setFocusedTaskId: mocks.focus, setWorkTaskId: mocks.work, setCurrentTab: mocks.tab }) }));
vi.mock('../../api/hooks', () => ({
  useGoals: () => ({ data: [{ id: 'goal', title: 'Learn something' }], refetch: vi.fn() }),
  useAllTasks: () => ({ data: [
    { id: 'first', title: 'Read chapter', goal_id: 'goal', due_date: '2026-09-24', completed: false },
    { id: 'done', title: 'Finished task', goal_id: 'goal', due_date: '2026-09-25', completed: true },
    { id: 'free', title: 'Buy a notebook', goal_id: null, completed: false },
  ], refetch: vi.fn() }),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows task dates, keeps undated tasks accessible, and lets the user include completed tasks', () => {
  render(<MobileTimeline />);
  expect(screen.getByRole('heading', { name: /Sep 24/ })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'No date yet' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open task Finished task' })).toBeNull();
  fireEvent.click(screen.getByLabelText('Include completed tasks'));
  expect(screen.getByRole('button', { name: 'Open task Finished task' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'goal' } });
  expect(screen.queryByRole('button', { name: 'Open task Buy a notebook' })).toBeNull();
});

it('opens a task in its goal and standalone work in the Work page', () => {
  render(<MobileTimeline />);
  fireEvent.click(screen.getByRole('button', { name: 'Open task Read chapter' }));
  expect(mocks.goal).toHaveBeenCalledWith('goal');
  expect(mocks.focus).toHaveBeenCalledWith('first');
  expect(mocks.goal.mock.invocationCallOrder[0]).toBeLessThan(mocks.focus.mock.invocationCallOrder[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Open task Buy a notebook' }));
  expect(mocks.work).toHaveBeenCalledWith('free');
  expect(mocks.tab).toHaveBeenCalledWith('Work');
});
