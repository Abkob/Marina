// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SchedulerResult, ScheduleTaskInfo } from '../../../api/hooks';
import type { DBGoal, DBTask } from '../../../db/schema';
import { FeasibilityReport } from '../FeasibilityReport';

const scheduler: SchedulerResult = {
  status: 'impossible',
  total_available_minutes: 600,
  total_required_minutes: 13_680,
  gap_minutes: -13_080,
  tasks_fit: [],
  tasks_overflow: ['physics', 'algorithm'],
  unestimated_task_ids: [],
  cycle_task_ids: [],
  day_assignments: [{ date: '2026-08-11', available_minutes: 600, used_minutes: 0, task_ids: [] }],
  capacity_days: [{ date: '2026-08-11', available_minutes: 600, used_minutes: 0, task_ids: [] }],
  task_diagnostics: [
    {
      task_id: 'physics', outcome: 'overflow', required_minutes: 7800,
      due_date: '2026-08-09', earliest_date: '2026-08-11',
      available_before_deadline_minutes: 0, allocated_minutes: 0, shortfall_minutes: 7800, days: [],
      recovery_allocated_minutes: 600, recovery_finish_date: null, unscheduled_minutes: 7200,
    },
    {
      task_id: 'algorithm', outcome: 'overflow', required_minutes: 5880,
      due_date: '2026-08-10', earliest_date: '2026-08-11',
      available_before_deadline_minutes: 0, allocated_minutes: 0, shortfall_minutes: 5880, days: [],
    },
  ],
};

const taskLookup: Record<string, ScheduleTaskInfo> = {
  physics: {
    title: 'Physics 210 studying', goal_id: 'courses', goal_title: 'Courses', priority: 'high',
    estimated_minutes: 7800, logged_minutes: 0, committed_minutes: 0, remaining_minutes: 7800,
    start_date: '2026-08-11', due_date: '2026-08-09', start_date_source: null, due_date_source: null,
  },
  algorithm: {
    title: 'Algorithm testing', goal_id: 'courses', goal_title: 'Courses', priority: 'high',
    estimated_minutes: 5880, logged_minutes: 0, committed_minutes: 0, remaining_minutes: 5880,
    start_date: '2026-08-11', due_date: '2026-08-10', start_date_source: null, due_date_source: null,
  },
};

const tasks = Object.entries(taskLookup).map(([id, task], position) => ({
  id, title: task.title, goal_id: 'courses', parent_task_id: null,
  estimated_minutes: task.estimated_minutes, time_rollup_mode: 'additive', completed: false, position,
})) as DBTask[];

const goals = [{ id: 'courses', title: 'Courses' }] as DBGoal[];

describe('FeasibilityReport', () => {
  it('explains exactly which task amounts make up the total shortfall', () => {
    render(
      <FeasibilityReport
        scheduler={scheduler}
        taskLookup={taskLookup}
        goals={goals}
        allTasks={tasks}
        weekDays={['2026-08-11']}
        previewDays={[]}
        onBack={vi.fn()}
      />,
    );

    const breakdown = screen.getByTestId('shortfall-breakdown');
    expect(within(breakdown).getByText(/What the 228h “doesn’t fit” number contains/)).toBeInTheDocument();
    expect(within(breakdown).getByText(/not one 228h block you must somehow do today/)).toBeInTheDocument();
    expect(within(breakdown).getAllByTestId('shortfall-task')).toHaveLength(2);
    expect(within(breakdown).getByText(/130h remaining − 0m reachable before cutoff = 130h unfinished/)).toBeInTheDocument();
    expect(within(breakdown).getByText(/Recovery proposal: 10h; 120h still outside this planning window/)).toBeInTheDocument();
    expect(within(breakdown).getByText(/98h remaining − 0m reachable before cutoff = 98h unfinished/)).toBeInTheDocument();
    expect(within(breakdown).getByText(/130h \+ 98h = 228h/)).toBeInTheDocument();
  });
});
