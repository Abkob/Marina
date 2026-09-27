import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { computeSchedule } from '../services/scheduler.js';
import { loadRoutineReservations, routineCapacity } from '../services/routinePlanning.js';
import { activeProposals } from '../services/activeProposals.js';
import { activeTaskSql, activeGoalSql, activeMilestoneSql, activeMeetingSql, activeEventSql } from '../utils/archiveVisibility.js';
import { buildTaskTimelineResolver, type TaskTimelineRow, type GoalTimelineRow, type MilestoneTimelineRow, type TimelineSource } from '../services/taskTimeline.js';

// Calendar data is independent of the conversational AI route and calls no model.
const router = Router();
const fmtYMD = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// GET /api/ai/schedule-preview — next 35 days with tasks, meetings, proposals, scheduler result
router.get('/schedule-preview', async (req, res) => {
  const dates = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).safeParse(req.query);
  if (!dates.success) return res.status(400).json({ error: 'Use valid YYYY-MM-DD schedule dates.' });
  // Fetch prefs first so we can determine today in the user's configured timezone
  const { rows: prefsRows } = await query("SELECT * FROM user_schedule_prefs WHERE id='default'");
  const prefs = (prefsRows[0] ?? { work_days: '[1,2,3,4,5]', daily_capacity_minutes: 480, buffer_ratio: 0.15 }) as Record<string, unknown>;
  const tz = prefs.timezone as string | undefined;
  const todayStr = tz
    ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
    : fmtYMD(new Date());
  const today = new Date(todayStr + 'T00:00:00');
  const schedulerEnd = new Date(today);
  schedulerEnd.setDate(schedulerEnd.getDate() + 34);
  const schedulerEndStr = fmtYMD(schedulerEnd);

  const isISODate = (value: unknown): value is string =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const displayFromStr = isISODate(req.query.from) ? req.query.from : todayStr;
  const requestedDisplayToStr = isISODate(req.query.to) ? req.query.to : schedulerEndStr;
  const displayFrom = new Date(displayFromStr + 'T00:00:00');
  let displayTo = new Date(requestedDisplayToStr + 'T00:00:00');
  if (Number.isNaN(displayTo.getTime()) || displayTo < displayFrom) displayTo = new Date(displayFrom);
  const maxDisplayTo = new Date(displayFrom);
  maxDisplayTo.setDate(maxDisplayTo.getDate() + 119);
  if (displayTo > maxDisplayTo) displayTo = maxDisplayTo;
  const displayToStr = fmtYMD(displayTo);
  const displayDayCount = Math.max(1, Math.round((displayTo.getTime() - displayFrom.getTime()) / 86400000) + 1);

  const [
    { rows: tasks },
    { rows: meetings },
    { rows: deadlines },
    { rows: proposals },
    { rows: overrides },
    { rows: allSchedulerTasks },
    { rows: blockerEdges },
    { rows: taskDeadlineRows },
    { rows: goalTimelineRows },
    { rows: milestoneTimelineRows },
    { rows: schedulerMeetings },
    { rows: schedulerOverrides },
    { rows: previewPlannedRows },
  ] = await Promise.all([
    query(
      `SELECT id, title, goal_id, milestone_id, parent_task_id, start_date, due_date,
              target_date, hard_deadline, estimated_minutes, priority, status
       FROM tasks WHERE completed=false AND ${activeTaskSql()} ORDER BY due_date ASC NULLS LAST`,
    ),
    query(
      `SELECT id, title, goal_id, scheduled_at, duration_minutes, location
       FROM meetings WHERE ${activeMeetingSql()} AND DATE(scheduled_at::timestamp) BETWEEN $1 AND $2 ORDER BY scheduled_at ASC`,
      [displayFromStr, displayToStr],
    ),
    query(
      `SELECT dl.id, dl.goal_id, dl.date, dl.title, dl.color, g.title as goal_title
       FROM goal_deadlines dl
       LEFT JOIN goals g ON g.id = dl.goal_id
       WHERE ${activeGoalSql("dl.goal_id")} AND dl.date BETWEEN $1 AND $2
       ORDER BY dl.date ASC`,
      [displayFromStr, displayToStr],
    ),
    query(`SELECT id, action_type, action_payload, explanation, confidence, source_type, source_id FROM ai_action_proposals WHERE status='pending'`),
    query(`SELECT date, available_minutes, note FROM schedule_day_overrides WHERE date BETWEEN $1 AND $2`, [displayFromStr, displayToStr]),
    query(
      `SELECT t.id, t.title, t.goal_id, g.title AS goal_title, t.milestone_id, t.parent_task_id,
              t.estimated_minutes, t.start_date, t.due_date, t.target_date, t.hard_deadline, t.priority,
              COALESCE(SUM(ws.minutes), 0) as logged_minutes
       FROM tasks t
       LEFT JOIN goals g ON g.id = t.goal_id
       LEFT JOIN goal_milestones gm ON gm.id = t.milestone_id
       LEFT JOIN work_sessions ws ON ws.task_id = t.id AND ws.minutes IS NOT NULL
       WHERE t.completed = false AND ${activeTaskSql("t.id")}
         AND COALESCE(t.scheduling_enabled, true) = true
         AND COALESCE(g.scheduling_enabled, true) = true
         AND COALESCE(gm.scheduling_enabled, true) = true
         AND t.kind <> 'critical_path'
         AND NOT EXISTS (
           SELECT 1 FROM tasks child
           WHERE child.parent_task_id = t.id
             AND child.completed = false AND ${activeTaskSql("child.id")}
         )
       GROUP BY t.id, t.title, t.goal_id, g.title, t.milestone_id, t.parent_task_id,
                t.estimated_minutes, t.start_date, t.due_date, t.target_date, t.hard_deadline, t.priority`,
    ),
    query(
      `SELECT source_id as blocker_id, target_id as task_id
       FROM edges WHERE relationship='blocks' AND source_type='task' AND target_type='task' AND ${activeTaskSql('source_id')} AND ${activeTaskSql('target_id')}`,
    ),
    query(
      `SELECT id, parent_task_id, goal_id, milestone_id, start_date, due_date, target_date, hard_deadline
       FROM tasks WHERE completed=false AND ${activeTaskSql()}`,
    ),
    query(`SELECT id, start_date, target_date, hard_deadline, deadline FROM goals WHERE archived_at IS NULL`),
    query(`SELECT id, start_date, due_date, hard_deadline FROM goal_milestones WHERE ${activeMilestoneSql()}`),
    query(
      `SELECT id, title, goal_id, scheduled_at, duration_minutes, location
       FROM meetings WHERE ${activeMeetingSql()} AND DATE(scheduled_at::timestamp) BETWEEN $1 AND $2 ORDER BY scheduled_at ASC`,
      [todayStr, schedulerEndStr],
    ),
    query(`SELECT date, available_minutes, note FROM schedule_day_overrides WHERE date BETWEEN $1 AND $2`, [todayStr, schedulerEndStr]),
    query(
      `SELECT etl.task_id,
              COALESCE(SUM(COALESCE(etl.planned_minutes, ROUND(e.duration_hours * 60))), 0)::int AS planned_minutes
       FROM event_task_links etl
       JOIN events e ON e.id = etl.event_id
       WHERE ${activeTaskSql('etl.task_id')} AND ${activeEventSql('e.id')} AND (e.week_start::date + e.day_index) BETWEEN $1::date AND $2::date
       GROUP BY etl.task_id`,
      [todayStr, schedulerEndStr],
    ),
  ]);
  const resolveTaskTimeline = buildTaskTimelineResolver(
    taskDeadlineRows as unknown as TaskTimelineRow[],
    goalTimelineRows as unknown as GoalTimelineRow[],
    milestoneTimelineRows as unknown as MilestoneTimelineRow[],
  );
  const previewTasks = (tasks as Record<string, unknown>[])
    .map(t => {
      const timeline = resolveTaskTimeline(t as Partial<TaskTimelineRow> & { id: unknown });
      return {
        ...t,
        start_date: timeline.start_date,
        due_date: timeline.due_date,
        start_date_source: timeline.start_source,
        due_date_source: timeline.due_source,
        inherited_due_date: timeline.due_source?.scope !== 'task' && Boolean(timeline.due_date),
      };
    })
    .filter(t => typeof t.due_date === 'string' && t.due_date >= displayFromStr && t.due_date <= displayToStr)
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));

  // Build blocker map for scheduler
  const blockerMap = new Map<string, string[]>();
  for (const e of blockerEdges as { blocker_id: string; task_id: string }[]) {
    if (!blockerMap.has(e.task_id)) blockerMap.set(e.task_id, []);
    blockerMap.get(e.task_id)!.push(e.blocker_id);
  }

  // Every saved calendar block consumes capacity. Restricting this to locked
  // events made the sidebar optimizer place suggested work over blocks the
  // user had already accepted through Copilot.
  const { rows: previewLockedEvents } = await query(
    `SELECT day_index, duration_hours, week_start
     FROM events WHERE ${activeEventSql()} AND week_start IS NOT NULL
       AND duration_hours > 0
       AND (week_start::date + day_index) BETWEEN $1::date AND $2::date`,
    [todayStr, schedulerEndStr],
  ) as { rows: { day_index: number; duration_hours: number; week_start: string }[] };

  const previewEventMeetings: { date: string; duration_minutes: number }[] = [];
  for (const ev of previewLockedEvents) {
    const [wy, wm, wd] = ev.week_start.split('-').map(Number);
    const weekMonday = new Date(wy, wm - 1, wd);
    weekMonday.setHours(0, 0, 0, 0);
    const eventDate = new Date(weekMonday);
    eventDate.setDate(weekMonday.getDate() + (ev.day_index % 7));
    const dateStr = fmtYMD(eventDate);
    if (dateStr >= todayStr && dateStr <= schedulerEndStr) {
      previewEventMeetings.push({ date: dateStr, duration_minutes: Math.round(ev.duration_hours * 60) });
    }
  }

  const previewPlannedByTask = new Map(
    (previewPlannedRows as Array<{ task_id: string; planned_minutes: number }>).map(row => [row.task_id, Number(row.planned_minutes ?? 0)]),
  );
  const previewParentByTask = new Map(
    (taskDeadlineRows as unknown as TaskTimelineRow[]).map(row => [row.id, row.parent_task_id]),
  );
  const previewCommittedMinutes = (taskId: string) => {
    let id: string | null = taskId;
    let committed = 0;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      committed += previewPlannedByTask.get(id) ?? 0;
      id = previewParentByTask.get(id) ?? null;
    }
    return committed;
  };

  const schedulerInputTasks = (allSchedulerTasks as Record<string, unknown>[]).map(t => {
    const timeline = resolveTaskTimeline(t as Partial<TaskTimelineRow> & { id: unknown });
    return ({
      id: t.id as string,
      title: t.title as string,
      // Canonical remaining minutes: estimate minus logged work. NULL estimate
      // maps to 0, which the scheduler classifies as unestimated. (The old
      // `|| estimated_minutes` fallback resurrected the FULL estimate for
      // exactly-exhausted tasks — a double count.)
      estimated_minutes: Math.max(
        0,
        Number(t.estimated_minutes ?? 0) - Number(t.logged_minutes ?? 0) - previewCommittedMinutes(String(t.id)),
      ),
      has_estimate: Number(t.estimated_minutes ?? 0) > 0,
      start_date: timeline.start_date,
      due_date: timeline.due_date,
      start_date_source: timeline.start_source,
      due_date_source: timeline.due_source,
      priority: (t.priority as string) ?? 'medium',
      blocker_ids: blockerMap.get(t.id as string) ?? [],
    });
  });
  const [displayRoutines, schedulerRoutines] = await Promise.all([
    loadRoutineReservations(displayFromStr, displayToStr, todayStr),
    loadRoutineReservations(todayStr, schedulerEndStr, todayStr),
  ]);
  const schedulerResult = computeSchedule({
    tasks: schedulerInputTasks,
    meetings: [
      ...(schedulerMeetings as Record<string, unknown>[]).map(m => ({
        date: String(m.scheduled_at).slice(0, 10),
        duration_minutes: Number(m.duration_minutes ?? 0),
      })),
      ...previewEventMeetings,
      ...routineCapacity(schedulerRoutines),
    ],
    prefs: {
      // DB stores work_days as ISO 1=Mon…7=Sun; scheduler uses getDay() 0=Sun…6=Sat. Convert via % 7.
      work_days: (JSON.parse(prefs.work_days as string) as number[]).map(d => d % 7),
      daily_capacity_minutes: Number(prefs.daily_capacity_minutes ?? 480),
      buffer_ratio: Number(prefs.buffer_ratio ?? 0.15),
      timezone: prefs.timezone as string | undefined,
    },
    overrides: (schedulerOverrides as { date: string; available_minutes: number }[]),
    horizon_days: 35,
  });

  const tasksByDate: Record<string, unknown[]> = {};
  for (const t of previewTasks) {
    const d = (t as Record<string, unknown>).due_date as string;
    if (!tasksByDate[d]) tasksByDate[d] = [];
    tasksByDate[d].push(t);
  }

  const meetingsByDate: Record<string, unknown[]> = {};
  for (const m of meetings) {
    const d = String((m as Record<string, unknown>).scheduled_at).slice(0, 10);
    if (!meetingsByDate[d]) meetingsByDate[d] = [];
    meetingsByDate[d].push(m);
  }

  const deadlinesByDate: Record<string, Record<string, unknown>[]> = {};
  for (const dl of deadlines) {
    const d = (dl as Record<string, unknown>).date as string;
    if (!deadlinesByDate[d]) deadlinesByDate[d] = [];
    deadlinesByDate[d].push(dl as Record<string, unknown>);
  }

  const proposalsByDate: Record<string, unknown[]> = {};
  for (const p of await activeProposals(proposals)) {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse((p as Record<string, unknown>).action_payload as string ?? '{}'); } catch { /* */ }
    // start_date first: scheduler proposals place work on their start day
    const targetDate = String(payload.start_date ?? payload.due_date ?? payload.date ?? payload.scheduled_at ?? '').slice(0, 10);
    if (targetDate >= displayFromStr && targetDate <= displayToStr) {
      if (!proposalsByDate[targetDate]) proposalsByDate[targetDate] = [];
      proposalsByDate[targetDate].push({ ...(p as Record<string, unknown>), target_date: targetDate, params: payload });
    }
  }

  const overridesByDate: Record<string, unknown> = {};
  for (const o of overrides) overridesByDate[(o as Record<string, unknown>).date as string] = o;

  const days = Array.from({ length: displayDayCount }, (_, i) => {
    const d = new Date(displayFrom);
    d.setDate(d.getDate() + i);
    const dateStr = fmtYMD(d);
    const dayDeadlines = deadlinesByDate[dateStr] ?? [];
    return {
      date: dateStr,
      tasks: tasksByDate[dateStr] ?? [],
      meetings: meetingsByDate[dateStr] ?? [],
      deadlines: dayDeadlines,
      deadline_titles: dayDeadlines.map(dl => String(dl.title ?? 'Deadline')),
      proposals: proposalsByDate[dateStr] ?? [],
      override: overridesByDate[dateStr] ?? null,
      routines: displayRoutines.filter(routine => routine.date === dateStr),
    };
  });

  // Build a task lookup so the frontend can render day_assignments with titles/details
  const schedulerInputById = new Map(schedulerInputTasks.map(task => [task.id, task]));
  const taskLookup: Record<string, {
    title: string;
    goal_id: string | null;
    goal_title: string | null;
    priority: string;
    estimated_minutes: number;
    logged_minutes: number;
    committed_minutes: number;
    remaining_minutes: number;
    start_date: string | null;
    due_date: string | null;
    start_date_source: TimelineSource | null;
    due_date_source: TimelineSource | null;
  }> = {};
  for (const t of allSchedulerTasks as Record<string, unknown>[]) {
    const id = t.id as string;
    const committedMinutes = previewCommittedMinutes(id);
    taskLookup[t.id as string] = {
      title: t.title as string,
      goal_id: (t as Record<string, unknown>).goal_id as string | null ?? null,
      goal_title: (t.goal_title as string | null) ?? null,
      priority: t.priority as string ?? 'medium',
      estimated_minutes: Number(t.estimated_minutes ?? 0),
      logged_minutes: Number(t.logged_minutes ?? 0),
      committed_minutes: committedMinutes,
      remaining_minutes: schedulerInputById.get(id)?.estimated_minutes ?? 0,
      start_date: schedulerInputById.get(id)?.start_date ?? null,
      due_date: schedulerInputById.get(id)?.due_date ?? null,
      start_date_source: schedulerInputById.get(id)?.start_date_source ?? null,
      due_date_source: schedulerInputById.get(id)?.due_date_source ?? null,
    };
  }

  res.json({ days, scheduler_result: schedulerResult, task_lookup: taskLookup });
});


export { router as schedulePreviewRouter };
