/**
 * Deterministic hour-level layout for chat plans: takes the scheduler's
 * day assignments (which task works on which day) and packs each day's tasks
 * into concrete timed blocks inside the user's work hours, around meetings
 * and existing calendar blocks. Pure — no DB, no Date.now().
 */

export interface PlanTaskInfo {
  id: string;
  title: string;
  /** minutes of work still to place (estimate minus logged) */
  remaining_minutes: number;
}

export interface BusyInterval {
  date: string;       // YYYY-MM-DD
  start_hour: number; // fractional
  end_hour: number;   // fractional, > start_hour
}

export interface PlanBlock {
  task_id: string;
  title: string;
  date: string;
  start_hour: number;
  duration_hours: number;
  planned_minutes: number;
}

export interface PlanLayoutResult {
  blocks: PlanBlock[];
  /** work that had no room inside the horizon's free hours */
  unplaced: Array<{ task_id: string; title: string; minutes: number }>;
}

// ── Small date helpers (server-local; mirror src/utils/calendar semantics) ───

export function fmtYMDLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDaysStr(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return fmtYMDLocal(d);
}

/** Monday-based week position of a date — matches the events model. */
export function dateToWeekPosServer(dateStr: string): { week_start: string; day_index: number } {
  const d = new Date(dateStr + 'T00:00:00');
  const dayIdx = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dayIdx);
  return { week_start: fmtYMDLocal(d), day_index: dayIdx };
}

/** Concrete date of an event row (week_start normalized to its Monday). */
export function eventDateServer(weekStart: string, dayIndex: number): string {
  const { week_start } = dateToWeekPosServer(weekStart);
  return addDaysStr(week_start, ((dayIndex % 7) + 7) % 7);
}

