/**
 * Pure date/position helpers for the Schedule calendar grid.
 * Dates are local ISO YYYY-MM-DD strings; day_index is 0=Mon … 6=Sun
 * (matches DBEvent). No DOM, no timezone conversions — everything is
 * computed in the browser's local calendar, same as the rest of the UI.
 */

export function parseLocalDate(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00');
}

export function fmtYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Use the schedule's timezone for absolute timestamps, including across midnight. */
export function calendarDateTime(date: Date, timezone?: string): { date: string; hour: number } {
  if (!timezone) return { date: fmtYMD(date), hour: date.getHours() + date.getMinutes() / 60 };
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return { date: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) + Number(part('minute')) / 60 };
}

export function addDays(dateStr: string, n: number): string {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + n);
  return fmtYMD(d);
}

/** Monday of the week containing dateStr. */
export function mondayOf(dateStr: string): string {
  const d = parseLocalDate(dateStr);
  const dayIdx = (d.getDay() + 6) % 7; // JS Sunday=0 → Mon-based 0…6
  d.setDate(d.getDate() - dayIdx);
  return fmtYMD(d);
}

/** Where a date lives on the events model: Monday week_start + 0-based day index. */
export function dateToWeekPos(dateStr: string): { week_start: string; day_index: number } {
  return {
    week_start: mondayOf(dateStr),
    day_index: (parseLocalDate(dateStr).getDay() + 6) % 7,
  };
}

/**
 * Concrete date an event falls on. Normalizes week_start to its Monday so
 * legacy rows whose week_start drifted off-Monday still resolve. Events with
 * no week_start are weekly repeaters — they have no single date.
 */
export function eventDate(ev: { week_start: string | null; day_index: number }): string | null {
  if (!ev.week_start) return null;
  return addDays(mondayOf(ev.week_start), ((ev.day_index % 7) + 7) % 7);
}

/** Snap a fractional hour to the nearest step (in minutes). */
export function snapHour(hour: number, stepMinutes = 15): number {
  const step = stepMinutes / 60;
  return Math.round(hour / step) * step;
}

export function clampHour(hour: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, hour));
}

function fmtClock(hour: number, withMeridiem: boolean): string {
  const hh = Math.floor(hour);
  const mm = Math.round((hour - hh) * 60);
  const disp = hh % 12 || 12;
  const base = mm === 0 ? `${disp}` : `${disp}:${String(mm).padStart(2, '0')}`;
  return withMeridiem ? `${base} ${hh < 12 ? 'AM' : 'PM'}` : base;
}

/** "9 AM", "12 PM" — hour-gutter labels. */
export function fmtHourLabel(hour: number): string {
  return fmtClock(hour % 24, true);
}

/** "9 – 10:30 AM", "11:30 AM – 12:30 PM" — Google-Calendar-style range. */
export function fmtTimeRange(startHour: number, durationHours: number): string {
  const rawEnd = startHour + durationHours;
  const end = rawEnd >= 24 ? rawEnd - 24 : rawEnd;
  const sameMeridiem = startHour < 12 === end < 12;
  return `${fmtClock(startHour, !sameMeridiem)} – ${fmtClock(end, true)}`;
}

// ── Overlap packing ───────────────────────────────────────────────────────────

export interface TimedBlock {
  id: string;
  start: number; // fractional hour
  end: number;   // fractional hour, > start
}

export interface PackedPosition {
  col: number;  // 0-based column within the overlap cluster
  cols: number; // total columns in the cluster (divide the day width by this)
}

/**
 * Google-Calendar-style side-by-side layout: blocks that overlap in time are
 * split into columns; independent clusters each use the full width.
 */
export function packOverlaps(blocks: TimedBlock[]): Map<string, PackedPosition> {
  const result = new Map<string, PackedPosition>();
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end);

  let columns: TimedBlock[][] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    columns.forEach((col, ci) => {
      for (const b of col) result.set(b.id, { col: ci, cols: columns.length });
    });
    columns = [];
  };

  for (const b of sorted) {
    if (columns.length && b.start >= clusterEnd) flush();
    let placed = false;
    for (const col of columns) {
      if (col[col.length - 1].end <= b.start) {
        col.push(b);
        placed = true;
        break;
      }
    }
    if (!placed) columns.push([b]);
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  flush();
  return result;
}
