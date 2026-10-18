/** A frozen intention and an observed outcome are independent records. */
export type ScheduleOccurrence = {
  id: string; source: 'event' | 'meeting' | 'routine'; sourceId: string;
  title: string; start: string; end: string; taskIds: string[];
  goalId: string | null; routineId: string | null;
};
export type ScheduleOutcome = {
  occurrence_id: string; date: string; revision: number;
  status: 'confirmed' | 'skipped' | 'unknown';
  actual_start: string | null; actual_end: string | null;
  session_id: string | null; occurrence: ScheduleOccurrence; updated_at: string;
};
export type ScheduleSession = { id: string; started_at: string; ended_at: string | null; minutes: number | null; task_id: string | null; routine_id: string | null; source: string; schedule_occurrence_id?: string | null };
export type ScheduleReviewDay = {
  date: string; timezone: string; today: string;
  proposed: { saved_at: string; frozen: boolean; occurrences: ScheduleOccurrence[] } | null;
  current: ScheduleOccurrence[]; outcomes: ScheduleOutcome[]; sessions: ScheduleSession[];
  pendingTimers: {id:string;started_at:string;title:string;schedule_occurrence_id:string|null;schedule_date:string|null}[];
};
export type ClockRange = { start: number; end: number };

/** Full observed spans exclude calendar/check-in fallback even when work
 * minutes were corrected downward. Removed minutes must not grow back. */
export function uncoveredRanges(range: ClockRange, occupied: ClockRange[]): ClockRange[] {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) return [];
  let parts = [range];
  for (const block of occupied.filter(b => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start).sort((a,b) => a.start-b.start)) {
    parts = parts.flatMap(part => block.end <= part.start || block.start >= part.end ? [part] : [
      ...(block.start > part.start ? [{ start: part.start, end: block.start }] : []),
      ...(block.end < part.end ? [{ start: block.end, end: part.end }] : []),
    ]);
  }
  return parts;
}

export function matchingSessions(occurrence: ScheduleOccurrence, sessions: ScheduleSession[]) {
  const start = Date.parse(occurrence.start), end = Date.parse(occurrence.end);
  return sessions.filter(s => s.source !== 'schedule_checkin' && s.ended_at &&
    (s.schedule_occurrence_id===occurrence.id ||
      ((occurrence.taskIds.includes(s.task_id ?? '') || Boolean(occurrence.routineId && s.routine_id === occurrence.routineId)) &&
      Date.parse(s.started_at) < end && Date.parse(s.ended_at) > start)));
}

export type CheckInGesture = 'done' | 'skip' | 'times' | null;
export function checkInDirection(dx: number, dy: number): CheckInGesture {
  if (dy < -48 && Math.abs(dy) > Math.abs(dx)) return 'times';
  if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'done' : 'skip';
  return null;
}
