import { describe, expect, it } from 'vitest';
import { calendarEventRange, calendarInstant } from '../calendarTime';
import { accountedTime, mergeLiveTime, type TimeCalendar, type TimeSources, type TimeWork } from '../timeHeatmap';

const instant = (clock: string) => Date.parse(`2026-09-27T${clock}:00Z`);
const block = (start = '09:00', end = '11:00', extra: Partial<TimeCalendar> = {}): TimeCalendar => ({
  id: 'event', title: 'Study', start: instant(start), end: instant(end),
  allocations: [{ taskId: 'quiz', taskTitle: 'Quiz 1', goalId: 'bio', goalTitle: 'Biology', weight: 1 }], ...extra,
});
const log = (start = '09:00', end: string | null = '10:00', minutes = 60, extra: Partial<TimeWork> = {}): TimeWork => ({
  id: 'log', started_at: new Date(instant(start)).toISOString(), ended_at: end ? new Date(instant(end)).toISOString() : null,
  minutes, taskId: 'quiz', taskTitle: 'Quiz 1', ...extra,
});
const sources = (calendar: TimeCalendar[] = [block()], work: TimeWork[] = []): TimeSources => ({ calendar, work, tasks: { quiz: { taskId: 'quiz', taskTitle: 'Quiz 1', goalId: 'bio', goalTitle: 'Biology' } } });
const day = (data = sources(), now = instant('12:00')) => accountedTime(data, 2026, 'UTC', now).get('2026-09-27');

describe('elapsed calendar accounting', () => {
  it('counts only elapsed minutes and assigns linked tasks or Miscellaneous', () => {
    expect(day(sources(), instant('08:00'))).toBeUndefined();
    expect(day(sources(), instant('09:30'))).toMatchObject({ minutes: 30, calendarMinutes: 30, sessions: 0 });
    expect(day()?.details?.[0]).toMatchObject({ title: 'Study', taskId: 'quiz', goalId: 'bio', minutes: 120 });
    expect(day(sources([block('09:00', '11:00', { allocations: [] })]))?.details?.[0]).toMatchObject({ source: 'calendar', minutes: 120 });
    expect(day(sources([block('09:00', '11:00', { allocations: [] })]))?.details?.[0].taskId).toBeUndefined();
  });
  it('fills only time not covered by logs, including partially corrected durations', () => {
    expect(day(sources([block()], [log()]))).toMatchObject({ minutes: 120, calendarMinutes: 60, sessions: 1 });
    expect(day(sources([block()], [log('08:30', '09:30', 60)]))).toMatchObject({ minutes: 150, calendarMinutes: 90 });
    expect(day(sources([block()], [log('09:00', '11:00', 30)]))).toMatchObject({ minutes: 120, calendarMinutes: 90 });
    // Larger corrected totals stay authoritative and cannot create negative credit.
    expect(day(sources([block()], [log('09:00', '11:00', 150)]))).toMatchObject({ minutes: 150, calendarMinutes: 0 });
  });
  it('shares overlapping calendar minutes once and apportions linked tasks without multiplying hours', () => {
    const result = day(sources([block(), block('10:00', '12:00', { id: 'other', title: 'Other', allocations: [] })]));
    expect(result).toMatchObject({ minutes: 180, calendarMinutes: 180 });
    expect(result?.details?.map(row => row.minutes)).toEqual([90, 90]);
    const multi = day(sources([block('09:00', '11:00', { allocations: [{ taskId: 'a', weight: 30 }, { taskId: 'b', weight: 90 }, { taskId: 'zero', weight: 0 }] })]));
    expect(multi?.details?.map(row => [row.taskId, row.minutes])).toEqual([['b', 90], ['a', 30]]);
    expect(multi?.minutes).toBe(120);
  });
  it('deducts untimed manual logs only from matching tasks on the same local date, once', () => {
    const result = day(sources([block(), block('12:00', '13:00', { id: 'later' })], [log('07:00', null, 90)]), instant('14:00'));
    expect(result).toMatchObject({ minutes: 180, calendarMinutes: 90 });
    expect(day(sources([block()], [log('07:00', null, 90, { taskId: 'different' })]))).toMatchObject({ minutes: 210, calendarMinutes: 120 });
    const previousDay = { ...log('07:00', null, 90), started_at: '2026-09-26T07:00:00Z' };
    expect(day(sources([block()], [previousDay]))).toMatchObject({ minutes: 120, calendarMinutes: 120 });
  });
  it('replaces calendar credit with live work and stays stable when that timer is saved', () => {
    const input = sources();
    const data = { year: 2026, timezone: 'UTC', today: '2026-09-27', days: [], loggedSessionIds: [], sources: input };
    const timer = { sessionId: 'timer', startedAt: new Date(instant('09:30')).toISOString(), taskId: 'quiz' };
    const before = mergeLiveTime(data, timer, instant('10:00')).get(data.today)!;
    expect(before).toMatchObject({ minutes: 60, calendarMinutes: 30, liveMinutes: 30 });
    expect(before.details?.find(row => row.source === 'work')).toMatchObject({ taskId: 'quiz', goalTitle: 'Biology' });
    const saved = { ...data, sources: { ...input, work: [log('09:30', '10:00', 30, { id: 'timer' })] } };
    expect(mergeLiveTime(saved, timer, instant('10:00')).get(data.today)).toMatchObject({ minutes: 60, calendarMinutes: 30, liveMinutes: 0, sessions: 1 });
  });
  it('splits overnight and year-crossing blocks in the workspace timezone', () => {
    const overnight = { ...block(), start: Date.parse('2025-12-31T21:30:00Z'), end: Date.parse('2025-12-31T23:30:00Z') };
    expect(accountedTime(sources([overnight]), 2026, 'Asia/Beirut', Date.parse('2026-01-02')).get('2026-01-01')).toMatchObject({ minutes: 90 });
  });
  it('recalculates moves, removals and link changes from the current calendar', () => {
    expect(day(sources([block('13:00', '14:00')]))).toBeUndefined();
    expect(day(sources([]))).toBeUndefined();
    expect(day(sources([block('09:00', '11:00', { allocations: [{ goalId: 'goal', goalTitle: 'Goal', weight: 1 }] })]))?.details?.[0]).toMatchObject({ goalId: 'goal', minutes: 120 });
  });
});

describe('calendar wall time', () => {
  it('normalizes off-Monday dates, fractional hours, overnight events and ignores undated blocks', () => {
    expect(calendarEventRange({ week_start: '2026-09-23', day_index: 6, start_hour: 23.5, duration_hours: 2 }, 'Asia/Beirut')).toEqual({ start: Date.parse('2026-09-27T20:30:00Z'), end: Date.parse('2026-09-27T22:30:00Z') });
    expect(calendarEventRange({ week_start: null, day_index: 0, start_hour: 9, duration_hours: 2 }, 'UTC')).toBeNull();
    expect(calendarInstant('invalid', 9, 'UTC')).toBeNaN();
  });
  it('uses deterministic DST disambiguation and actual elapsed duration across transitions', () => {
    expect(calendarInstant('2026-03-29', 0.5, 'Asia/Beirut')).toBe(Date.parse('2026-03-28T22:30:00Z'));
    expect(calendarInstant('2026-11-01', 1.5, 'America/New_York')).toBe(Date.parse('2026-11-01T05:30:00Z'));
    const range = calendarEventRange({ week_start: '2026-10-26', day_index: 6, start_hour: 0, duration_hours: 3 }, 'America/New_York')!;
    expect((range.end - range.start) / 60_000).toBe(240);
  });
});
