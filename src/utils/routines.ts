import type { DBRoutine, DBRoutineEntry, RoutineReservation, RoutineSchedule } from '../types/routines';

const DAY = 86_400_000;
const dateMs = (date: string) => Date.parse(`${date}T12:00:00Z`);

export function isRoutineDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(dateMs(value)) && new Date(dateMs(value)).toISOString().slice(0, 10) === value;
}

export function addRoutineDays(date: string, days: number): string {
  return new Date(dateMs(date) + days * DAY).toISOString().slice(0, 10);
}

export function routineWeekStart(date: string): string {
  const weekday = new Date(dateMs(date)).getUTCDay() || 7;
  return addRoutineDays(date, 1 - weekday);
}

export function routineForDate(routine: DBRoutine, date: string): DBRoutine {
  const version = [...(routine.schedule_history ?? [])].sort((a, b) => a.before.localeCompare(b.before)).find(item => date < item.before);
  return version ? { ...routine, ...version } : routine;
}

export function routineSchedule(routine: RoutineSchedule): RoutineSchedule {
  const { cadence, weekdays, weekly_target, target_count, target_unit, planned_minutes, preferred_time } = routine;
  return { cadence, weekdays, weekly_target, target_count, target_unit, planned_minutes, preferred_time };
}

export function routineTimeLabel(minutes: number): string {
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return hours ? `${hours}h${rest ? ` ${rest}m` : ''}` : `${rest} min`;
}

/** Accept minutes, decimal hours, or a compact duration without an OS picker. */
export function parseRoutineDuration(value: string): number | null {
  const match = value.trim().toLowerCase().match(/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?)?\s*)?(?:(\d+)\s*(?:m(?:in(?:ute)?s?)?)?)?$/);
  if (!match || (!match[1] && !match[2])) return null;
  const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : null;
}

/** Date-only arithmetic deliberately avoids DST and browser timezone shifts. */
export function routineEligibleOn(routine: DBRoutine, date: string): boolean {
  routine = routineForDate(routine, date);
  if (!isRoutineDate(date) || date < routine.start_date) return false;
  if (routine.archived_at && date >= (routine.archived_on ?? routine.archived_at.slice(0, 10))) return false;
  return routine.weekdays.includes(new Date(dateMs(date)).getUTCDay() || 7);
}

export function routineProgress(routine: DBRoutine, entries: DBRoutineEntry[], date: string) {
  routine = routineForDate(routine, date);
  const start = routineWeekStart(date);
  const end = addRoutineDays(start, 6);
  const own = [...new Map(entries.filter(entry => entry.routine_id === routine.id).map(entry => [entry.date, entry])).values()];
  const entry = own.find(item => item.date === date) ?? null;
  const completedDates = new Set(own.filter(item => item.date >= start && item.date <= end && item.status === 'completed').map(item => item.date));
  const weekTarget = routine.cadence === 'weekly' ? routine.weekly_target
    : Array.from({ length: 7 }, (_, i) => addRoutineDays(start, i)).filter(day => routineEligibleOn(routine, day)).length;
  const remainingThisWeek = Math.max(0, weekTarget - completedDates.size);
  const scheduled = routineEligibleOn(routine, date)
    && (routine.cadence === 'daily' || remainingThisWeek > 0 || Boolean(entry));
  return {
    entry, scheduled,
    status: entry?.status ?? (scheduled ? 'pending' as const : 'off' as const),
    weekCompleted: completedDates.size, weekTarget, remainingThisWeek,
    minutes: Number(entry?.minutes ?? 0), completedCount: Number(entry?.completed_count ?? 0),
    weekMinutes: own.filter(item => item.date >= start && item.date <= end).reduce((sum, item) => sum + Number(item.minutes), 0),
    weekPlannedMinutes: weekTarget * routine.planned_minutes,
  };
}

/**
 * Reserve time without generating recurring task copies. Weekly routines are
 * flexible: completed sessions anywhere in the week reduce its remaining target.
 * Callers must supply entries for complete boundary weeks, not only the view.
 */
export function routineReservations(routines: DBRoutine[], entries: DBRoutineEntry[], from: string, to: string, today: string): RoutineReservation[] {
  if (![from, to, today].every(isRoutineDate) || from > to) return [];
  const reservations: RoutineReservation[] = [];
  const first = from > today ? from : today;
  if (first > to) return reservations;
  // Weekly boundaries also delimit schedule edits, so a past week always keeps its original plan.
  for (const original of routines) {
    const own = new Map(entries.filter(entry => entry.routine_id === original.id).map(entry => [entry.date, entry]));
    for (let week = routineWeekStart(first); week <= to; week = addRoutineDays(week, 7)) {
      const routine = routineForDate(original, week);
      const weekEnd = addRoutineDays(week, 6);
      const add = (date: string) => {
        if (date < first || date > to || date < week || date > weekEnd) return;
        const entry = own.get(date);
        if (entry?.status === 'skipped' && !entry.minutes) return;
        const archiveCutoff = routine.archived_on ?? routine.archived_at?.slice(0, 10);
        const archivedToday = Boolean(archiveCutoff && date >= addRoutineDays(archiveCutoff, -1));
        if (archivedToday && entry?.status !== 'completed' && !entry?.minutes) return;
        reservations.push({ routine_id: routine.id, title: routine.title, date,
          minutes: entry?.status === 'skipped' || (archivedToday && entry?.status !== 'completed')
            ? Number(entry?.minutes ?? 0) : Math.max(routine.planned_minutes, Number(entry?.minutes ?? 0)), preferred_time: routine.preferred_time });
      };
      if (routine.cadence === 'daily') {
        for (let date = week > first ? week : first; date <= to && date <= weekEnd; date = addRoutineDays(date, 1)) {
          if (routineEligibleOn(routine, date)) add(date);
        }
        continue;
      }
      const days = Array.from({ length: 7 }, (_, i) => addRoutineDays(week, i));
      const completed = days.filter(date => own.get(date)?.status === 'completed');
      let remaining = Math.max(0, routine.weekly_target - completed.length);
      completed.filter(date => routineEligibleOn(routine, date)).forEach(add);
      days.filter(date => routineEligibleOn(routine, date) && own.get(date)?.status === 'skipped' && own.get(date)?.minutes).forEach(add);
      // Work already started takes priority over an untouched day.
      const candidates = days.filter(date => date >= today && routineEligibleOn(routine, date)
        && own.get(date)?.status !== 'completed' && own.get(date)?.status !== 'skipped');
      candidates.sort((a, b) => Number(own.get(b)?.status === 'partial') - Number(own.get(a)?.status === 'partial') || a.localeCompare(b));
      for (const date of candidates) {
        if (remaining <= 0 && own.get(date)?.status !== 'partial') continue;
        add(date);
        remaining = Math.max(0, remaining - 1);
      }
    }
  }
  return reservations.sort((a, b) => a.date.localeCompare(b.date) || a.routine_id.localeCompare(b.routine_id));
}