/** "10:00 AM - 11:30 AM" — display string stored on events. */
export function fmtTimeStr(startHour: number, durationHours: number): string {
  const fmt = (h: number) => {
    const hh = Math.floor(h) % 24;
    const mm = Math.round((h - Math.floor(h)) * 60);
    const disp = hh % 12 || 12;
    return `${disp}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  };
  return `${fmt(startHour)} - ${fmt(startHour + durationHours)}`;
}

// ── Plan window resolution ────────────────────────────────────────────────────
// The model translates the user's words ("plan Monday", "next 3 hours",
// "until Friday") into structured params; this resolves them into a concrete,
// sane window. Pure — the caller supplies today's date and the current hour.

export interface PlanWindowParams {
  task_id?: string;
  task_ids?: string[];
  /** Maximum work from the scoped task that may be placed on one day. */
  max_daily_minutes?: number;
  horizon_days?: number;
  from_date?: string;
  to_date?: string;
  start_hour?: number;
  end_hour?: number;
  /** "next N hours" — resolved against the server clock, since the model doesn't know the time */
  relative_hours?: number;
}

export interface ResolvedPlanWindow {
  from: string;
  to: string;
  startHour?: number;
  endHour?: number;
}

const MAX_SPAN_DAYS = 90;

export function resolvePlanWindow(p: PlanWindowParams, todayStr: string, nowHour: number): ResolvedPlanWindow {
  // "Next N hours": today only, from the next quarter hour on the clock.
  if (p.relative_hours && p.relative_hours > 0) {
    const start = Math.min(23.5, Math.ceil(nowHour * 4) / 4);
    return {
      from: todayStr,
      to: todayStr,
      startHour: start,
      endHour: Math.min(24, start + p.relative_hours),
    };
  }

  // The past can't be planned — clamp the start to today.
  let from = p.from_date && p.from_date > todayStr ? p.from_date : todayStr;
  if (p.from_date && p.from_date >= todayStr) from = p.from_date;

  let to = p.to_date ?? addDaysStr(from, Math.min(Math.max(1, p.horizon_days ?? 14), MAX_SPAN_DAYS) - 1);
  if (to < from) to = from;
  const cap = addDaysStr(from, MAX_SPAN_DAYS - 1);
  if (to > cap) to = cap;

  // Hour scoping only when the pair makes sense.
  const hasHours = p.start_hour !== undefined && p.end_hour !== undefined && p.end_hour > p.start_hour;
  return {
    from,
    to,
    ...(hasHours ? { startHour: p.start_hour, endHour: p.end_hour } : {}),
  };
}

// ── Finite repeating calendar blocks (separate from tracked routines) ───────
// "Every day 6–9am for a month" → concrete dated blocks the plan widget can
// show and apply in one transaction. Pure and capped.

export interface SeriesParams {
  title: string;
  start_date: string;
  end_date: string;   // inclusive
  start_hour: number;
  end_hour: number;   // > start_hour
  /** 1=Mon … 7=Sun; omitted = every day */
  days_of_week?: number[];
  task_id?: string;
}

export interface SeriesBlock {
  title: string;
  date: string;
  start_hour: number;
  duration_hours: number;
  task_id?: string;
  planned_minutes?: number;
}

const MAX_SERIES_INSTANCES = 120;

export function expandSeries(p: SeriesParams): SeriesBlock[] {
  if (p.end_hour <= p.start_hour) return [];
  const duration = p.end_hour - p.start_hour;
  const wanted = p.days_of_week && p.days_of_week.length ? new Set(p.days_of_week) : null;
  const out: SeriesBlock[] = [];
  let date = p.start_date;
  while (date <= p.end_date && out.length < MAX_SERIES_INSTANCES) {
    const dow = ((new Date(date + 'T00:00:00').getDay() + 6) % 7) + 1; // 1=Mon…7=Sun
    if (!wanted || wanted.has(dow)) {
      out.push({
        title: p.title,
        date,
        start_hour: p.start_hour,
        duration_hours: duration,
        ...(p.task_id ? { task_id: p.task_id, planned_minutes: Math.round(duration * 60) } : {}),
      });
    }
    date = addDaysStr(date, 1);
  }
  return out;
}

interface Interval { start: number; end: number }

/** Free intervals of a day: the work window minus that day's busy slots. */
function freeIntervals(workStart: number, workEnd: number, busy: Interval[]): Interval[] {
  const sorted = [...busy]
    .map(b => ({ start: Math.max(b.start, workStart), end: Math.min(b.end, workEnd) }))
    .filter(b => b.end > b.start)
    .sort((a, b) => a.start - b.start);

  const free: Interval[] = [];
  let cursor = workStart;
  for (const b of sorted) {
    if (b.start > cursor) free.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < workEnd) free.push({ start: cursor, end: workEnd });
  return free;
}

export function layoutPlan(opts: {
  dayAssignments: Array<{ date: string; task_ids: string[]; task_minutes?: Record<string, number> }>;
  tasks: PlanTaskInfo[];
  workStart: number;
  workEnd: number;
  busy: BusyInterval[];
  /** slivers shorter than this are skipped (default 15 minutes) */
  minBlockMinutes?: number;
}): PlanLayoutResult {
  const { dayAssignments, tasks, workStart, workEnd, busy } = opts;
  const minBlock = opts.minBlockMinutes ?? 15;

  const remaining = new Map<string, number>();
  const titleOf = new Map<string, string>();
  for (const t of tasks) {
    remaining.set(t.id, Math.max(0, Math.round(t.remaining_minutes)));
    titleOf.set(t.id, t.title);
  }

  const busyByDate = new Map<string, Interval[]>();
  for (const b of busy) {
    if (!busyByDate.has(b.date)) busyByDate.set(b.date, []);
    busyByDate.get(b.date)!.push({ start: b.start_hour, end: b.end_hour });
  }

  const blocks: PlanBlock[] = [];
  const days = [...dayAssignments].sort((a, b) => a.date.localeCompare(b.date));

  for (const day of days) {
    const free = freeIntervals(workStart, workEnd, busyByDate.get(day.date) ?? []);
    let intervalIdx = 0;
    let cursor = free.length ? free[0].start : 0;

    for (const taskId of day.task_ids) {
      let left = remaining.get(taskId) ?? 0;
      let dayBudget = Math.min(left, day.task_minutes?.[taskId] ?? left);
      while (left > 0 && dayBudget > 0 && intervalIdx < free.length) {
        const iv = free[intervalIdx];
        if (cursor < iv.start) cursor = iv.start;
        const roomMin = Math.round((iv.end - cursor) * 60);
        if (roomMin < minBlock) {
          intervalIdx += 1;
          cursor = intervalIdx < free.length ? free[intervalIdx].start : cursor;
          continue;
        }
        const chunk = Math.min(left, dayBudget, roomMin);
        blocks.push({
          task_id: taskId,
          title: titleOf.get(taskId) ?? taskId,
          date: day.date,
          start_hour: cursor,
          duration_hours: chunk / 60,
          planned_minutes: chunk,
        });
        left -= chunk;
        dayBudget -= chunk;
        cursor += chunk / 60;
      }
      remaining.set(taskId, left);
    }
  }

  const unplaced = [...remaining.entries()]
    .filter(([, min]) => min > 0)
    .map(([task_id, minutes]) => ({ task_id, title: titleOf.get(task_id) ?? task_id, minutes }));

  return { blocks, unplaced };
}
