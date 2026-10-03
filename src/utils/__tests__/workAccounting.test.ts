import { describe, expect, it } from 'vitest';
import { getRolledUpActualTime, getTaskTimeProgress, formatTaskTime } from '../taskTime';
import type { DBTask } from '../../db/schema';
import { accountWork, accountReservations, validMinutes, type ReservationRow } from '../../../shared/workAccounting';

const forecast = { estimated_minutes: 60, logged_minutes: 70, work_version: 2, worklog_version: 3,
  remaining_forecast_minutes: 90, remaining_forecast_work_version: 2, remaining_forecast_log_version: 3 };
const window = { from: '2026-10-03', to: '2026-11-06', today: '2026-10-03', minute: 600 };
const link = (patch: Partial<ReservationRow> = {}): ReservationRow => ({ id: 'l', event_id: 'e', task_id: 't', planned_minutes: 90,
  work_version: 1, task_work_version: 1, date: '2026-10-04', start_hour: 10, duration_hours: 1.5, ...patch });

describe('P03.1 own-task accounting', () => {
  it('keeps UI remainder aligned with server accounting for legacy text and large estimates', () => {
    for (const estimate of [null, 120000]) {
      const task = { id: 'legacy', estimated_minutes: estimate, estimated_duration: '2 hours' } as DBTask;
      expect(getTaskTimeProgress(task, [task]).remainingMinutes).toBe(accountWork(task).remaining_minutes);
      const parent = { id: 'parent' } as DBTask;
      const child = { ...task, parent_task_id: parent.id };
      expect(getTaskTimeProgress(parent, [parent, child]).remainingMinutes).toBe(accountWork(child).remaining_minutes);
    }
  });
  it('makes legacy logged badges use authoritative sessions instead of a stale cache', () => {
    const task = { id: 't', actual_minutes: 0, logged_minutes: 80 } as DBTask;
    expect(getRolledUpActualTime(task, [task]).minutes).toBe(80);
  });
  it('does not silently cap a large forecast when displaying it', () => {
    expect(formatTaskTime(120000)).toBe('2000h');
  });
  it.each([[], {}, -1, Infinity])('does not reinterpret invalid reported time as no work: %s', value => {
    expect(accountWork({ estimated_minutes: 60, actual_minutes: value }).remaining_state).toBe('invalid');
  });
  it.each([60, 70, 100000])('keeps incomplete exhausted estimates unknown at %i logged minutes', logged_minutes => {
    expect(accountWork({ estimated_minutes: 60, logged_minutes })).toMatchObject({ remaining_minutes: null, unscheduled_minutes: null, remaining_state: 'overrun' });
  });
  it('reserves time without reducing remaining work', () => {
    expect(accountWork(forecast, 90)).toMatchObject({ remaining_minutes: 90, reserved_minutes: 90, unscheduled_minutes: 0, remaining_basis: 'forecast' });
  });
  it('keeps explicit zero different from completion and missing estimate', () => {
    expect(accountWork({ ...forecast, remaining_forecast_minutes: 0 })).toMatchObject({ remaining_minutes: 0, remaining_basis: 'forecast' });
    expect(accountWork({ estimated_minutes: 0 }).remaining_minutes).toBeNull();
    expect(accountWork({ completed: true }).remaining_basis).toBe('completed');
  });
  it.each([{ work_version: 3 }, { worklog_version: 4 }])('invalidates a forecast after underlying facts change: %o', change => {
    expect(accountWork({ ...forecast, ...change })).toMatchObject({ remaining_minutes: null, remaining_state: 'stale_forecast' });
  });
  it('does not add cached actual time to session totals', () => {
    expect(accountWork({ estimated_minutes: 90, logged_minutes: 20, actual_minutes: 20, session_count: 1 }).remaining_minutes).toBe(70);
    expect(accountWork({ estimated_minutes: 90, actual_minutes: 20 }).logged_basis).toBe('reported');
  });
  it.each([Infinity, NaN, -1, 0.5, 'oops', true, Number.MAX_SAFE_INTEGER])('rejects invalid minute value %s', value => {
    expect(validMinutes(value)).toBeNull();
    expect(accountWork({ estimated_minutes: value }).remaining_state).toBe('invalid');
  });
  it('does not convert a missing forecast into explicit zero', () => {
    expect(validMinutes(null)).toBeNull();
    expect(accountWork({ estimated_minutes: 60 }).remaining_minutes).toBe(60);
  });
});

describe('P03.1 reservations', () => {
  it('deduplicates joined rows without multiplying reservations', () => {
    expect(accountReservations([link(), link(), link()], window).get('t')).toEqual({ minutes: 90, stale: 0 });
  });
  it.each([{ canceled: true }, { date: '2026-10-02' }, { date: '2026-11-07' }, { date: '2026-10-03', start_hour: 8 }])('ignores canceled, expired or out-of-window bookings: %o', patch => {
    expect(accountReservations([link(patch)], window).size).toBe(0);
  });
  it('credits only the future part of an in-progress reservation', () => {
    expect(accountReservations([link({ date: '2026-10-03', start_hour: 9 })], window).get('t')?.minutes).toBe(30);
  });
  it('flags an overnight block for review rather than crediting time beyond a date cutoff', () => {
    expect(accountReservations([link({ start_hour: 23 })], window).get('t')).toEqual({ minutes: 0, stale: 1 });
  });
  it('never credits a parent booking to a child', () => {
    const result = accountReservations([link({ task_id: 'parent' })], window);
    expect(result.get('parent')?.minutes).toBe(90); expect(result.has('child')).toBe(false);
  });
  it('exposes stale scope versions without credit', () => {
    expect(accountReservations([link({ task_work_version: 2 })], window).get('t')).toEqual({ minutes: 0, stale: 1 });
  });
  it.each([{ eligible_from: '2026-10-05' }, { eligible_to: '2026-10-03' }])('rejects credit outside the task dates: %o', patch => {
    expect(accountReservations([link(patch)], window).get('t')).toEqual({ minutes: 0, stale: 1 });
  });
  it('does not invent allocations for multiple tasks in a shared block', () => {
    const result = accountReservations([link({ planned_minutes: null }), link({ id: 'b', task_id: 'b', planned_minutes: null })], window);
    expect([...result.values()]).toEqual([{ minutes: 0, stale: 1 }, { minutes: 0, stale: 1 }]);
  });
  it('rejects overallocated shared blocks but permits explicit disjoint shares', () => {
    expect(accountReservations([link(), link({ id: 'b', task_id: 'b' })], window).get('t')?.stale).toBe(1);
    const result = accountReservations([link({ planned_minutes: 30 }), link({ id: 'b', task_id: 'b', planned_minutes: 60 })], window);
    expect([...result.values()].reduce((s, row) => s + row.minutes, 0)).toBe(90);
  });
  it('handles 100,000 joined link rows with duplicates and remains order independent', () => {
    const rows = Array.from({ length: 100_000 }, (_, i) => link({ id: `l${Math.floor(i / 2)}`, event_id: `e${Math.floor(i / 2)}`, task_id: `t${Math.floor(i / 2) % 1000}`, planned_minutes: 30 }));
    const result = accountReservations(rows, window);
    expect(result.size).toBe(1000);
    expect([...result.values()].every(row => row.minutes === 1500 && row.stale === 0)).toBe(true);
    expect(accountReservations(rows.reverse(), window)).toEqual(result);
  }, 10_000);
});
