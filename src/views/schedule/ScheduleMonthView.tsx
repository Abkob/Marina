import type { ScheduleDay } from '../../api/hooks';
import type { DBEvent, DBTask } from '../../db/schema';
import { fmtHourLabel, parseLocalDate } from '../../utils/calendar';
import type { CalendarMeeting, PlacedEvent } from './WeekTimeGrid';

interface Props {
  days: string[];
  date: string;
  today: string;
  events: PlacedEvent[];
  meetings: CalendarMeeting[];
  tasksByDate: Map<string, DBTask[]>;
  previewByDate: Map<string, ScheduleDay>;
  blockedTaskIds: Set<string>;
  onDate: (date: string) => void;
  onEvent: (event: DBEvent) => void;
}

export function ScheduleMonthView({ days, date, today, events, meetings, tasksByDate, previewByDate, blockedTaskIds, onDate, onEvent }: Props) {
  return <section aria-label="Month calendar" className="schedule-month">
    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <div key={day} className="schedule-month-weekday">{day}</div>)}
    {days.map(day => {
      const preview = previewByDate.get(day);
      const scheduled = [
        ...events.filter(item => item.date === day).map(({ event }) => ({ id: event.id, title: event.title, time: event.start_hour, tone: 'event', event })),
        ...meetings.filter(item => item.date === day).map(item => ({ id: item.id, title: item.title, time: item.startHour, tone: 'meeting', event: undefined })),
        ...(preview?.routines ?? []).map(item => ({ id: item.routine_id, title: item.title, time: item.preferred_time ? Number(item.preferred_time.slice(0, 2)) + Number(item.preferred_time.slice(3, 5)) / 60 : -1, tone: 'routine', event: undefined })),
      ].sort((a, b) => a.time - b.time);
      const taskRows = (tasksByDate.get(day) ?? []).filter(task => !blockedTaskIds.has(`${task.id}|${day}`));
      const deadlines = preview?.deadlines ?? [];
      const dueTasks = preview?.tasks ?? [];
      const dueCount = deadlines.length + dueTasks.length;
      const label = parseLocalDate(day).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      return <div key={day} onClick={event => { if (!(event.target as HTMLElement).closest('button')) onDate(day); }} className={`schedule-month-day ${day.slice(0, 7) !== date.slice(0, 7) ? 'schedule-month-outside' : ''}`}>
        <button onClick={() => onDate(day)} aria-label={`Open ${label}`} aria-current={day === today ? 'date' : undefined} className="schedule-month-date">{parseLocalDate(day).getDate()}</button>
        {dueCount > 0 && <button onClick={() => onDate(day)} className="schedule-month-due" title={[...deadlines.map(item => item.title), ...dueTasks.map(item => item.title)].join(', ')}>{dueCount} due</button>}
        <div className="space-y-1">
          {scheduled.slice(0, 3).map(item => <button key={`${item.tone}-${item.id}`} onClick={() => item.event ? onEvent(item.event) : onDate(day)} className={`schedule-month-event schedule-month-${item.tone}`} title={item.title}><span className="truncate">{item.title}</span>{item.time >= 0 && <span className="shrink-0 text-[10px] opacity-60">{fmtHourLabel(item.time)}</span>}</button>)}
          {scheduled.length > 3 && <button onClick={() => onDate(day)} className="schedule-month-more">+{scheduled.length - 3} more</button>}
          {taskRows.length > 0 && <button onClick={() => onDate(day)} className="schedule-month-more truncate" title={taskRows.map(task => task.title).join(', ')}>{taskRows.length === 1 ? taskRows[0].title : `${taskRows.length} tasks`}</button>}
        </div>
      </div>;
    })}
  </section>;
}
