import { describe, it, expect } from 'vitest';
import { computeSchedule, type SchedulerInput } from '../../../server/services/scheduler.js';

// ─── Helpers (fixed clock — timezone-independent) ─────────────────────────────
// Use a fixed Monday so tests are deterministic regardless of machine timezone.

const FIXED_TODAY = '2026-07-06'; // a Monday

function daysFromNow(n: number): string {
  const [y, m, d] = FIXED_TODAY.split('-').map(Number);
  const date = new Date(y, m - 1, d + n);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const BASE_PREFS: SchedulerInput['prefs'] = {
  work_days: [0, 1, 2, 3, 4, 5, 6], // all 7 days = simplest to reason about
  daily_capacity_minutes: 480,
  buffer_ratio: 0,
};

function makeInput(overrides: Partial<SchedulerInput> = {}): SchedulerInput {
  return { tasks: [], meetings: [], prefs: BASE_PREFS, overrides: [], horizon_days: 7, start_date: FIXED_TODAY, ...overrides };
}

// ─── Feasibility ──────────────────────────────────────────────────────────────

describe('computeSchedule — feasibility status', () => {
  it('returns feasible when all tasks fit with capacity to spare', () => {
    const result = computeSchedule(makeInput({
      tasks: [
        { id: 't1', title: 'Task 1', estimated_minutes: 120, due_date: daysFromNow(5), priority: 'medium', blocker_ids: [] },
        { id: 't2', title: 'Task 2', estimated_minutes: 60,  due_date: daysFromNow(5), priority: 'low',    blocker_ids: [] },
      ],
      horizon_days: 7,
    }));
    expect(result.status).toBe('feasible');
    expect(result.tasks_overflow).toHaveLength(0);
    expect(result.tasks_fit).toContain('t1');
    expect(result.tasks_fit).toContain('t2');
  });

  it('returns impossible when tasks cannot fit in the horizon', () => {
    const result = computeSchedule(makeInput({
      tasks: [
        // 500 min × 10 = 5000 min; 2 days × 480 = 960 min available
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `t${i}`,
          title: `Task ${i}`,
          estimated_minutes: 500,
          due_date: daysFromNow(2),
          priority: 'high' as const,
          blocker_ids: [],
        })),
      ],
      horizon_days: 2,
    }));
    expect(result.status).toBe('impossible');
    expect(result.tasks_overflow.length).toBeGreaterThan(0);
    expect(result.impossible_reason).toBeTruthy();
  });

  it('gap_minutes is positive when there is surplus capacity', () => {
    const result = computeSchedule(makeInput({
      tasks: [{ id: 't1', title: 'Small task', estimated_minutes: 60, due_date: daysFromNow(3), priority: 'high', blocker_ids: [] }],
    }));
    expect(result.gap_minutes).toBeGreaterThan(0);
  });

  it('explains deadline shortfall instead of claiming zero shortage when later capacity exists', () => {
    const result = computeSchedule(makeInput({
      tasks: [{ id: 'early', title: 'Early overload', estimated_minutes: 960, due_date: FIXED_TODAY, priority: 'high', blocker_ids: [] }],
      horizon_days: 7,
    }));
    expect(result.status).toBe('impossible');
    expect(result.gap_minutes).toBeGreaterThan(0);
    expect(result.impossible_reason).toContain('480 minutes unfinished');
    expect(result.impossible_reason).not.toContain('Short by 0 minutes');
  });

  it('gap_minutes is negative when overflow exists', () => {
    const result = computeSchedule(makeInput({
      tasks: [{ id: 't1', title: 'Huge task', estimated_minutes: 99999, due_date: daysFromNow(1), priority: 'high', blocker_ids: [] }],
      horizon_days: 1,
    }));
    expect(result.gap_minutes).toBeLessThan(0);
  });
});

// ─── Blocker ordering ─────────────────────────────────────────────────────────

describe('computeSchedule — blocker ordering', () => {
  it('schedules blocker before the blocked task', () => {
    const result = computeSchedule(makeInput({
      tasks: [
        { id: 'blocked', title: 'Blocked task', estimated_minutes: 60, due_date: daysFromNow(5), priority: 'high', blocker_ids: ['blocker'] },
        { id: 'blocker', title: 'Blocker task', estimated_minutes: 60, due_date: daysFromNow(5), priority: 'low',  blocker_ids: [] },
      ],
    }));
    const assignments = result.day_assignments;
    const blockerDay   = assignments.find(d => d.task_ids.includes('blocker'))?.date;
    const blockedDay   = assignments.find(d => d.task_ids.includes('blocked'))?.date;
    expect(blockerDay).toBeDefined();
    expect(blockedDay).toBeDefined();
    expect(blockerDay! <= blockedDay!).toBe(true);
  });

  it('handles tasks whose blockers are not in the input set', () => {
    // blocker_ids references an ID not in the task list — must not crash
    const result = computeSchedule(makeInput({
      tasks: [{ id: 't1', title: 'Task', estimated_minutes: 60, due_date: daysFromNow(3), priority: 'medium', blocker_ids: ['ghost-id'] }],
    }));
    expect(result.tasks_fit).toContain('t1');
  });
});

