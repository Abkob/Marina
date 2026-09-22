import { describe, expect, it } from 'vitest';
import type { DBRoutine, DBRoutineEntry } from '../../types/routines';
import { addRoutineDays, isRoutineDate, routineEligibleOn, routineProgress, routineReservations, routineWeekStart } from '../routines';

const routine: DBRoutine = {
  id: 'routine', title: 'Revision', note: '', goal_id: null, cadence: 'daily', weekdays: [1, 2, 3, 4, 5],
  weekly_target: 3, target_count: 20, target_unit: 'minutes', planned_minutes: 20, preferred_time: null,
  start_date: '2026-09-21', archived_at: null, created_at: '', updated_at: '',
};
const entry = (date: string, status: DBRoutineEntry['status'], minutes = 0): DBRoutineEntry => ({
  id: date, routine_id: routine.id, date, status, minutes, completed_count: status === 'completed' ? 20 : 0, notes: '', created_at: '', updated_at: '',
});

describe('date-only routine calendars', () => {
  it('rejects impossible dates rather than rolling them into another month', () => {
    expect(isRoutineDate('2026-02-29')).toBe(false);
    expect(isRoutineDate('2028-02-29')).toBe(true);
    expect(isRoutineDate('2026-09-22T00:00:00')).toBe(false);
  });
  it('uses Monday weeks across year boundaries and DST transitions', () => {
    expect(routineWeekStart('2027-01-01')).toBe('2026-12-28');
    expect(routineWeekStart('2026-09-27')).toBe('2026-09-21');
    expect(addRoutineDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addRoutineDays('2026-03-29', 1)).toBe('2026-03-30');
  });
  it('does not invent missed days before creation, on off days, or after archiving', () => {
    expect(routineEligibleOn(routine, '2026-09-18')).toBe(false);
    expect(routineEligibleOn(routine, '2026-09-26')).toBe(false);
    expect(routineEligibleOn(routine, '2026-09-22')).toBe(true);
    expect(routineEligibleOn({ ...routine, archived_at: '2026-09-23T12:00:00Z' }, '2026-09-23')).toBe(false);
    expect(routineProgress(routine, [], '2026-09-22').status).toBe('pending');
  });
});

describe('routine reservations without overdue piles', () => {
  it('only reserves current/future daily occurrences and drops skipped dates', () => {
    const result = routineReservations([routine], [entry('2026-09-23', 'skipped')], '2026-09-21', '2026-09-27', '2026-09-22');
    expect(result.map(item => item.date)).toEqual(['2026-09-22', '2026-09-24', '2026-09-25']);
    expect(result.reduce((sum, item) => sum + item.minutes, 0)).toBe(60);
  });
  it('reserves completed and partial time once, using actual time if over budget', () => {
    const result = routineReservations([routine], [entry('2026-09-22', 'completed', 30), entry('2026-09-23', 'partial', 5)], '2026-09-22', '2026-09-23', '2026-09-22');
    expect(result.map(item => item.minutes)).toEqual([30, 20]);
  });
  it('skipping after focus frees only the unused budget, for daily and weekly routines', () => {
    for (const cadence of ['daily', 'weekly'] as const) {
      const result = routineReservations([{ ...routine, cadence, weekly_target: 1 }], [entry('2026-09-22', 'skipped', 8)], '2026-09-22', '2026-09-22', '2026-09-22');
      expect(result.map(item => item.minutes)).toEqual([8]);
    }
  });
  it('archiving preserves today’s completed or worked time but releases unused time', () => {
    const archived = { ...routine, archived_at: '2026-09-21T22:30:00Z', archived_on: '2026-09-23' };
    expect(routineEligibleOn(archived, '2026-09-22')).toBe(true);
    expect(routineEligibleOn(archived, '2026-09-23')).toBe(false);
    expect(routineReservations([archived], [], '2026-09-22', '2026-09-24', '2026-09-22')).toEqual([]);
    expect(routineReservations([archived], [entry('2026-09-22', 'partial', 8)], '2026-09-22', '2026-09-24', '2026-09-22').map(item => item.minutes)).toEqual([8]);
    expect(routineReservations([archived], [entry('2026-09-22', 'completed')], '2026-09-22', '2026-09-24', '2026-09-22').map(item => item.minutes)).toEqual([20]);
  });
  it('uses completed sessions outside the visible range to reduce a weekly target', () => {
    const weekly = { ...routine, cadence: 'weekly' as const };
    const result = routineReservations([weekly], [entry('2026-09-21', 'completed'), entry('2026-09-22', 'completed')], '2026-09-23', '2026-09-27', '2026-09-23');
    expect(result.map(item => item.date)).toEqual(['2026-09-23']);
    expect(routineProgress(weekly, [entry('2026-09-21', 'completed')], '2026-09-23').remainingThisWeek).toBe(2);
  });
  it('does not move reservations into view just because earlier days are outside the view', () => {
    const weekly = { ...routine, cadence: 'weekly' as const, weekly_target: 2 };
    expect(routineReservations([weekly], [], '2026-09-24', '2026-09-25', '2026-09-21')).toEqual([]);
  });
  it('prioritizes partial sessions and never reserves the same date twice', () => {
    const weekly = { ...routine, cadence: 'weekly' as const, weekly_target: 2 };
    const result = routineReservations([weekly], [entry('2026-09-24', 'partial', 30)], '2026-09-22', '2026-09-25', '2026-09-22');
    expect(result.map(item => [item.date, item.minutes])).toEqual([['2026-09-22', 20], ['2026-09-24', 30]]);
  });
  it('starts a fresh week instead of carrying missed sessions forward', () => {
    const weekly = { ...routine, cadence: 'weekly' as const, weekly_target: 2 };
    const result = routineReservations([weekly], [], '2026-09-28', '2026-10-04', '2026-09-28');
    expect(result).toHaveLength(2);
    expect(result[0].date).toBe('2026-09-28');
    expect(routineProgress(weekly, [entry('2026-09-21', 'completed')], '2026-09-28').weekCompleted).toBe(0);
  });
  it('respects start dates in the middle of a week and returns no archived future work', () => {
    const weekly = { ...routine, cadence: 'weekly' as const, start_date: '2026-09-24' };
    expect(routineReservations([weekly], [], '2026-09-21', '2026-09-27', '2026-09-21').map(item => item.date)).toEqual(['2026-09-24', '2026-09-25']);
    expect(routineReservations([{ ...weekly, archived_at: '2026-09-24T12:00:00Z' }], [], '2026-09-24', '2026-09-27', '2026-09-24')).toEqual([]);
  });
  it('keeps explicit archived history readable and does not count duplicate entry input twice', () => {
    const weekly = { ...routine, cadence: 'weekly' as const, archived_at: '2026-09-23T12:00:00Z' };
    const history = [entry('2026-09-22', 'completed'), entry('2026-09-22', 'completed')];
    const progress = routineProgress(weekly, history, '2026-09-22');
    expect(progress.status).toBe('completed');
    expect(progress.weekCompleted).toBe(1);
  });
});
