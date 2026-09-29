import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DBRoutine, DBRoutineEntry } from '../../types/routines';
import { parseRoutineDuration, routineForDate, routineProgress, routineReservations, routineSchedule } from '../routines';
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../../server/db.js', () => ({ query: db.query, transaction: async (fn: Function) => fn({ query: db.query }) }));
import { logRoutineSession, rescheduleRoutine, routineScheduleSchema } from '../../../server/services/routines';
const old: DBRoutine = { id: '11111111-1111-4111-8111-111111111111', title: 'Review', note: '', goal_id: null, cadence: 'daily', weekdays: [1, 2, 3, 4, 5], weekly_target: 5, target_count: 20, target_unit: 'minutes', planned_minutes: 20, preferred_time: '09:00', start_date: '2026-09-01', archived_at: null, created_at: '', updated_at: '2026-09-22T08:00:00Z' };
const revised: DBRoutine = { ...old, weekdays: [1, 3, 5], planned_minutes: 60, target_count: 60, weekly_target: 3, preferred_time: '10:00', schedule_history: [{ ...routineSchedule(old), before: '2026-09-28' }] };
beforeEach(() => { db.query.mockReset(); });

describe('time inputs and dated repeat plans', () => {
  it('accepts typed hours or minutes and rejects malformed or fractional-minute budgets', () => {
    for (const [input, minutes] of [['45', 45], ['45 min', 45], ['1.5h', 90], ['1h 30m', 90], ['24h', 1440]] as const) expect(parseRoutineDuration(input)).toBe(minutes);
    for (const input of ['', '0', '-30', '25h', '1.234h', '1:30', 'NaN']) expect(parseRoutineDuration(input)).toBeNull();
  });
  it('keeps old days, duration, and time until the edit boundary', () => {
    expect(routineForDate(revised, '2026-09-25')).toMatchObject({ weekdays: old.weekdays, planned_minutes: 20, preferred_time: '09:00' });
    expect(routineForDate(revised, '2026-09-28')).toMatchObject({ weekdays: [1, 3, 5], planned_minutes: 60 });
    const reservations = routineReservations([revised], [], '2026-09-25', '2026-10-02', '2026-09-25');
    expect(reservations.map(r => [r.date, r.minutes, r.preferred_time])).toEqual([['2026-09-25', 20, '09:00'], ['2026-09-28', 60, '10:00'], ['2026-09-30', 60, '10:00'], ['2026-10-02', 60, '10:00']]);
  });
  it('preserves historical weekly budgets and counts actual minutes once', () => {
    const entry = { routine_id: old.id, date: '2026-09-22', minutes: 12, status: 'completed' } as DBRoutineEntry;
    expect(routineProgress(revised, [entry, entry], '2026-09-22')).toMatchObject({ weekMinutes: 12, weekPlannedMinutes: 100, weekCompleted: 1 });
    expect(routineProgress(revised, [], '2026-09-28')).toMatchObject({ weekMinutes: 0, weekPlannedMinutes: 180 });
  });
  it('supports changes between fixed days and flexible weekly sessions', () => {
    const flexible = { ...revised, cadence: 'weekly' as const, weekly_target: 2 };
    expect(routineReservations([flexible], [], '2026-09-25', '2026-10-02', '2026-09-25').map(r => r.date)).toEqual(['2026-09-25', '2026-09-28', '2026-09-30']);
  });
});

describe('safe repeat schedule editing', () => {
  const input = { ...routineSchedule(revised), effective_from: '2026-09-28', expected_updated_at: old.updated_at };
  function setup(routine = old) {
    // Schedule timezone uses the real date; pick a future Monday independent of the test clock.
    db.query.mockResolvedValueOnce({ rows: [{ timezone: 'UTC' }] }).mockResolvedValueOnce({ rows: [routine] }).mockResolvedValueOnce({ rows: [revised] });
  }
  it('validates time-only budgets, frequencies and midnight boundaries on the server', () => {
    expect(routineScheduleSchema.safeParse(input).success).toBe(true);
    for (const changes of [{ target_unit: 'pages' }, { planned_minutes: 90 }, { cadence: 'weekly', weekly_target: 4 }, { preferred_time: '23:45' }]) expect(routineScheduleSchema.safeParse({ ...input, ...changes }).success).toBe(false);
  });
  it('atomically adds a history boundary without rewriting entries or changing the routine ID', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    try {
      setup(); await rescheduleRoutine(old.id, input);
      const [sql, values] = db.query.mock.calls[2];
      expect(sql).toContain('UPDATE routines'); expect(values[0]).toBe(old.id);
      expect(JSON.parse(values[6])).toEqual([{ ...routineSchedule(old), before: '2026-09-28' }]);
      expect(db.query.mock.calls.some(([query]) => /UPDATE (routine_entries|work_sessions)|DELETE/.test(query))).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('rejects retroactive edits, a midweek boundary and stale device writes', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    try {
      for (const effective_from of ['2026-09-21', '2026-09-29']) { db.query.mockReset().mockResolvedValue({ rows: [{ timezone: 'UTC' }] }); await expect(rescheduleRoutine(old.id, { ...input, effective_from })).rejects.toMatchObject({ status: 400 }); }
      db.query.mockReset(); setup({ ...old, updated_at: 'newer' });
      await expect(rescheduleRoutine(old.id, input)).rejects.toMatchObject({ status: 409 }); expect(db.query).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('replaces a pending edit without losing the schedule currently in effect', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    try { setup(revised); await rescheduleRoutine(old.id, input); expect(JSON.parse(db.query.mock.calls[2][1][6])).toEqual([{ ...routineSchedule(old), before: '2026-09-28' }]); } finally { vi.useRealTimers(); }
  });
  it('finishes an older timer using its original day and duration target', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
    try {
      db.query.mockResolvedValueOnce({ rows: [{ timezone: 'UTC' }] }).mockResolvedValueOnce({ rows: [revised] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ status: 'completed', minutes: 20 }] });
      await logRoutineSession(old.id, { id: '22222222-2222-4222-8222-222222222222', date: '2026-09-22', started_at: '2026-09-22T10:00:00Z', ended_at: '2026-09-22T10:20:00Z', minutes: 20 });
      expect(db.query.mock.calls[5][1][3]).toBe('completed');
    } finally { vi.useRealTimers(); }
  });
});