// ─── Unestimated tasks ────────────────────────────────────────────────────────

describe('computeSchedule — unestimated tasks', () => {
  it('puts tasks with no estimate into unestimated_task_ids, not overflow', () => {
    const result = computeSchedule(makeInput({
      tasks: [
        { id: 'has-estimate',  title: 'Estimated',   estimated_minutes: 60, due_date: null, priority: 'medium', blocker_ids: [] },
        { id: 'no-estimate',   title: 'Unestimated', estimated_minutes: 0,  due_date: null, priority: 'medium', blocker_ids: [] },
      ],
    }));
    expect(result.unestimated_task_ids).toContain('no-estimate');
    expect(result.tasks_overflow).not.toContain('no-estimate');
    expect(result.tasks_fit).toContain('has-estimate');
  });
});

// ─── Meetings reduce capacity ─────────────────────────────────────────────────

describe('computeSchedule — meetings block capacity', () => {
  it('a day with a 480-min meeting has 0 effective capacity', () => {
    const meetingDate = daysFromNow(0); // today
    const result = computeSchedule(makeInput({
      tasks: [{ id: 't1', title: 'Task', estimated_minutes: 60, due_date: daysFromNow(1), priority: 'high', blocker_ids: [] }],
      meetings: [{ date: meetingDate, duration_minutes: 480 }],
      horizon_days: 2,
    }));
    // Task should not land on the fully-blocked day
    const meetingDayAssignment = result.day_assignments.find(d => d.date === meetingDate && d.task_ids.includes('t1'));
    expect(meetingDayAssignment).toBeUndefined();
  });

  it('a partial meeting reduces but does not eliminate capacity', () => {
    const meetingDate = daysFromNow(0);
    const result = computeSchedule(makeInput({
      tasks: [{ id: 't1', title: 'Task', estimated_minutes: 60, due_date: daysFromNow(0), priority: 'high', blocker_ids: [] }],
      meetings: [{ date: meetingDate, duration_minutes: 240 }],
    }));
    // 480 - 240 = 240 min remaining; 60-min task must fit
    expect(result.tasks_fit).toContain('t1');
  });
});

// ─── Schedule overrides ───────────────────────────────────────────────────────

describe('computeSchedule — schedule overrides', () => {
  it('override sets available_minutes for that day regardless of prefs', () => {
    const overrideDate = daysFromNow(0);
    const result = computeSchedule(makeInput({
      tasks: [{ id: 't1', title: 'Task', estimated_minutes: 50, due_date: overrideDate, priority: 'high', blocker_ids: [] }],
      overrides: [{ date: overrideDate, available_minutes: 30 }],
    }));
    // 50-min task cannot fit in 30-min override slot on that day;
    // it may land on the next day instead
    const overrideDayAssignment = result.day_assignments.find(d => d.date === overrideDate);
    if (overrideDayAssignment) {
      expect(overrideDayAssignment.available_minutes).toBe(30);
    }
  });

  it('override of 0 makes a day completely blocked', () => {
    const overrideDate = daysFromNow(0);
    const result = computeSchedule(makeInput({
      tasks: [{ id: 't1', title: 'Task', estimated_minutes: 60, due_date: overrideDate, priority: 'high', blocker_ids: [] }],
      overrides: [{ date: overrideDate, available_minutes: 0 }],
    }));
    const overrideDayWithTask = result.day_assignments.find(d => d.date === overrideDate && d.task_ids.includes('t1'));
    expect(overrideDayWithTask).toBeUndefined();
  });
});

// ─── Work days filter ─────────────────────────────────────────────────────────

