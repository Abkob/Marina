import { addRoutineDays } from './routines.js';

export type TimeDay = { date: string; minutes: number; sessions: number };
export type TimeInterval = { id: string; started_at: string; ended_at: string | null; minutes: number | null };
export type TimeHeatmap = { year: number; timezone: string; today: string; days: TimeDay[]; loggedSessionIds: string[] };

export function timeDate(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(timestamp);
}

/** Find the first instant of a local date, including midnight DST changes. */
function dateBoundary(date: string, formatter: Intl.DateTimeFormat): number {
  const utc = Date.parse(`${date}T00:00:00Z`);
  let low = utc - 36 * 3_600_000;
  let high = utc + 36 * 3_600_000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (formatter.format(mid) < date) low = mid;
    else high = mid;
  }
  return high;
}

/** Allocate saved minutes across local days, preserving corrected durations. */
export function timeDays(intervals: TimeInterval[], year: number, timezone: string): TimeDay[] {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const boundaries = new Map<string, number>();
  const boundary = (date: string) => {
    if (!boundaries.has(date)) boundaries.set(date, dateBoundary(date, formatter));
    return boundaries.get(date)!;
  };
  const first = `${year}-01-01`;
  const last = `${year + 1}-01-01`;
  const days = new Map<string, TimeDay>();
  const add = (date: string, minutes: number) => {
    if (date < first || date >= last || minutes <= 0) return;
    const day = days.get(date) ?? { date, minutes: 0, sessions: 0 };
    day.minutes += minutes; day.sessions += 1; days.set(date, day);
  };
  for (const session of intervals) {
    const start = Date.parse(session.started_at);
    const end = session.ended_at ? Date.parse(session.ended_at) : NaN;
    const minutes = Number(session.minutes);
    if (!Number.isFinite(start) || !Number.isFinite(minutes) || minutes <= 0) continue;
    if (!Number.isFinite(end) || end <= start) { add(formatter.format(start), minutes); continue; }
    let cursor = Math.max(start, boundary(first));
    const stop = Math.min(end, boundary(last));
    while (cursor < stop) {
      const date = formatter.format(cursor);
      const next = Math.min(stop, boundary(addRoutineDays(date, 1)));
      if (next <= cursor) break;
      add(date, minutes * (next - cursor) / (end - start));
      cursor = next;
    }
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function mergeLiveTime(data: TimeHeatmap, timer: { sessionId: string; startedAt: string } | null, now: number) {
  const days = new Map(data.days.map(day => [day.date, { ...day, liveMinutes: 0 }]));
  if (timer && !data.loggedSessionIds.includes(timer.sessionId)) {
    for (const live of timeDays([{ id: timer.sessionId, started_at: timer.startedAt, ended_at: new Date(now).toISOString(), minutes: Math.max(0, now - Date.parse(timer.startedAt)) / 60_000 }], data.year, data.timezone)) {
      const day = days.get(live.date) ?? { date: live.date, minutes: 0, sessions: 0, liveMinutes: 0 };
      day.minutes += live.minutes; day.sessions += 1; day.liveMinutes = live.minutes; days.set(live.date, day);
    }
  }
  return days;
}

export function timeLevel(minutes: number) {
  return minutes <= 0 ? 0 : minutes < 60 ? 1 : minutes < 120 ? 2 : minutes < 240 ? 3 : minutes < 360 ? 4 : 5;
}

export function timeLabel(minutes: number) {
  if (minutes <= 0) return 'No time logged';
  if (minutes < 1) return 'Less than a minute';
  const rounded = Math.floor(minutes + 1e-7);
  const hours = Math.floor(rounded / 60);
  return hours ? `${hours}h${rounded % 60 ? ` ${rounded % 60}m` : ''}` : `${rounded}m`;
}

/** Monday-first, week columns × weekday rows, with room for six weeks. */
export function timeMonth(year: number, month: number): (string | null)[] {
  const start = new Date(Date.UTC(year, month, 1));
  const offset = (start.getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Array.from({ length: 42 }, (_, slot) => {
    const day = slot - offset + 1;
    return day < 1 || day > length ? null : `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  });
}
