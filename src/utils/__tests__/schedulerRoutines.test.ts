import { describe, expect, it } from 'vitest';
import { computeSchedule, type SchedulerInput } from '../../../server/services/scheduler';

const base: SchedulerInput = {
  tasks: [{ id: 'study', title: 'Study', estimated_minutes: 160, due_date: '2026-09-21', priority: 'medium', blocker_ids: [] }],
  meetings: [], prefs: { work_days: [1, 2, 3, 4, 5], daily_capacity_minutes: 180, buffer_ratio: 0 },
  overrides: [], start_date: '2026-09-21', horizon_days: 1,
};

describe('routine capacity reservations', () => {
  it('reserves routine time before allocating one-off task work', () => {
    const result = computeSchedule({ ...base, meetings: [{ date: '2026-09-21', duration_minutes: 30, routine: true }] });
    expect(result.total_available_minutes).toBe(150);
    expect(result.capacity_days[0].routine_minutes).toBe(30);
    expect(result.tasks_overflow).toContain('study');
    expect(result.total_required_minutes).toBe(160); // not an endless task estimate
  });
  it('also deducts routines from a manually overridden day', () => {
    const result = computeSchedule({ ...base, overrides: [{ date: '2026-09-21', available_minutes: 120 }], meetings: [{ date: '2026-09-21', duration_minutes: 30, routine: true }] });
    expect(result.total_available_minutes).toBe(90);
  });
  it('does not double-count or invent capacity on an off day', () => {
    const result = computeSchedule({ ...base, tasks: [], start_date: '2026-09-20', meetings: [{ date: '2026-09-20', duration_minutes: 30, routine: true }] });
    expect(result.total_available_minutes).toBe(0);
    expect(result.capacity_days).toEqual([]);
  });
  it('keeps existing meeting and buffer deductions and clamps capacity at zero', () => {
    const result = computeSchedule({ ...base, prefs: { ...base.prefs, buffer_ratio: 0.1 }, meetings: [
      { date: '2026-09-21', duration_minutes: 60 }, { date: '2026-09-21', duration_minutes: 120, routine: true },
    ] });
    expect(result.total_available_minutes).toBe(0);
  });
});
