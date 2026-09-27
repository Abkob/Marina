import { addRoutineDays } from './routines.js';

export type TimeCategory = { taskId?: string | null; taskTitle?: string | null; goalId?: string | null; goalTitle?: string | null };
export type TimeDetail = TimeCategory & { key: string; title: string; source: 'work' | 'calendar'; minutes: number };
export type TimeDay = { date: string; minutes: number; sessions: number; calendarMinutes?: number; details?: TimeDetail[] };
export type TimeInterval = { id: string; started_at: string; ended_at: string | null; minutes: number | null };
export type TimeWork = TimeInterval & TimeCategory;
export type TimeCalendar = { id: string; title: string; start: number; end: number; allocations: (TimeCategory & { weight: number })[] };
export type TimeSources = { work: TimeWork[]; calendar: TimeCalendar[]; tasks: Record<string, TimeCategory> };
export type TimeHeatmap = { year: number; timezone: string; today: string; days: TimeDay[]; loggedSessionIds: string[]; sources?: TimeSources };
export type TimeLiveTimer = { sessionId: string; startedAt: string; taskId?: string; title?: string; goalId?: string | null };
export type TimeLiveDay = TimeDay & { liveMinutes: number };

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

export function mergeLiveTime(data: TimeHeatmap, timer: TimeLiveTimer | null, now: number): Map<string, TimeLiveDay> {
  if (data.sources) return accountedTime(data.sources, data.year, data.timezone, now, timer);
  const days = new Map(data.days.map(day => [day.date, { ...day, liveMinutes: 0 }]));
  if (timer && !data.loggedSessionIds.includes(timer.sessionId)) {
    for (const live of timeDays([{ id: timer.sessionId, started_at: timer.startedAt, ended_at: new Date(now).toISOString(), minutes: Math.max(0, now - Date.parse(timer.startedAt)) / 60_000 }], data.year, data.timezone)) {
      const day = days.get(live.date) ?? { date: live.date, minutes: 0, sessions: 0, liveMinutes: 0 };
      day.minutes += live.minutes; day.sessions += 1; day.liveMinutes = live.minutes; days.set(live.date, day);
    }
  }
  return days;
}

/** Calendar is a fallback for elapsed time. Logs retain their saved minutes;
 * overlapping calendar blocks share only the time not covered by those logs. */
