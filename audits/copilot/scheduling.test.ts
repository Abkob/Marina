import { describe, expect, it } from 'vitest';
import { computeSchedule, type SchedulerInput, type SchedulerTask } from '../../server/services/scheduler';
import { addDaysStr, dateToWeekPosServer, eventDateServer, layoutPlan } from '../../server/services/planLayout';

const day = '2026-10-05';
const task = (id: string, minutes: number, extra: Partial<SchedulerTask> = {}): SchedulerTask => ({ id, title: id, estimated_minutes: minutes, due_date: null, priority: 'medium', blocker_ids: [], ...extra });
const input = (tasks: SchedulerTask[], extra: Partial<SchedulerInput> = {}): SchedulerInput => ({ tasks, meetings: [], prefs: { work_days: [0, 1, 2, 3, 4, 5, 6], daily_capacity_minutes: 120, buffer_ratio: 0 }, overrides: [], horizon_days: 3, start_date: day, ...extra });
function random(seed: number) { let state = seed >>> 0; return (max: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; }; }

describe('Deterministic scheduler stress: 80 reproducible workloads', () => {
  it.each(Array.from({ length: 80 }, (_, i) => i + 1))('seed %i conserves work and never overbooks day or per-task capacity', seed => {
    const rnd = random(seed);
    const tasks = Array.from({ length: 25 }, (_, i) => task(`task-${i}`, rnd(13) * 15, {
      has_estimate: i % 7 === 0,
      due_date: i % 4 === 0 ? null : addDaysStr(day, rnd(9) - 2),
      start_date: addDaysStr(day, rnd(4)),
      max_daily_minutes: 15 + rnd(8) * 15,
      priority: ['high', 'medium', 'low'][rnd(3)],
    }));
    const data = input(tasks, { horizon_days: 7, meetings: [{ date: day, duration_minutes: rnd(12) * 15 }], overrides: [{ date: addDaysStr(day, 2), available_minutes: rnd(10) * 15 }] });
    const before = JSON.stringify(data);
    const result = computeSchedule(data);
    expect(JSON.stringify(data)).toBe(before);
    expect(computeSchedule(data)).toEqual(result);
    const allocated = new Map<string, number>();
    for (const date of result.capacity_days) {
      expect(date.used_minutes).toBeGreaterThanOrEqual(0);
      expect(date.used_minutes).toBeLessThanOrEqual(date.available_minutes);
      expect(Object.values(date.task_minutes).reduce((a, b) => a + b, 0)).toBe(date.used_minutes);
      for (const [id, minutes] of Object.entries(date.task_minutes)) {
        const original = tasks.find(t => t.id === id)!;
        expect(date.date >= original.start_date!).toBe(true);
        expect(minutes).toBeLessThanOrEqual(original.max_daily_minutes!);
        allocated.set(id, (allocated.get(id) ?? 0) + minutes);
      }
    }
    for (const item of tasks) {
      const amount = allocated.get(item.id) ?? 0;
      expect(amount).toBeLessThanOrEqual(item.estimated_minutes);
      if (result.tasks_fit.includes(item.id)) {
        expect(amount).toBe(item.estimated_minutes);
        if (item.due_date) for (const d of result.day_assignments.filter(d => d.task_ids.includes(item.id))) expect(d.date <= item.due_date).toBe(true);
      }
      if (result.tasks_overflow.includes(item.id)) {
        const diagnostic = result.task_diagnostics.find(d => d.task_id === item.id)!;
        expect(amount + diagnostic.unscheduled_minutes).toBe(item.estimated_minutes);
      }
    }
  });
});

describe('Known dependency gaps: desired assertions currently fail', () => {
  it.fails('PLAN-01 never marks a dependent task feasible while its blocker cannot finish', () => {
    const result = computeSchedule(input([
      task('prerequisite', 1000, { due_date: day }),
      task('dependent', 30, { blocker_ids: ['prerequisite'], due_date: day }),
    ], { horizon_days: 1 }));
    expect(result.tasks_overflow).toContain('prerequisite');
    expect(result.tasks_fit).not.toContain('dependent');
  });
  it.fails('PLAN-02 excludes a dependency cycle from the feasible set', () => {
    const result = computeSchedule(input([task('A', 30, { blocker_ids: ['B'] }), task('B', 30, { blocker_ids: ['A'] })]));
    expect(result.cycle_task_ids).toEqual(expect.arrayContaining(['A', 'B']));
    expect(result.tasks_fit).toEqual([]);
  });
});

describe('Hour layout stress: 40 reproducible fragmented calendars', () => {
  it.each(Array.from({ length: 40 }, (_, i) => 101 + i))('seed %i preserves minutes and avoids every busy interval', seed => {
    const rnd = random(seed);
    const busy = Array.from({ length: 12 }, () => {
      const start = 8 + rnd(32) / 4;
      return { date: day, start_hour: start, end_hour: start + (1 + rnd(8)) / 4 };
    });
    const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, title: `t${i}`, remaining_minutes: 15 + rnd(8) * 15 }));
    const result = layoutPlan({ dayAssignments: [{ date: day, task_ids: tasks.map(t => t.id) }], tasks, busy, workStart: 8, workEnd: 18 });
    const sorted = [...result.blocks].sort((a, b) => a.start_hour - b.start_hour);
    for (const [i, block] of sorted.entries()) {
      expect(block.start_hour).toBeGreaterThanOrEqual(8);
      expect(block.start_hour + block.duration_hours).toBeLessThanOrEqual(18.000001);
      expect(block.planned_minutes).toBeGreaterThan(0);
      if (i) expect(sorted[i - 1].start_hour + sorted[i - 1].duration_hours).toBeLessThanOrEqual(block.start_hour + 0.000001);
      for (const b of busy) expect(block.start_hour + block.duration_hours <= b.start_hour + 0.000001 || block.start_hour >= b.end_hour - 0.000001).toBe(true);
    }
    for (const t of tasks) {
      const placed = result.blocks.filter(b => b.task_id === t.id).reduce((sum, b) => sum + b.planned_minutes, 0);
      expect(placed + (result.unplaced.find(u => u.task_id === t.id)?.minutes ?? 0)).toBe(t.remaining_minutes);
    }
  });
});

describe('Calendar boundary contracts (date arithmetic, not timezone conversion)', () => {
  it.each(['2026-10-24', '2026-10-25', '2026-03-29', '2026-12-31', '2028-02-29', '2027-01-01'])('round-trips calendar/week identity for %s', date => {
    const position = dateToWeekPosServer(date);
    expect(eventDateServer(position.week_start, position.day_index)).toBe(date);
    expect(addDaysStr(addDaysStr(date, 1), -1)).toBe(date);
  });
  it('keeps routine reservations when manual available capacity is overridden', () => {
    const result = computeSchedule(input([task('study', 120)], { horizon_days: 1, overrides: [{ date: day, available_minutes: 90 }], meetings: [{ date: day, duration_minutes: 60, routine: true }] }));
    expect(result.capacity_days[0].available_minutes).toBe(30);
    expect(result.tasks_overflow).toContain('study');
  });
  it('keeps an overdue task explicit while allocating only future recovery time', () => {
    const result = computeSchedule(input([task('overdue', 60, { due_date: '2026-10-01' })]));
    expect(result.tasks_overflow).toContain('overdue');
    expect(result.task_diagnostics[0]).toMatchObject({ recovery_allocated_minutes: 60, unscheduled_minutes: 0 });
    expect(result.day_assignments.every(d => d.date >= day)).toBe(true);
  });
});
