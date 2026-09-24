import type { DayAssignment, ScheduleDay } from '../api/hooks';
import type { DBEvent, DBTask } from '../db/schema';
import type { CalendarMeeting, PlacedEvent } from '../views/schedule/WeekTimeGrid';

export interface MobileScheduleItem {
  id: string;
  title: string;
  kind: 'event' | 'meeting' | 'routine' | 'task' | 'deadline';
  date: string;
  start: number | null;
  minutes: number;
  detail: string;
  event?: DBEvent;
  task?: DBTask;
  goalId?: string;
}

/** One shared list powers the phone's timeline, agenda and date indicators. */
export function mobileScheduleItems({ date, events, meetings, tasks, day, assignment, blockedTaskIds }: {
  date: string;
  events: PlacedEvent[];
  meetings: CalendarMeeting[];
  tasks: DBTask[];
  day?: ScheduleDay;
  assignment?: DayAssignment;
  blockedTaskIds: Set<string>;
}): MobileScheduleItem[] {
  const items: MobileScheduleItem[] = [];
  for (const { event, date: eventDay } of events) {
    if (eventDay !== date) continue;
    items.push({ id: `event:${event.id}`, title: event.title, kind: 'event', date, start: event.start_hour,
      minutes: event.duration_hours * 60, detail: event.type, event });
  }
  for (const meeting of meetings) {
    if (meeting.date !== date) continue;
    items.push({ id: `meeting:${meeting.id}`, title: meeting.title, kind: 'meeting', date, start: meeting.startHour,
      minutes: meeting.durationHours * 60, detail: 'Meeting' });
  }
  for (const routine of day?.routines ?? []) {
    const parts = routine.preferred_time?.split(':').map(Number);
    const start = parts && parts.length >= 2 && parts[0] >= 0 && parts[0] < 24 && parts[1] >= 0 && parts[1] < 60
      ? parts[0] + parts[1] / 60 : null;
    items.push({ id: `routine:${routine.routine_id}`, title: routine.title, kind: 'routine', date, start,
      minutes: routine.minutes, detail: start === null ? 'Flexible routine' : 'Routine · preferred time' });
  }
  const assigned = new Set(assignment?.task_ids ?? []);
  const dueIds = new Set(day?.tasks.map(task => task.id) ?? []);
  for (const task of tasks) {
    if (task.completed || task.status === 'done') continue;
    const due = task.due_date === date || dueIds.has(task.id);
    const scheduled = task.start_date === date;
    const blocked = blockedTaskIds.has(`${task.id}|${date}`);
    if (!due && (blocked || (!scheduled && !assigned.has(task.id)))) continue;
    items.push({ id: `task:${task.id}`, title: task.title, kind: 'task', date, start: null,
      minutes: assignment?.task_minutes?.[task.id] ?? task.estimated_minutes ?? 0,
      detail: due ? 'Due today' : scheduled ? 'Scheduled task' : 'Suggested by your plan', task });
  }
  for (const deadline of day?.deadlines ?? []) {
    items.push({ id: `deadline:${deadline.id}`, title: deadline.title, kind: 'deadline', date, start: null,
      minutes: 0, detail: deadline.goal_title ?? 'Goal deadline', goalId: deadline.goal_id });
  }
  return items.sort((a, b) => (a.start ?? -1) - (b.start ?? -1) || a.title.localeCompare(b.title));
}