describe('computeSchedule — work days', () => {
  it('skips non-work days when scheduling', () => {
    // FIXED_TODAY is a Monday; with work_days=[1] only Mondays are scheduled
    const result = computeSchedule(makeInput({
      tasks: [{ id: 't1', title: 'Task', estimated_minutes: 60, due_date: daysFromNow(14), priority: 'medium', blocker_ids: [] }],
      prefs: { ...BASE_PREFS, work_days: [1] },
      horizon_days: 14,
    }));
    // All assigned days must be Mondays (getDay() === 1)
    for (const day of result.day_assignments) {
      const dow = new Date(day.date + 'T12:00:00').getDay();
      expect(dow).toBe(1);
    }
  });

  it('Sunday (getDay()=0) is treated as a work day when included', () => {
    // FIXED_TODAY = 2026-07-06 (Monday); horizon 7 days → first Sunday is 2026-07-12
    const result = computeSchedule(makeInput({
      tasks: [{ id: 't1', title: 'Task', estimated_minutes: 60, due_date: daysFromNow(14), priority: 'medium', blocker_ids: [] }],
      prefs: { ...BASE_PREFS, work_days: [0] }, // getDay() 0 = Sunday
      horizon_days: 14,
    }));
    // All assigned days must be Sundays
    for (const day of result.day_assignments) {
      const dow = new Date(day.date + 'T12:00:00').getDay();
      expect(dow).toBe(0);
    }
    // At least one Sunday should be assigned
    expect(result.day_assignments.length).toBeGreaterThan(0);
  });

  it('DB ISO work_days convention: converting 7→0 maps Sunday correctly', () => {
    // Simulates what ai.ts does: db stores 7 for Sunday, we convert via % 7 → 0
    const isoWorkDays = [7]; // Sunday in ISO 1–7 convention
    const getdayWorkDays = isoWorkDays.map(d => d % 7); // → [0]
    expect(getdayWorkDays).toEqual([0]);

    const result = computeSchedule(makeInput({
      tasks: [{ id: 't1', title: 'Task', estimated_minutes: 60, due_date: daysFromNow(14), priority: 'medium', blocker_ids: [] }],
      prefs: { ...BASE_PREFS, work_days: getdayWorkDays },
      horizon_days: 14,
    }));
    for (const day of result.day_assignments) {
      const dow = new Date(day.date + 'T12:00:00').getDay();
      expect(dow).toBe(0);
    }
  });
});

// ─── Task splitting (Epic 21) ─────────────────────────────────────────────────

