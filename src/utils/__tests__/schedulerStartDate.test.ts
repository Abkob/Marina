import { describe, expect, it } from 'vitest';
import { computeSchedule, type SchedulerInput } from '../../../server/services/scheduler.js';

const FIXED_TODAY = '2026-07-06';
const prefs: SchedulerInput['prefs'] = {
  work_days: [0, 1, 2, 3, 4, 5, 6],
  daily_capacity_minutes: 480,
  buffer_ratio: 0,
};

function input(tasks: SchedulerInput['tasks']): SchedulerInput {
  return { tasks, meetings: [], prefs, overrides: [], horizon_days: 7, start_date: FIXED_TODAY };
}

describe('computeSchedule timeline start dates', () => {
  it('does not allocate work before the task timeline start', () => {
    const result = computeSchedule(input([{
      id: 'future', title: 'Future task', estimated_minutes: 120,
      start_date: '2026-07-09', due_date: '2026-07-11', priority: 'high', blocker_ids: [],
    }]));

    expect(result.tasks_fit).toContain('future');
    expect(result.day_assignments.filter(day => day.task_ids.includes('future')).every(day => day.date >= '2026-07-09')).toBe(true);
    expect(result.task_diagnostics.find(item => item.task_id === 'future')?.earliest_date).toBe('2026-07-09');
  });

  it('reports the full task as short when its start is after its deadline', () => {
    const result = computeSchedule(input([{
      id: 'inverted', title: 'Inverted timeline', estimated_minutes: 90,
      start_date: '2026-07-10', due_date: '2026-07-08', priority: 'high', blocker_ids: [],
    }]));

    expect(result.tasks_overflow).toContain('inverted');
    expect(result.task_diagnostics.find(item => item.task_id === 'inverted')).toMatchObject({
      earliest_date: '2026-07-10', shortfall_minutes: 90, allocated_minutes: 0,
    });
  });

  it('does not call a fully consumed real estimate unestimated', () => {
    const result = computeSchedule(input([{
      id: 'covered', title: 'Covered task', estimated_minutes: 0, has_estimate: true,
      due_date: '2026-07-08', priority: 'medium', blocker_ids: [],
    }]));

    expect(result.tasks_fit).toContain('covered');
    expect(result.unestimated_task_ids).not.toContain('covered');
    expect(result.task_diagnostics.find(item => item.task_id === 'covered')).toMatchObject({
      outcome: 'fit', required_minutes: 0,
    });
  });
});
