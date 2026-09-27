import { describe, expect, it } from 'vitest';
import { mergeLiveTime, timeDate, timeDays, timeLevel, timeMonth, timeWindow, type TimeInterval, type TimeHeatmap } from '../timeHeatmap';

const session = (started_at: string, ended_at: string | null, minutes: number): TimeInterval => ({ id: 'session', started_at, ended_at, minutes });
describe('time matrix dates and truthful totals', () => {
  it('places the current month third and continues backward across years without duplicate months', () => {
    expect(timeWindow(2026, 8).map(month => month.key)).toEqual([
      '2026-07', '2026-08', '2026-09', '2026-04', '2026-05', '2026-06',
      '2026-01', '2026-02', '2026-03', '2025-10', '2025-11', '2025-12',
    ]);
    const january = timeWindow(2025, 0);
    expect(january.slice(0, 3).map(month => month.key)).toEqual(['2024-11', '2024-12', '2025-01']);
    const dates = january.flatMap(month => timeMonth(month.year, month.month).filter(Boolean));
    expect(dates).toHaveLength(366);
    expect(new Set(dates).size).toBe(366);
    expect(dates).toContain('2024-02-29');
  });
  it('shows all dates, including leap day, once and in Monday-first week columns', () => {
    const year = Array.from({ length: 12 }, (_, month) => timeMonth(2024, month).filter(Boolean)).flat();
    expect(year).toHaveLength(366); expect(new Set(year).size).toBe(366);
    expect(timeMonth(2026, 8).slice(0, 3)).toEqual([null, '2026-09-01', '2026-09-02']);
  });
  it('splits an overnight session on the workspace’s midnight while preserving corrected minutes', () => {
    expect(timeDays([session('2026-09-26T20:30:00Z', '2026-09-26T22:30:00Z', 60)], 2026, 'Asia/Beirut')).toEqual([
      { date: '2026-09-26', minutes: 15, sessions: 1 }, { date: '2026-09-27', minutes: 45, sessions: 1 },
    ]);
  });
  it('uses elapsed time across a midnight DST jump without losing or inventing minutes', () => {
    const days = timeDays([session('2026-03-28T21:00:00Z', '2026-03-29T00:00:00Z', 180)], 2026, 'Asia/Beirut');
    expect(days).toEqual([{ date: '2026-03-28', minutes: 60, sessions: 1 }, { date: '2026-03-29', minutes: 120, sessions: 1 }]);
  });
  it('handles a repeated local hour and clips sessions at the year boundary', () => {
    const dst = timeDays([session('2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', 1500)], 2026, 'America/New_York');
    expect(dst).toEqual([{ date: '2026-11-01', minutes: 1500, sessions: 1 }]);
    expect(timeDays([session('2025-12-31T21:30:00Z', '2025-12-31T22:30:00Z', 60)], 2026, 'Asia/Beirut')).toEqual([{ date: '2026-01-01', minutes: 30, sessions: 1 }]);
  });
  it('places a manual log without an end on its local date and ignores unknown durations', () => {
    expect(timeDays([session('2026-09-26T22:00:00Z', null, 35), { ...session('2026-09-26T22:00:00Z', null, 35), minutes: null }, session('bad', null, 20)], 2026, 'Asia/Beirut')).toEqual([{ date: '2026-09-27', minutes: 35, sessions: 1 }]);
    expect(timeDate(Date.parse('2026-09-26T22:00:00Z'), 'Asia/Beirut')).toBe('2026-09-27');
  });
  it('adds live time and stops counting it twice as soon as the same session is saved', () => {
    const data: TimeHeatmap = { year: 2026, timezone: 'Asia/Beirut', today: '2026-09-27', days: [{ date: '2026-09-27', minutes: 20, sessions: 1 }], loggedSessionIds: ['earlier'] };
    const timer = { sessionId: 'active', startedAt: '2026-09-27T09:00:00Z' };
    expect(mergeLiveTime(data, timer, Date.parse('2026-09-27T09:10:00Z')).get(data.today)).toMatchObject({ minutes: 30, sessions: 2, liveMinutes: 10 });
    expect(mergeLiveTime({ ...data, loggedSessionIds: ['active'] }, timer, Date.parse('2026-09-27T09:10:00Z')).get(data.today)).toMatchObject({ minutes: 20, sessions: 1, liveMinutes: 0 });
  });
  it('keeps a fixed intensity scale so one long day cannot recolor the entire year', () => {
    expect([0, 1, 59, 60, 120, 240, 360, 1500].map(timeLevel)).toEqual([0, 1, 1, 2, 3, 4, 5, 5]);
  });
});
