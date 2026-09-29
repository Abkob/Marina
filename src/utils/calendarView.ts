import { addDays, fmtYMD, mondayOf, parseLocalDate } from './calendar';

export type CalendarView = 'day' | 'week' | 'month';

export function monthDates(date: string): string[] {
  const first = mondayOf(`${date.slice(0, 7)}-01`);
  return Array.from({ length: 42 }, (_, index) => addDays(first, index));
}

/** Keep the selected day where possible, including across short months. */
export function navigateCalendar(date: string, view: CalendarView, direction: number): string {
  if (view !== 'month') return addDays(date, direction * (view === 'week' ? 7 : 1));
  const next = parseLocalDate(date);
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + direction);
  const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, last));
  return fmtYMD(next);
}