describe('computeSchedule — task splitting across multiple days', () => {
  it('respects a per-task daily allocation cap', () => {
    const result = computeSchedule(makeInput({
      tasks: [{
        id: 'paced',
        title: 'Paced task',
        estimated_minutes: 360,
        max_daily_minutes: 120,
        due_date: daysFromNow(6),
        priority: 'high',
        blocker_ids: [],
      }],
      prefs: { ...BASE_PREFS, work_days: [0, 1, 2, 3, 4, 5, 6] },
      horizon_days: 7,
    }));

    const allocations = result.day_assignments.filter(day => day.task_ids.includes('paced'));
    expect(result.tasks_fit).toContain('paced');
    expect(allocations).toHaveLength(3);
    expect(allocations.every(day => day.used_minutes <= 120)).toBe(true);
    expect(allocations.reduce((sum, day) => sum + day.used_minutes, 0)).toBe(360);
  });

  it('places a task larger than daily capacity across two days', () => {
    // 600-min task, 480-min/day → needs day 0 (480) + 120 min on day 1
    const result = computeSchedule(makeInput({
      tasks: [{ id: 'big', title: 'Big task', estimated_minutes: 600, due_date: daysFromNow(6), priority: 'high', blocker_ids: [] }],
      horizon_days: 7,
    }));
    expect(result.tasks_fit).toContain('big');
    expect(result.tasks_overflow).not.toContain('big');
    // Task must appear in at least two day_assignment entries
    const daysWithBig = result.day_assignments.filter(d => d.task_ids.includes('big'));
    expect(daysWithBig.length).toBeGreaterThanOrEqual(2);
    // Total capacity used across those days must equal 600
    const totalAllocated = daysWithBig.reduce((sum, d) => sum + d.used_minutes, 0);
    expect(totalAllocated).toBe(600);
  });

  it('overflows when a deadline does not allow enough days for splitting', () => {
    // 960-min task but due_date is today — only 480 min available today
    const result = computeSchedule(makeInput({
      tasks: [{ id: 'tight', title: 'Too big', estimated_minutes: 960, due_date: daysFromNow(0), priority: 'high', blocker_ids: [] }],
      horizon_days: 7,
    }));
    expect(result.tasks_overflow).toContain('tight');
    expect(result.tasks_fit).not.toContain('tight');
    expect(result.gap_minutes).toBeGreaterThan(0); // spare exists after the deadline
    expect(result.capacity_days).toHaveLength(7);
    expect(result.task_diagnostics.find(item => item.task_id === 'tight')).toMatchObject({
      outcome: 'overflow',
      required_minutes: 960,
      available_before_deadline_minutes: 480,
      allocated_minutes: 480,
      shortfall_minutes: 480,
    });
  });

  it('rolls back partial allocations for an overflowed task so other tasks can use that capacity', () => {
    // 'overflow' needs 960 min by day 0 (impossible) — it overflows and frees its capacity.
    // 'normal' needs only 60 min — it should still fit on day 0.
    const result = computeSchedule(makeInput({
      tasks: [
        { id: 'overflow', title: 'Too big', estimated_minutes: 960, due_date: daysFromNow(0), priority: 'high',   blocker_ids: [] },
        { id: 'normal',   title: 'Normal',  estimated_minutes: 60,  due_date: daysFromNow(6), priority: 'medium', blocker_ids: [] },
      ],
      horizon_days: 7,
    }));
    expect(result.tasks_overflow).toContain('overflow');
    expect(result.tasks_fit).toContain('normal');
    expect(result.day_assignments.some(day => day.task_ids.includes('overflow'))).toBe(true);
    expect(result.task_diagnostics.find(item => item.task_id === 'overflow')).toMatchObject({
      outcome: 'overflow',
      shortfall_minutes: 480,
      recovery_allocated_minutes: 960,
      recovery_finish_date: daysFromNow(2),
      unscheduled_minutes: 0,
    });
  });

  it('gives an overdue task a recovery plan while preserving its missed deadline', () => {
    const result = computeSchedule(makeInput({
      tasks: [{
        id: 'overdue-child', title: 'Large overdue child', estimated_minutes: 780,
        due_date: daysFromNow(-2), priority: 'high', blocker_ids: [],
      }],
      horizon_days: 3,
    }));

    expect(result.tasks_overflow).toContain('overdue-child');
    expect(result.day_assignments.map(day => day.task_minutes['overdue-child'] ?? 0)).toEqual([480, 300]);
    expect(result.task_diagnostics.find(item => item.task_id === 'overdue-child')).toMatchObject({
      due_date: daysFromNow(-2),
      available_before_deadline_minutes: 0,
      allocated_minutes: 0,
      shortfall_minutes: 780,
      recovery_allocated_minutes: 780,
      recovery_finish_date: daysFromNow(1),
      unscheduled_minutes: 0,
    });
  });

  it('blocked task is deferred past the completion day of a split blocker', () => {
    // blocker: 600 min (spans day 0 and day 1), blocked must start on day 1 or later
    const result = computeSchedule(makeInput({
      tasks: [
        { id: 'blocker', title: 'Blocker', estimated_minutes: 600, due_date: daysFromNow(6), priority: 'high', blocker_ids: [] },
        { id: 'blocked', title: 'Blocked', estimated_minutes: 60,  due_date: daysFromNow(6), priority: 'high', blocker_ids: ['blocker'] },
      ],
      horizon_days: 7,
    }));
    expect(result.tasks_fit).toContain('blocker');
    expect(result.tasks_fit).toContain('blocked');
    // The last day 'blocker' occupies must be <= the first day 'blocked' occupies
    const blockerDays = result.day_assignments.filter(d => d.task_ids.includes('blocker')).map(d => d.date).sort();
    const blockedDays = result.day_assignments.filter(d => d.task_ids.includes('blocked')).map(d => d.date).sort();
    const blockerLastDay = blockerDays.at(-1)!;
    const blockedFirstDay = blockedDays[0]!;
    expect(blockerLastDay <= blockedFirstDay).toBe(true);
  });
});

// ─── Empty inputs ─────────────────────────────────────────────────────────────

describe('computeSchedule — edge cases', () => {
  it('returns feasible with no tasks', () => {
    const result = computeSchedule({ tasks: [], meetings: [], prefs: BASE_PREFS, overrides: [], horizon_days: 7 });
    expect(result.status).toBe('feasible');
    expect(result.tasks_fit).toHaveLength(0);
    expect(result.total_required_minutes).toBe(0);
  });

  it('does not crash with horizon_days = 0', () => {
    const result = computeSchedule({
      tasks: [{ id: 't1', title: 'Task', estimated_minutes: 60, due_date: null, priority: 'medium', blocker_ids: [] }],
      meetings: [], prefs: BASE_PREFS, overrides: [], horizon_days: 0,
    });
    expect(result).toBeDefined();
  });
});
