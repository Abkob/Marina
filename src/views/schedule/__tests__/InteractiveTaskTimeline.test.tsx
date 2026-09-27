// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SchedulerResult, ScheduleTaskInfo } from '../../../api/hooks';
import { InteractiveTaskTimeline } from '../InteractiveTaskTimeline';

const diagnostics: SchedulerResult['task_diagnostics'] = [
  {
    task_id: 'fits', outcome: 'fit', required_minutes: 240,
    due_date: '2026-08-15', earliest_date: '2026-08-11',
    available_before_deadline_minutes: 240, allocated_minutes: 240, shortfall_minutes: 0,
    days: [
      { date: '2026-08-11', capacity_minutes: 360, committed_before_minutes: 0, available_before_minutes: 360, allocated_minutes: 120 },
      { date: '2026-08-12', capacity_minutes: 360, committed_before_minutes: 0, available_before_minutes: 360, allocated_minutes: 120 },
    ],
  },
  {
    task_id: 'misses', outcome: 'overflow', required_minutes: 300,
    due_date: '2026-08-12', earliest_date: '2026-08-11',
    available_before_deadline_minutes: 120, allocated_minutes: 120, shortfall_minutes: 180,
    days: [
      { date: '2026-08-11', capacity_minutes: 120, committed_before_minutes: 0, available_before_minutes: 120, allocated_minutes: 120 },
    ],
  },
];

function task(title: string, remaining: number): ScheduleTaskInfo {
  return {
    title, goal_id: 'goal', goal_title: 'Launch', priority: 'high',
    estimated_minutes: remaining, logged_minutes: 0, committed_minutes: 0,
    remaining_minutes: remaining, start_date: '2026-08-11', due_date: '2026-08-15',
    start_date_source: { scope: 'goal', field: 'start_date', entity_id: 'goal' },
    due_date_source: { scope: 'goal', field: 'target_date', entity_id: 'goal' },
  };
}

const lookup = {
  fits: task('Task that fits', 240),
  misses: task('Task that misses', 300),
};

describe('InteractiveTaskTimeline', () => {
  it('lets the user scrub through a task and see remaining time change', () => {
    render(<InteractiveTaskTimeline diagnostics={diagnostics} taskLookup={lookup} goalTitles={{ goal: 'Launch' }} allTasks={[]} capacityDays={[]} />);

    expect(screen.getByText('2. Explore the time left, one day at a time')).toBeInTheDocument();
    expect(screen.getByText('Task that misses')).toBeInTheDocument();
    expect(screen.getAllByText('5h left').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } });

    expect(screen.getAllByText('3h left').length).toBeGreaterThan(0);
    expect(screen.getByText(/falls from 5h to 3h/)).toBeInTheDocument();
  });

  it('filters to tasks that fit', async () => {
    render(<InteractiveTaskTimeline diagnostics={diagnostics} taskLookup={lookup} goalTitles={{ goal: 'Launch' }} allTasks={[]} capacityDays={[]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Fits (1)' }));

    expect(await screen.findByText('Task that fits')).toBeInTheDocument();
    expect(await screen.findByText('Fits before cutoff')).toBeInTheDocument();
  });
});
