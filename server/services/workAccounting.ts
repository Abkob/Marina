import { query } from '../db.js';
import { activeEventSql, activeTaskSql } from '../utils/archiveVisibility.js';
import { buildTaskTimelineResolver, type TaskTimelineRow, type GoalTimelineRow, type MilestoneTimelineRow } from './taskTimeline.js';
import { accountReservations, accountWork, type ReservationRow, type WorkAccounting, type WorkInputs } from '../../shared/workAccounting.js';

export { accountWork } from '../../shared/workAccounting.js';
export const workColumns = (alias = 't') => ['actual_minutes','work_version','worklog_version','remaining_forecast_minutes',
  'remaining_forecast_work_version','remaining_forecast_log_version','remaining_forecast_updated_at','forecast_revision'].map(key => `${alias}.${key}`).join(', ');

export function localClock(now = new Date(), timezone = 'UTC') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  return { today: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** One statement gives tasks, current session totals and links a consistent MVCC snapshot. */
export async function loadWorkAccounting(from: string, to: string, timezone?: string, taskIds?: string[], now = new Date()) {
  const { rows } = await query<{ tasks: Array<WorkInputs & { id: string }>; links: ReservationRow[]; timeline_tasks: TaskTimelineRow[]; goals: GoalTimelineRow[]; milestones: MilestoneTimelineRow[] }>(`
    WITH selected AS (SELECT t.* FROM tasks t WHERE ${activeTaskSql('t.id')} AND ($3::text[] IS NULL OR t.id=ANY($3))),
    session_totals AS (SELECT ws.task_id, SUM(ws.minutes) AS minutes, COUNT(*) AS count FROM work_sessions ws
      JOIN selected t ON t.id=ws.task_id WHERE ws.minutes IS NOT NULL GROUP BY ws.task_id)
    SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',t.id,'estimated_minutes',t.estimated_minutes,'actual_minutes',t.actual_minutes,'completed',t.completed,'status',t.status,
      'work_version',t.work_version,'worklog_version',t.worklog_version,'forecast_revision',t.forecast_revision,
      'remaining_forecast_minutes',t.remaining_forecast_minutes,'remaining_forecast_work_version',t.remaining_forecast_work_version,
      'remaining_forecast_log_version',t.remaining_forecast_log_version,'remaining_forecast_updated_at',t.remaining_forecast_updated_at,
      'logged_minutes',CASE WHEN s.count>0 THEN s.minutes ELSE t.actual_minutes END,'session_count',COALESCE(s.count,0)))
      FROM selected t LEFT JOIN session_totals s ON s.task_id=t.id),'[]') AS tasks,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'event_id',l.event_id,'task_id',l.task_id,
      'planned_minutes',l.planned_minutes,'work_version',l.work_version,'task_work_version',t.work_version,
      'date',(e.week_start::date+e.day_index)::text,'start_hour',e.start_hour,'duration_hours',e.duration_hours))
      FROM event_task_links l JOIN events e ON e.id=l.event_id JOIN tasks t ON t.id=l.task_id
      WHERE ${activeEventSql('e.id')} AND e.week_start IS NOT NULL
        AND (e.week_start::date+e.day_index) BETWEEN $1::date AND $2::date
        AND EXISTS (SELECT 1 FROM event_task_links scope_link JOIN selected scope_task ON scope_task.id=scope_link.task_id WHERE scope_link.event_id=e.id)), '[]') AS links,
    COALESCE((SELECT jsonb_agg(row_to_json(timeline)) FROM (SELECT id,parent_task_id,goal_id,milestone_id,start_date,due_date,target_date,hard_deadline FROM tasks) timeline),'[]') AS timeline_tasks,
    COALESCE((SELECT jsonb_agg(row_to_json(timeline)) FROM (SELECT id,start_date,target_date,hard_deadline,deadline FROM goals) timeline),'[]') AS goals,
    COALESCE((SELECT jsonb_agg(row_to_json(timeline)) FROM (SELECT id,start_date,due_date,hard_deadline FROM goal_milestones) timeline),'[]') AS milestones`,
  [from, to, taskIds ?? null]);
  const resolve = buildTaskTimelineResolver(rows[0]?.timeline_tasks ?? [], rows[0]?.goals ?? [], rows[0]?.milestones ?? []);
  const reservations = accountReservations((rows[0]?.links ?? []).map(link => {
    const timeline = resolve({ id: link.task_id });
    return { ...link, eligible_from: timeline.start_date, eligible_to: timeline.due_date };
  }), { from, to, ...localClock(now, timezone) });
  const accounting = new Map<string, WorkAccounting>();
  const inputs = new Map<string, WorkInputs>();
  for (const task of rows[0]?.tasks ?? []) {
    const reserved = reservations.get(task.id);
    inputs.set(task.id, task);
    accounting.set(task.id, accountWork(task, reserved?.minutes, reserved?.stale));
  }
  return { accounting, inputs, window: { from, to }, as_of: now.toISOString() };
}
