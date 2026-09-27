// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DBTask } from '../../../db/schema';
import type { SchedulerResult, ScheduleTaskInfo } from '../../../api/hooks';
import { WORK_TIMER_STORAGE_KEY } from '../../../utils/workTimer';
import { HierarchyWorkloadPanel } from '../HierarchyWorkloadPanel';

const root = {
  id: 'courses', title: 'Incomplete Courses', parent_task_id: null, goal_id: 'goal',
  estimated_minutes: 2400, time_rollup_mode: 'inclusive', completed: false, position: 0,
} as DBTask;
const physics = {
  id: 'physics', title: 'Physics 210', parent_task_id: 'courses', goal_id: 'goal',
  estimated_minutes: null, time_rollup_mode: 'inclusive', completed: false, position: 0,
} as DBTask;
const studying = {
  id: 'studying', title: 'Studying', parent_task_id: 'physics', goal_id: 'goal',
  estimated_minutes: 7800, time_rollup_mode: 'additive', completed: false, position: 0,
} as DBTask;
const unknown = {
  id: 'videos', title: 'Fix video schedule', parent_task_id: 'physics', goal_id: 'goal',
  estimated_minutes: null, time_rollup_mode: 'additive', completed: false, position: 1,
} as DBTask;

const diagnostics: SchedulerResult['task_diagnostics'] = [
  {
    task_id: 'studying', outcome: 'overflow', required_minutes: 7800,
    due_date: '2026-08-15', earliest_date: '2026-08-11',
    available_before_deadline_minutes: 2400, allocated_minutes: 2400, shortfall_minutes: 5400,
    days: [],
  },
  {
    task_id: 'videos', outcome: 'unestimated', required_minutes: 0,
    due_date: '2026-08-15', earliest_date: '2026-08-11',
    available_before_deadline_minutes: 0, allocated_minutes: 0, shortfall_minutes: 0,
    days: [],
  },
];

const taskLookup: Record<string, ScheduleTaskInfo> = {
  studying: {
    title: 'Studying', goal_id: 'goal', goal_title: 'Courses', priority: 'high',
    estimated_minutes: 7800, logged_minutes: 0, committed_minutes: 0, remaining_minutes: 7800,
    start_date: '2026-08-11', due_date: '2026-08-15', start_date_source: null, due_date_source: null,
  },
  videos: {
    title: 'Fix video schedule', goal_id: 'goal', goal_title: 'Courses', priority: 'medium',
    estimated_minutes: 0, logged_minutes: 0, committed_minutes: 0, remaining_minutes: 0,
    start_date: '2026-08-11', due_date: '2026-08-15', start_date_source: null, due_date_source: null,
  },
};

const capacityDays: SchedulerResult['capacity_days'] = [
  { date: '2026-08-11', available_minutes: 600, used_minutes: 0, task_ids: [] },
  { date: '2026-08-12', available_minutes: 600, used_minutes: 0, task_ids: [] },
  { date: '2026-08-13', available_minutes: 600, used_minutes: 0, task_ids: [] },
];

describe('HierarchyWorkloadPanel', () => {
  it('shows the parent/subtask estimate mismatch and a daily spare-time breakdown', () => {
    render(
      <HierarchyWorkloadPanel
        selectedTaskId="studying"
        diagnostics={diagnostics}
        taskLookup={taskLookup}
        allTasks={[root, physics, studying, unknown]}
        capacityDays={capacityDays}
      />,
    );

    expect(screen.getByText('Parent and subtask breakdown')).toBeInTheDocument();
    expect(screen.getByText(/40h value is stored on its parent container/)).toHaveTextContent('Physics 210 has no saved estimate of its own');
    expect(screen.getByTestId('estimate-warning')).toHaveTextContent('Incomplete Courses says 40h total');
    expect(screen.getByText('130h')).toBeInTheDocument();
    expect(screen.getByTestId('daily-explanation')).toHaveTextContent('give 6h to Physics 210');
    expect(screen.getByText(/excludes 1 subtask with no estimate/)).toBeInTheDocument();
  });

  it('updates the daily plan when maximum effort is selected', () => {
    render(
      <HierarchyWorkloadPanel
        selectedTaskId="studying"
        diagnostics={diagnostics}
        taskLookup={taskLookup}
        allTasks={[root, physics, studying, unknown]}
        capacityDays={capacityDays}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Maximum 100%' }));

    expect(screen.getByTestId('daily-explanation')).toHaveTextContent('give 10h to Physics 210');
    expect(screen.getByTestId('daily-explanation')).toHaveTextContent('then 120h of known work remains');
  });

  it('recalculates work left tonight as the today slider moves', () => {
    render(
      <HierarchyWorkloadPanel
        selectedTaskId="studying"
        diagnostics={diagnostics}
        taskLookup={taskLookup}
        allTasks={[root, physics, studying, unknown]}
        capacityDays={capacityDays}
      />,
    );

    fireEvent.change(screen.getByLabelText('What if work today'), { target: { value: '120' } });

    expect(screen.getByTestId('today-calculator-explanation')).toHaveTextContent('Do 2h today');
    expect(screen.getByTestId('today-calculator-explanation')).toHaveTextContent('128h of known work is left tonight');
    expect(screen.getByTestId('today-calculator-explanation')).toHaveTextContent('8h spare today');
    expect(screen.getByTestId('daily-explanation')).toHaveTextContent('give 2h to Physics 210');
  });

  it('deducts a running Focus session from the remaining work every second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T10:30:30.000Z'));
    const stored = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
        clear: () => stored.clear(),
      },
    });
    window.localStorage.setItem(WORK_TIMER_STORAGE_KEY, JSON.stringify({
      taskId: 'studying',
      startedAt: '2026-08-11T10:00:00.000Z',
      notes: '',
    }));

    const { unmount } = render(
      <HierarchyWorkloadPanel
        selectedTaskId="studying"
        diagnostics={diagnostics}
        taskLookup={taskLookup}
        allTasks={[root, physics, studying, unknown]}
        capacityDays={capacityDays}
      />,
    );

    expect(screen.getByTestId('live-focus-status')).toHaveTextContent('30m 30s worked');
    expect(screen.getByTestId('live-focus-status')).toHaveTextContent('129h 29m 30s');

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByTestId('live-focus-status')).toHaveTextContent('30m 31s worked');

    unmount();
    window.localStorage.removeItem(WORK_TIMER_STORAGE_KEY);
    delete (window as unknown as { localStorage?: Storage }).localStorage;
    vi.useRealTimers();
  });
});
