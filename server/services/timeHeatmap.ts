import { query } from '../db.js';
import { accountedTime, timeDate, type TimeCategory, type TimeWork, type TimeCalendar, type TimeHeatmap } from '../../src/utils/timeHeatmap.js';
import { calendarEventRange, calendarInstant } from '../../src/utils/calendarTime.js';

type Task = { id: string; title: string; parent_task_id: string | null; goal_id: string | null };
type Link = { task_id: string; planned_minutes: number | null };
type Event = { id: string; title: string; week_start: string | null; day_index: number; start_hour: number; duration_hours: number; links: Link[] };
type Meeting = { id: string; title: string; scheduled_at: string; duration_minutes: number; goal_id: string | null; links: Link[] };

export async function getTimeHeatmap(year: number): Promise<TimeHeatmap> {
  const { rows: prefs } = await query("SELECT timezone FROM user_schedule_prefs WHERE id='default'");
  const timezone = String(prefs[0]?.timezone || 'Asia/Beirut');
  // Include intervals crossing the year boundary; the allocator clips them to
  // the requested local year. No day limit: all 365/366 dates can contribute.
  const [work, events, meetings, taskRows, goals] = await Promise.all([
    query<TimeWork & { task_id: string | null; goal_id: string | null }>(`SELECT id,started_at,ended_at,minutes,task_id,goal_id FROM work_sessions
      WHERE minutes > 0 AND started_at < $2
        AND GREATEST(started_at,COALESCE(ended_at,started_at)) >= $1`, [`${year - 1}-12-29`, `${year + 1}-01-03`]),
    query<Event>(`SELECT e.id,e.title,e.week_start,e.day_index,e.start_hour,e.duration_hours,
      COALESCE((SELECT json_agg(json_build_object('task_id',l.task_id,'planned_minutes',l.planned_minutes) ORDER BY l.id)
        FROM event_task_links l WHERE l.event_id=e.id),'[]'::json) AS links
      FROM events e WHERE e.week_start IS NOT NULL`),
    query<Meeting>(`SELECT m.id,m.title,m.scheduled_at,m.duration_minutes,COALESCE(m.goal_id,gm.goal_id) AS goal_id,
      COALESCE((SELECT json_agg(json_build_object('task_id',e.target_id,'planned_minutes',NULL) ORDER BY e.target_id)
        FROM edges e WHERE e.source_type='meeting' AND e.source_id=m.id AND e.target_type='task' AND e.relationship='linked_to'),'[]'::json) AS links
      FROM meetings m LEFT JOIN goal_milestones gm ON gm.id=m.milestone_id`),
    query<Task>(`SELECT t.id,t.title,t.parent_task_id,COALESCE(t.goal_id,gm.goal_id) AS goal_id
      FROM tasks t LEFT JOIN goal_milestones gm ON gm.id=t.milestone_id`),
    query<{ id: string; title: string }>('SELECT id,title FROM goals'),
  ]);
  const goalById = new Map(goals.rows.map(goal => [goal.id, goal]));
  const taskById = new Map(taskRows.rows.map(task => [task.id, task]));
  const tasks: Record<string, TimeCategory> = {};
  for (const task of taskRows.rows) {
    let ancestor: Task | undefined = task;
    const seen = new Set<string>();
    while (ancestor && !ancestor.goal_id && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      ancestor = ancestor.parent_task_id ? taskById.get(ancestor.parent_task_id) : undefined;
    }
    const goal = goalById.get(ancestor?.goal_id ?? '');
    tasks[task.id] = { taskId: task.id, taskTitle: task.title, goalId: goal?.id ?? null, goalTitle: goal?.title ?? null };
  }
  const category = (taskId: string | null, goalId: string | null): TimeCategory => {
    const task = tasks[taskId ?? ''];
    const goal = goalById.get(goalId ?? '') ?? goalById.get(task?.goalId ?? '');
    return { ...task, goalId: goal?.id ?? null, goalTitle: goal?.title ?? null };
  };
  const allocations = (links: Link[], blockMinutes: number, goalId: string | null = null) => {
    const unique = [...new Map(links.filter(link => tasks[link.task_id]).map(link => [link.task_id, link])).values()];
    // Honor planned proportions, split unspecified portions evenly. The whole
    // block is allocated exactly once even if linked to several tasks.
    const specified = unique.filter(link => link.planned_minutes !== null);
    const unspecified = unique.length - specified.length;
    const defaultWeight = unspecified ? Math.max(0, blockMinutes - specified.reduce((sum, link) => sum + Math.max(0, Number(link.planned_minutes)), 0)) / unspecified : 0;
    return unique.length ? unique.map(link => ({ ...category(link.task_id, goalId), weight: link.planned_minutes !== null ? Math.max(0, Number(link.planned_minutes)) : defaultWeight }))
      : [{ ...category(null, goalId), weight: 1 }];
  };
  const first = calendarInstant(`${year}-01-01`, 0, timezone), last = calendarInstant(`${year + 1}-01-01`, 0, timezone);
  const calendar: TimeCalendar[] = [];
  for (const event of events.rows) {
    const range = calendarEventRange(event, timezone);
    if (range && range.start < last && range.end > first) calendar.push({ id: `event:${event.id}`, title: event.title, ...range, allocations: allocations(event.links, event.duration_hours * 60) });
  }
  for (const meeting of meetings.rows) {
    const start = Date.parse(meeting.scheduled_at), end = start + Number(meeting.duration_minutes) * 60_000;
    if (Number.isFinite(start) && Number.isFinite(end) && start < last && end > first && end > start) {
      calendar.push({ id: `meeting:${meeting.id}`, title: meeting.title, start, end, allocations: allocations(meeting.links, meeting.duration_minutes, meeting.goal_id) });
    }
  }
  const sources = { work: work.rows.map(row => ({ ...row, ...category(row.task_id, row.goal_id) })), calendar, tasks };
  const now = Date.now();
  return { year, timezone, today: timeDate(now, timezone), sources,
    days: [...accountedTime(sources, year, timezone, now).values()], loggedSessionIds: work.rows.map(row => row.id) };
}