export function accountedTime(sources: TimeSources, year: number, timezone: string, now: number, timer: TimeLiveTimer | null = null): Map<string, TimeLiveDay> {
  const days = new Map<string, TimeLiveDay>();
  const work = [...sources.work];
  const live = timer && !work.some(row => row.id === timer.sessionId) ? {
    ...sources.tasks[timer.taskId ?? ''], taskId: timer.taskId || null,
    taskTitle: sources.tasks[timer.taskId ?? '']?.taskTitle ?? timer.title,
    goalId: sources.tasks[timer.taskId ?? '']?.goalId ?? timer.goalId,
    id: timer.sessionId, started_at: timer.startedAt, ended_at: new Date(now).toISOString(),
    minutes: Math.max(0, now - Date.parse(timer.startedAt)) / 60_000,
  } : null;
  if (live) work.push(live);
  const dayFor = (date: string) => {
    if (!days.has(date)) days.set(date, { date, minutes: 0, sessions: 0, liveMinutes: 0, calendarMinutes: 0, details: [] });
    return days.get(date)!;
  };
  const addDetail = (date: string, detail: TimeDetail) => {
    if (detail.minutes <= 1e-8) return;
    const day = dayFor(date);
    day.minutes += detail.minutes;
    if (detail.source === 'calendar') day.calendarMinutes! += detail.minutes;
    const previous = day.details!.find(row => row.key === detail.key);
    if (previous) previous.minutes += detail.minutes;
    else day.details!.push({ ...detail });
  };
  const categoryKey = (item: TimeCategory) => item.taskId ? `task:${item.taskId}` : item.goalId ? `goal:${item.goalId}` : 'misc';
  const untimed = new Map<string, number>();
  type Coverage = { start: number; end: number; rate: number };
  const coverage: Coverage[] = [];
  for (const session of work) {
    const start = Date.parse(session.started_at), end = Date.parse(session.ended_at ?? '');
    const minutes = Number(session.minutes);
    if (!Number.isFinite(start) || !Number.isFinite(minutes) || minutes <= 0) continue;
    const timed = Number.isFinite(end) && end > start;
    if (timed) coverage.push({ start, end, rate: Math.min(1, minutes * 60_000 / (end - start)) });
    for (const part of timeDays([session], year, timezone)) {
      const day = dayFor(part.date);
      day.sessions += 1;
      if (session === live) day.liveMinutes += part.minutes;
      addDetail(part.date, { ...session, key: `work:${categoryKey(session)}`, title: session.taskTitle || session.goalTitle || 'Miscellaneous', source: 'work', minutes: part.minutes });
      // A manual log with no clock range offsets the same task/goal's calendar
      // credit on that local day. Never guess which unlinked event it belongs to.
      if (!timed && categoryKey(session) !== 'misc') {
        const key = `${part.date}:${categoryKey(session)}`;
        untimed.set(key, (untimed.get(key) ?? 0) + part.minutes);
      }
    }
  }
  const calendar = sources.calendar.map(block => ({ ...block, end: Math.min(block.end, now) }))
    .filter(block => Number.isFinite(block.start) && Number.isFinite(block.end) && block.end > block.start);
  // Sweep interval boundaries. This also deduplicates coincident calendar
  // blocks without picking an arbitrary event as the winner.
  const boundaries = new Map<number, { kind: 'work' | 'calendar'; index: number; entering: boolean }[]>();
  const mark = (time: number, kind: 'work' | 'calendar', index: number, entering: boolean) => {
    if (!boundaries.has(time)) boundaries.set(time, []);
    boundaries.get(time)!.push({ kind, index, entering });
  };
  calendar.forEach((item, index) => { mark(item.start, 'calendar', index, true); mark(item.end, 'calendar', index, false); });
  coverage.forEach((item, index) => { mark(item.start, 'work', index, true); mark(item.end, 'work', index, false); });
  const points = [...boundaries.keys()].sort((a, b) => a - b);
  const activeCalendar = new Set<number>(), activeWork = new Set<number>();
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i], end = points[i + 1];
    for (const edge of boundaries.get(start)!) {
      const active = edge.kind === 'work' ? activeWork : activeCalendar;
      if (edge.entering) active.add(edge.index); else active.delete(edge.index);
    }
    if (!activeCalendar.size) continue;
    const remaining = Math.max(0, 1 - [...activeWork].reduce((sum, index) => sum + coverage[index].rate, 0));
    if (!remaining) continue;
    const minutes = (end - start) / 60_000 * remaining / activeCalendar.size;
    const parts = timeDays([{ id: 'calendar', started_at: new Date(start).toISOString(), ended_at: new Date(end).toISOString(), minutes }], year, timezone);
    for (const index of activeCalendar) {
      const block = calendar[index];
      const allocations = block.allocations.length ? block.allocations : [{ weight: 1 }];
      let weights = allocations.map(item => Number.isFinite(item.weight) && item.weight >= 0 ? item.weight : 0);
      if (!weights.some(weight => weight > 0)) weights = weights.map(() => 1);
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      allocations.forEach((allocation, j) => {
        for (const part of parts) {
          const key = `${part.date}:${categoryKey(allocation)}`;
          const credit = part.minutes * weights[j] / totalWeight;
          const offset = Math.min(credit, untimed.get(key) ?? 0);
          untimed.set(key, Math.max(0, (untimed.get(key) ?? 0) - offset));
          addDetail(part.date, { ...allocation, key: `calendar:${block.id}:${categoryKey(allocation)}`, title: block.title, source: 'calendar', minutes: credit - offset });
        }
      });
    }
  }
  for (const day of days.values()) day.details!.sort((a, b) => b.minutes - a.minutes || a.title.localeCompare(b.title));
  return new Map([...days.entries()].sort(([a], [b]) => a.localeCompare(b)));
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

/** A chronological timeline with a year of history and a year ahead. The
 * viewport opens near the current month; earlier months stay above it. */
export function timeWindow(year: number, month: number) {
  return Array.from({ length: 25 }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 12 + index, 1));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth(), key: date.toISOString().slice(0, 7) };
  });
}

export function timeWindowPosition(columns: 1 | 2 | 3) {
  const anchorIndex = 12 - Math.max(1, columns - 1);
  return { anchorIndex, leadingSlots: (columns - anchorIndex % columns) % columns };
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
