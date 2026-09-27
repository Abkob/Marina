import { addRoutineDays, isRoutineDate, routineWeekStart } from './routines.js';

/** Convert a calendar wall clock in the workspace timezone to an instant.
 * Repeated hours use the earlier occurrence; missing hours move forward by
 * the DST gap. No dependency on the server's or device's local timezone. */
export function calendarInstant(date: string, hour: number, timezone: string): number {
  if (!isRoutineDate(date) || !Number.isFinite(hour)) return NaN;
  const wall = Date.parse(`${date}T00:00:00Z`) + Math.round(hour * 3_600_000);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const wallAt = (instant: number) => {
    const parts = formatter.formatToParts(instant);
    const get = (type: string) => Number(parts.find(part => part.type === type)!.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  };
  const offsets = new Set<number>();
  for (const shift of [-36, -12, 0, 12, 36]) {
    const sample = Math.floor((wall + shift * 3_600_000) / 1000) * 1000;
    offsets.add(wallAt(sample) - sample);
  }
  const candidates = [...offsets].map(offset => wall - offset).sort((a, b) => a - b);
  return candidates.find(instant => Math.abs(wallAt(instant) - wall) < 1000)
    ?? candidates.filter(instant => wallAt(instant) >= wall).sort((a, b) => wallAt(a) - wallAt(b))[0]
    ?? NaN;
}

export function calendarEventRange(event: { week_start: string | null; day_index: number; start_hour: number; duration_hours: number }, timezone: string) {
  // The calendar no longer displays the legacy undated demo blocks.
  if (!isRoutineDate(event.week_start) || !Number.isInteger(event.day_index)
    || !Number.isFinite(event.start_hour) || !Number.isFinite(event.duration_hours) || event.duration_hours <= 0) return null;
  const date = addRoutineDays(routineWeekStart(event.week_start), ((event.day_index % 7) + 7) % 7);
  const start = calendarInstant(date, event.start_hour, timezone);
  const end = calendarInstant(date, event.start_hour + event.duration_hours, timezone);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}
