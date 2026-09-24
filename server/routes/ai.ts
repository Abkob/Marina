import { activeProposals } from '../services/activeProposals.js';
import { activeTaskSql, activeGoalSql, activeMilestoneSql, activeMeetingSql, activeEventSql, activeEntitySql, activeResourceSql } from '../utils/archiveVisibility.js';
import { Router } from 'express';
import { runCopilotConversation, type ConversationTurn } from '../services/copilotConversation.js';
import { createCopilotTools, readCopilotClock } from '../services/copilotTools.js';
import { workspaceGraph, selectWorkspaceSections, type WorkspaceSection } from '../services/copilotWorkspaceGraph.js';
import { resolvePlanTaskScope } from '../services/planTaskScope.js';
import crypto from 'crypto';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { validateModelActions, type ValidatedAction } from '../services/actionValidation.js';
import {
  chat,
  parseJSON,
  ollamaHealth,
  getChatCooldownStatus,
  CHAT_MODEL,
  FALLBACK_MODEL,
  NVIDIA_MODEL,
  NVIDIA_CONFIGURED,
  CHAT_MODEL_OPTIONS,
  resolveChatModel,
  type ChatCallTrace,
} from '../ollama.js';
import { buildRetrievalContext } from '../services/retrieval.js';
import { computeSchedule, type SchedulerResult } from '../services/scheduler.js';
import { loadRoutineReservations, routineCapacity } from '../services/routinePlanning.js';
import { layoutPlan, addDaysStr, dateToWeekPosServer, eventDateServer, fmtTimeStr, resolvePlanWindow, expandSeries, type PlanWindowParams, type SeriesParams } from '../services/planLayout.js';
import { suggestEstimate } from '../services/estimateSuggest.js';
import { buildPlanningBuckets, type PlanningTaskInput } from '../services/planningBuckets.js';
import { assertSafeAIContext } from '../utils/contextSafety.js';
import { rateLimit } from '../utils/rateLimit.js';
import { generateDeterministicSummaries, generateEntitySummary } from '../services/summaryGenerator.js';
import { markEmbeddingStale, queueEmbeddingUpsert } from '../services/embeddingLifecycle.js';
import { appendAgentEvent, finishAgentRun, setAgentIntent, startAgentRun } from '../services/agentLedger.js';
import { findExplicitTaskMatches } from '../services/contextTargeting.js';
import { synchronizedTaskDeadlineUpdates } from '../utils/taskDeadline.js';
import { runInBackground } from '../utils/background.js';
import {
  buildTaskTimelineResolver,
  type GoalTimelineRow,
  type MilestoneTimelineRow,
  type TaskTimelineRow,
  type TimelineSource,
} from '../services/taskTimeline.js';

const router = Router();

/** Format a Date as YYYY-MM-DD using local (server) time. */
const fmtYMD = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

interface ContextTaskNode {
  id: string;
  title: string;
  milestone_id: string | null;
  status: string;
  priority: string;
  start_date: string | null;
  deadline: string | null;
  deadline_kind: string | null;
  remaining_minutes: number | null;
  logged_minutes: number;
  feel_score: number | null;
  blocker_ids: string[];
  is_rollup: boolean;
  scheduled_blocks: Array<{
    date: string;
    time: string | null;
    minutes: number | null;
    source: 'calendar' | 'day';
  }>;
  children: ContextTaskNode[];
  [key: string]: unknown;
}

interface ChatRuntimeCall extends ChatCallTrace {
  phase: 'intent' | 'answer';
}

interface ChatRuntime {
  total_ms: number;
  primary_model: string;
  fallback_model: string | null;
  local_fallback_model: string | null;
  model_calls: ChatRuntimeCall[];
}

type TaskDeadlineRow = {
  id: string;
  parent_task_id: string | null;
  due_date: string | null;
  goal_id?: string | null;
  milestone_id?: string | null;
  start_date?: string | null;
  target_date?: string | null;
  hard_deadline?: string | null;
};

function buildTaskDueDateResolver(rows: TaskDeadlineRow[]) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const memo = new Map<string, string | null>();

  return function resolveTaskDueDate(taskLike: { id?: unknown; parent_task_id?: unknown; due_date?: unknown }): string | null {
    const id = String(taskLike.id ?? '');
    const ownDue = typeof taskLike.due_date === 'string' && taskLike.due_date ? taskLike.due_date : null;
    if (ownDue) return ownDue;
    if (!id) return null;
    const cached = memo.get(id);
    if (cached !== undefined) return cached;

    let parentId = (typeof taskLike.parent_task_id === 'string' ? taskLike.parent_task_id : null)
      ?? byId.get(id)?.parent_task_id
      ?? null;
    const seen = new Set<string>([id]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (parent.due_date) {
        memo.set(id, parent.due_date);
        return parent.due_date;
      }
      parentId = parent.parent_task_id;
    }

    memo.set(id, null);
    return null;
  };
}

/** Citation: a typed reference to a context source, with lane provenance. */
export interface ChatCitation {
  entity_type: string;
  entity_id: string;
  title: string;
  matched_via: string[];        // 'sql' | 'graph' | 'vector' | 'topic' | 'recency'
  similarity?: number;          // cosine, when the vector lane matched
  topics?: string[];            // accepted topic memberships
}

async function getScheduleContext(userQuery?: string) {
  // ── Schedule preferences ───────────────────────────────────────────────────
  const { rows: prefsRows } = await query("SELECT * FROM user_schedule_prefs WHERE id='default'");
  const prefs = (prefsRows[0] ?? {
    work_days: '[1,2,3,4,5]', work_start: 9, work_end: 18,
    daily_capacity_minutes: 480, deep_work_start: 9, deep_work_end: 12, buffer_ratio: 0.15,
    timezone: undefined,
  }) as Record<string, unknown>;

  // Determine today in the user's configured timezone so "today" matches their wall clock.
  const tz = prefs.timezone as string | undefined;
  const todayStr = tz
    ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
    : (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const today = new Date(todayStr + 'T00:00:00');
  const dailyCapacity = Number(prefs.daily_capacity_minutes ?? 480);
  const bufferRatio = Number(prefs.buffer_ratio ?? 0.15);
  const effectiveCapacity = Math.round(dailyCapacity * (1 - bufferRatio));

  // ── Active goals with planning summaries ───────────────────────────────────
  const { rows: goals } = await query(
    `SELECT g.*, es.summary_text as planning_summary
     FROM goals g
     LEFT JOIN entity_summaries es ON es.entity_type='goal' AND es.entity_id=g.id AND es.summary_type='planning'
     WHERE g.archived_at IS NULL ORDER BY g.deadline ASC, g.created_at ASC`,
  ) as { rows: Record<string, unknown>[] };

  const goalIds = goals.map(g => g.id as string);

  // ── Milestones with planning summaries ────────────────────────────────────
  const { rows: allMilestones } = goalIds.length ? await query(
    `SELECT m.*, es.summary_text as planning_summary
     FROM goal_milestones m
     LEFT JOIN entity_summaries es ON es.entity_type='milestone' AND es.entity_id=m.id AND es.summary_type='planning'
     WHERE m.goal_id = ANY($1) ORDER BY m.position ASC, m.due_date ASC`,
    [goalIds],
  ) as { rows: Record<string, unknown>[] } : { rows: [] };

  // ── Task metrics per goal (lightweight: counts + totals only) ─────────────
  const { rows: taskMetrics } = goalIds.length ? await query(
    `SELECT t.goal_id,
            COUNT(*) FILTER (WHERE NOT t.completed) as incomplete_count,
            COALESCE(SUM(t.estimated_minutes) FILTER (
              WHERE NOT t.completed
                AND NOT EXISTS (
                  SELECT 1 FROM tasks child
                  WHERE child.parent_task_id = t.id
                    AND child.completed = false AND ${activeTaskSql('child.id')}
                )
            ), 0) as mins_remaining,
            COALESCE(SUM(ws.logged) FILTER (
              WHERE NOT t.completed
                AND NOT EXISTS (
                  SELECT 1 FROM tasks child
                  WHERE child.parent_task_id = t.id
                    AND child.completed = false AND ${activeTaskSql('child.id')}
                )
            ), 0) as mins_logged
     FROM tasks t
     LEFT JOIN (SELECT task_id, SUM(minutes) as logged FROM work_sessions WHERE minutes IS NOT NULL GROUP BY task_id) ws ON ws.task_id=t.id
     WHERE t.goal_id = ANY($1) AND ${activeTaskSql('t.id')}
     GROUP BY t.goal_id`,
    [goalIds],
  ) as { rows: { goal_id: string; incomplete_count: number; mins_remaining: number; mins_logged: number }[] }
  : { rows: [] };
  const metricsMap: Record<string, typeof taskMetrics[0]> = {};
  for (const m of taskMetrics) metricsMap[m.goal_id] = m;

  // ── Task coverage buckets (counts for AI honesty — Epic 40.3) ─────────────
  // These counts let the AI report omissions accurately instead of silently
  // reasoning about a partial view.
  const coverageParams: unknown[] = [todayStr];
  const coverageSql = `
    SELECT
      COUNT(*)::int                                                     AS total_incomplete,
      COUNT(*) FILTER (WHERE COALESCE(t.hard_deadline,t.target_date,t.due_date) < $1)::int AS overdue,
      COUNT(*) FILTER (WHERE COALESCE(t.hard_deadline,t.target_date,t.due_date) >= $1)::int AS upcoming_dated,
      COUNT(*) FILTER (WHERE COALESCE(t.hard_deadline,t.target_date,t.due_date) IS NULL)::int AS undated,
      COUNT(*) FILTER (WHERE t.estimated_minutes IS NULL OR t.estimated_minutes = 0)::int AS unestimated,
      COUNT(*) FILTER (WHERE t.status = 'in_progress')::int             AS in_progress,
      COUNT(*) FILTER (WHERE t.status = 'blocked')::int                 AS blocked
    FROM tasks t
    LEFT JOIN goals g ON g.id = t.goal_id
    WHERE t.completed = false AND ${activeTaskSql('t.id')}
      AND t.status <> 'done'
      AND (g.archived_at IS NULL OR t.goal_id IS NULL)
  `;
  const { rows: coverageRows } = await query(coverageSql, coverageParams) as { rows: Record<string, number>[] };
  const coverage = coverageRows[0] ?? {};

  // A compact, all-task planning index for the model. Retrieval below is
  // relevance-focused; these buckets are deadline-focused so a future-deadline
  // parent task is not mislabeled as "due" on a requested planning day.
  const { rows: planningTaskRows } = await query(
    `SELECT t.id, t.title, t.goal_id, g.title AS goal_title, t.parent_task_id, t.milestone_id,
            t.status, t.priority, t.feel_score, t.kind, t.due_date, t.start_date, t.target_date, t.hard_deadline,
            t.scheduling_enabled, t.estimated_minutes, t.last_activity_at, t.updated_at,
            COALESCE(ws.logged_minutes, 0) AS logged_minutes,
            COUNT(child.id)::int AS child_count
     FROM tasks t
     LEFT JOIN goals g ON g.id = t.goal_id
     LEFT JOIN (
       SELECT task_id, SUM(minutes) AS logged_minutes
       FROM work_sessions
       WHERE minutes IS NOT NULL
       GROUP BY task_id
     ) ws ON ws.task_id = t.id
     LEFT JOIN tasks child ON child.parent_task_id = t.id AND child.completed = false AND ${activeTaskSql('child.id')}
     WHERE t.completed = false AND ${activeTaskSql('t.id')}
       AND (g.archived_at IS NULL OR t.goal_id IS NULL)
     GROUP BY t.id, t.title, t.goal_id, g.title, t.parent_task_id, t.milestone_id,
              t.status, t.priority, t.feel_score, t.kind, t.due_date, t.start_date, t.target_date, t.hard_deadline,
              t.scheduling_enabled, t.estimated_minutes, t.last_activity_at, t.updated_at, ws.logged_minutes
     ORDER BY COALESCE(t.hard_deadline, t.target_date, t.due_date, '9999-12-31') ASC,
              CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC
     LIMIT 200`,
  ) as unknown as { rows: PlanningTaskInput[] };
  const planningBuckets = buildPlanningBuckets(planningTaskRows, {
    today: todayStr,
    effectiveCapacityMinutes: effectiveCapacity,
    horizonDays: 14,
    nearDeadlineDays: 14,
    bufferRatio: 0.15,
  });

  // ── Upcoming tasks via hybrid retrieval (top 30 across all goals) ─────────
  const retrievalResult = await buildRetrievalContext({
    query: userQuery,
    goalIds: goalIds.length ? goalIds : undefined,
    horizonDays: 14,
    limit: 30,
  });
  const upcomingTaskCards = retrievalResult.cards;

  // ── Meetings next 14 days ─────────────────────────────────────────────────
  const fourteenDaysLater = new Date(today);
  fourteenDaysLater.setDate(fourteenDaysLater.getDate() + 14);
  const { rows: meetings } = await query(
    `SELECT id, title, goal_id, scheduled_at, duration_minutes, location
     FROM meetings WHERE ${activeMeetingSql()} AND scheduled_at >= $1 AND scheduled_at <= $2 ORDER BY scheduled_at ASC`,
    [todayStr, fourteenDaysLater.toISOString()],
  );

  // ── Recent journal (summaries only — no raw text) ─────────────────────────
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const { rows: recentJournals } = await query(
    `SELECT id, entry_date, summary FROM journal_entries
     WHERE entry_date >= $1 AND summary IS NOT NULL
     ORDER BY entry_date DESC LIMIT 10`,
    [fmtYMD(sevenDaysAgo)],
  ) as { rows: { id: string; entry_date: string; summary: string }[] };

  // ── Schedule day overrides ─────────────────────────────────────────────────
  const twoWeeksLater = new Date(today);
  twoWeeksLater.setDate(twoWeeksLater.getDate() + 14);
  const { rows: overrides } = await query(
    `SELECT date, available_minutes, note FROM schedule_day_overrides WHERE date BETWEEN $1 AND $2`,
    [todayStr, fmtYMD(twoWeeksLater)],
  );

  // ── Calendar events ────────────────────────────────────────────────────────
  // All dated blocks are exposed to the model for "show my schedule" answers.
  // Only locked/unavailable events reduce deterministic scheduler capacity.
  // Query one week earlier because a Tuesday event belongs to a Monday
  // week_start that can be before today.
  const eventWeekQueryFrom = addDaysStr(todayStr, -6);
  const { rows: calendarEvents } = await query(
    `SELECT id, title, type, day_index, start_hour, duration_hours, week_start, locked, source
     FROM events
     WHERE week_start IS NOT NULL AND ${activeEventSql()}
       AND week_start BETWEEN $1 AND $2
     ORDER BY week_start ASC, day_index ASC, start_hour ASC`,
    [eventWeekQueryFrom, fmtYMD(twoWeeksLater)],
  ) as { rows: {
    id: string;
    title: string;
    type: string;
    day_index: number;
    start_hour: number;
    duration_hours: number;
    week_start: string;
    locked: boolean;
    source: string | null;
  }[] };

  const calendarEventIds = calendarEvents.map(ev => ev.id);
  const { rows: calendarEventLinks } = calendarEventIds.length
    ? await query(
      `SELECT etl.event_id, etl.task_id, etl.planned_minutes,
              t.title AS task_title, t.goal_id, g.title AS goal_title, t.parent_task_id
       FROM event_task_links etl
       JOIN tasks t ON t.id = etl.task_id
       LEFT JOIN goals g ON g.id = t.goal_id
       WHERE etl.event_id = ANY($1) AND ${activeTaskSql('etl.task_id')}`,
      [calendarEventIds],
    ) as { rows: {
      event_id: string;
      task_id: string;
      planned_minutes: number | null;
      task_title: string;
      goal_id: string | null;
      goal_title: string | null;
      parent_task_id: string | null;
    }[] }
    : { rows: [] as {
      event_id: string;
      task_id: string;
      planned_minutes: number | null;
      task_title: string;
      goal_id: string | null;
      goal_title: string | null;
      parent_task_id: string | null;
    }[] };

  // Convert event records to dated meeting-equivalent entries for the scheduler.
  // Duplicate logic: if the same day also has a meeting covering similar hours we'll
  // over-subtract, but both are real capacity reducers so the conservative estimate is correct.
  const eventMeetings: { date: string; duration_minutes: number }[] = [];
  for (const ev of calendarEvents) {
    if (!(ev.locked || ev.type === 'unavailable')) continue;
    const dateStr = eventDateServer(ev.week_start, ev.day_index);
    if (dateStr >= todayStr && dateStr <= fmtYMD(twoWeeksLater)) {
      eventMeetings.push({
        date: dateStr,
        duration_minutes: Math.round(ev.duration_hours * 60),
      });
    }
  }

  // ── Build goal contexts ───────────────────────────────────────────────────
  const { rows: planningBlockerEdges } = await query(
    `SELECT source_id as blocker_id, target_id as task_id
     FROM edges
     WHERE relationship='blocks' AND source_type='task' AND target_type='task'
       AND ${activeTaskSql('source_id')} AND ${activeTaskSql('target_id')}`,
  ) as { rows: { blocker_id: string; task_id: string }[] };
  const planningBlockerMap = new Map<string, string[]>();
  for (const edge of planningBlockerEdges) {
    if (!planningBlockerMap.has(edge.task_id)) planningBlockerMap.set(edge.task_id, []);
    planningBlockerMap.get(edge.task_id)!.push(edge.blocker_id);
  }

  const planningTaskById = new Map(planningTaskRows.map(t => [t.id, t]));
  const resolvePlanningDueDate = buildTaskDueDateResolver(
    planningTaskRows.map(t => ({
      id: t.id,
      parent_task_id: t.parent_task_id ?? null,
      due_date: t.due_date ?? null,
    })),
  );
  const effectivePlanningDeadline = (task: PlanningTaskInput): {
    deadline: string | null;
    deadline_kind: 'hard_deadline' | 'target_date' | 'due_date' | 'inherited_due_date' | null;
  } => {
    if (task.hard_deadline) return { deadline: task.hard_deadline, deadline_kind: 'hard_deadline' };
    if (task.target_date) return { deadline: task.target_date, deadline_kind: 'target_date' };
    const inheritedDue = resolvePlanningDueDate(task);
    if (!inheritedDue) return { deadline: null, deadline_kind: null };
    return { deadline: inheritedDue, deadline_kind: task.due_date ? 'due_date' : 'inherited_due_date' };
  };
  const remainingPlanningMinutes = (task: PlanningTaskInput): number | null => {
    const estimate = Number(task.estimated_minutes ?? 0);
    if (!(estimate > 0)) return null;
    return Math.max(0, Math.round(estimate - Number(task.logged_minutes ?? 0)));
  };
  const isParentPlanningTask = (task: PlanningTaskInput) => Number(task.child_count ?? 0) > 0;
  const isSchedulablePlanningLeaf = (task: PlanningTaskInput) =>
    !isParentPlanningTask(task)
    && task.scheduling_enabled !== false
    && task.kind !== 'critical_path';
  const overdueTasks = planningTaskRows
    .map(task => {
      const { deadline, deadline_kind } = effectivePlanningDeadline(task);
      if (!deadline || deadline >= todayStr) return null;
      const daysOverdue = Math.max(1, Math.round(
        (new Date(todayStr + 'T00:00:00').getTime() - new Date(deadline + 'T00:00:00').getTime()) / 86_400_000,
      ));
      return {
        id: task.id,
        title: task.title,
        goal_id: task.goal_id ?? null,
        goal_title: task.goal_title ?? null,
        parent_task_id: task.parent_task_id ?? null,
        deadline,
        deadline_kind,
        days_overdue: daysOverdue,
        status: task.status,
        remaining_minutes: remainingPlanningMinutes(task),
        is_parent_rollup: isParentPlanningTask(task),
      };
    })
    .filter((task): task is NonNullable<typeof task> => Boolean(task))
    .sort((a, b) => a.deadline.localeCompare(b.deadline) || a.title.localeCompare(b.title));
  const staleCutoff = new Date(today);
  staleCutoff.setDate(staleCutoff.getDate() - 7);
  const staleCutoffStr = staleCutoff.toISOString();
  const dueSoonLimit = addDaysStr(todayStr, 3);
  const attentionQueue = planningTaskRows.flatMap(task => {
    const { deadline, deadline_kind } = effectivePlanningDeadline(task);
    const remaining = remainingPlanningMinutes(task);
    const signals: string[] = [];
    if (deadline && deadline < todayStr) signals.push('OVERDUE');
    else if (deadline && deadline <= dueSoonLimit) signals.push('DUE_SOON');
    if (task.start_date && task.start_date >= todayStr && task.start_date <= dueSoonLimit) signals.push('STARTING_SOON');
    if (task.status === 'blocked') signals.push('BLOCKED');
    const activityAt = task.last_activity_at ?? task.updated_at ?? null;
    if (task.status === 'in_progress' && activityAt && activityAt < staleCutoffStr) signals.push('STALE_IN_PROGRESS');
    if ((task.priority === 'urgent' || task.priority === 'high' || task.priority === 'critical') && remaining === null) {
      signals.push('HIGH_PRIORITY_UNESTIMATED');
    }
    if (!signals.length) return [];
    return [{
      id: task.id,
      title: task.title,
      goal_id: task.goal_id ?? null,
      goal_title: task.goal_title ?? null,
      status: task.status ?? 'todo',
      priority: task.priority ?? 'medium',
      deadline,
      deadline_kind,
      remaining_minutes: remaining,
      signals,
    }];
  });
  const normalizeSchedulerPriority = (priority: string | null | undefined): 'high' | 'medium' | 'low' => {
    if (priority === 'urgent' || priority === 'high') return 'high';
    if (priority === 'low') return 'low';
    return 'medium';
  };
  const canonicalSchedulerTasks = planningTaskRows.flatMap(task => {
    if (!isSchedulablePlanningLeaf(task)) return [];
    const { deadline } = effectivePlanningDeadline(task);
    if (!deadline) return [];
    const remaining = remainingPlanningMinutes(task);
    return [{
      id: task.id,
      title: task.title,
      estimated_minutes: remaining ?? 0,
      due_date: deadline,
      priority: normalizeSchedulerPriority(task.priority),
      blocker_ids: planningBlockerMap.get(task.id) ?? [],
    }];
  });

  const rootPlanningTask = (task: PlanningTaskInput): PlanningTaskInput => {
    let current = task;
    const seen = new Set<string>([task.id]);
    while (current.parent_task_id && !seen.has(current.parent_task_id)) {
      seen.add(current.parent_task_id);
      const parent = planningTaskById.get(current.parent_task_id);
      if (!parent) break;
      current = parent;
    }
    return current;
  };
  const isDescendantOf = (task: PlanningTaskInput, parentId: string): boolean => {
    let parentIdCursor = task.parent_task_id ?? null;
    const seen = new Set<string>([task.id]);
    while (parentIdCursor && !seen.has(parentIdCursor)) {
      if (parentIdCursor === parentId) return true;
      seen.add(parentIdCursor);
      parentIdCursor = planningTaskById.get(parentIdCursor)?.parent_task_id ?? null;
    }
    return false;
  };

  const workDaysIso = (() => {
    try {
      const parsed = JSON.parse(prefs.work_days as string);
      return Array.isArray(parsed) ? parsed.map(Number) : [1, 2, 3, 4, 5];
    } catch {
      return [1, 2, 3, 4, 5];
    }
  })();
  const isoWeekday = (date: string) => {
    const day = new Date(date + 'T00:00:00').getDay();
    return day === 0 ? 7 : day;
  };
  const contextRoutines = await loadRoutineReservations(todayStr, addDaysStr(todayStr, 13), todayStr);
  const fixedByDate = new Map<string, { meeting_minutes: number; locked_block_minutes: number; routine_minutes: number }>();
  const addFixed = (date: string, key: 'meeting_minutes' | 'locked_block_minutes' | 'routine_minutes', minutes: number) => {
    if (!fixedByDate.has(date)) fixedByDate.set(date, { meeting_minutes: 0, locked_block_minutes: 0, routine_minutes: 0 });
    fixedByDate.get(date)![key] += minutes;
  };
  for (const meeting of meetings as Record<string, unknown>[]) {
    addFixed(
      String(meeting.scheduled_at).slice(0, 10),
      'meeting_minutes',
      Number(meeting.duration_minutes ?? 0),
    );
  }
  for (const eventMeeting of eventMeetings) {
    addFixed(eventMeeting.date, 'locked_block_minutes', eventMeeting.duration_minutes);
  }
  for (const routine of contextRoutines) addFixed(routine.date, 'routine_minutes', routine.minutes);
  const overrideByDate = new Map((overrides as { date: string; available_minutes: number; note?: string | null }[]).map(o => [o.date, o]));
  const calendarLinksByEvent = new Map<string, typeof calendarEventLinks>();
  for (const link of calendarEventLinks) {
    if (!calendarLinksByEvent.has(link.event_id)) calendarLinksByEvent.set(link.event_id, []);
    calendarLinksByEvent.get(link.event_id)!.push(link);
  }
  const scheduleRowsByDate = new Map<string, {
    timeline_blocks: Array<{
      id: string;
      title: string;
      type: 'meeting' | 'linked_task_block' | 'calendar_block' | 'unavailable';
      indicator: 'FIXED' | 'SCHEDULED' | 'UNLINKED';
      start_hour: number;
      end_hour: number;
      duration_minutes: number;
      time_label: string;
      linked_tasks?: Array<{
        task_id: string;
        title: string;
        origin_title: string | null;
        goal_title: string | null;
      }>;
    }>;
    day_level_tasks: Array<{
      id: string;
      title: string;
      origin_title: string;
      goal_title: string | null;
      remaining_minutes: number | null;
      indicator: 'DAY-LEVEL';
    }>;
  }>();
  const ensureScheduleRows = (date: string) => {
    if (!scheduleRowsByDate.has(date)) {
      scheduleRowsByDate.set(date, { timeline_blocks: [], day_level_tasks: [] });
    }
    return scheduleRowsByDate.get(date)!;
  };
  const linkedTaskDateKeys = new Set<string>();
  const plannedLeafTaskIds = new Set<string>();

  for (const meeting of meetings as Record<string, unknown>[]) {
    const scheduledAt = String(meeting.scheduled_at);
    const date = scheduledAt.slice(0, 10);
    if (date < todayStr || date > fmtYMD(twoWeeksLater)) continue;
    const parsed = new Date(scheduledAt);
    const startHour = Number.isNaN(parsed.getTime()) ? 0 : parsed.getHours() + parsed.getMinutes() / 60;
    const durationMinutes = Math.max(0, Number(meeting.duration_minutes ?? 0));
    ensureScheduleRows(date).timeline_blocks.push({
      id: String(meeting.id),
      title: String(meeting.title ?? 'Meeting'),
      type: 'meeting',
      indicator: 'FIXED',
      start_hour: startHour,
      end_hour: startHour + durationMinutes / 60,
      duration_minutes: durationMinutes,
      time_label: fmtTimeStr(startHour, durationMinutes / 60),
    });
  }

  for (const ev of calendarEvents) {
    const date = eventDateServer(ev.week_start, ev.day_index);
    if (date < todayStr || date > fmtYMD(twoWeeksLater)) continue;
    const links = calendarLinksByEvent.get(ev.id) ?? [];
    for (const link of links) {
      linkedTaskDateKeys.add(`${link.task_id}|${date}`);
      plannedLeafTaskIds.add(link.task_id);
      // A block linked to a river/container represents planned work for its
      // executable leaves as well; otherwise Today calls the same work
      // "unscheduled" while visibly showing its parent block on the calendar.
      for (const candidate of planningTaskRows) {
        if (isSchedulablePlanningLeaf(candidate) && isDescendantOf(candidate, link.task_id)) {
          plannedLeafTaskIds.add(candidate.id);
        }
      }
    }
    const durationMinutes = Math.max(0, Math.round(Number(ev.duration_hours ?? 0) * 60));
    const linkedTasks = links.map(link => {
      const task = planningTaskById.get(link.task_id);
      const origin = task ? rootPlanningTask(task) : null;
      return {
        task_id: link.task_id,
        title: task?.title ?? link.task_title,
        origin_title: origin?.title ?? (task?.title ?? null),
        goal_title: task?.goal_title ?? link.goal_title ?? null,
      };
    });
    ensureScheduleRows(date).timeline_blocks.push({
      id: ev.id,
      title: ev.title || linkedTasks.map(t => t.title).join(', ') || 'Calendar block',
      type: ev.type === 'unavailable' ? 'unavailable' : linkedTasks.length ? 'linked_task_block' : 'calendar_block',
      indicator: ev.locked || ev.type === 'unavailable' ? 'FIXED' : linkedTasks.length ? 'SCHEDULED' : 'UNLINKED',
      start_hour: Number(ev.start_hour ?? 0),
      end_hour: Number(ev.start_hour ?? 0) + Number(ev.duration_hours ?? 0),
      duration_minutes: durationMinutes,
      time_label: fmtTimeStr(Number(ev.start_hour ?? 0), Number(ev.duration_hours ?? 0)),
      ...(linkedTasks.length ? { linked_tasks: linkedTasks } : {}),
    });
  }

  for (const task of planningTaskRows) {
    if (!isSchedulablePlanningLeaf(task)) continue;
    const date = task.start_date ?? null;
    if (!date || date < todayStr || date > fmtYMD(twoWeeksLater)) continue;
    plannedLeafTaskIds.add(task.id);
    if (linkedTaskDateKeys.has(`${task.id}|${date}`)) continue;
    const origin = rootPlanningTask(task);
    ensureScheduleRows(date).day_level_tasks.push({
      id: task.id,
      title: task.title,
      origin_title: origin.title,
      goal_title: task.goal_title ?? origin.goal_title ?? null,
      remaining_minutes: remainingPlanningMinutes(task),
      indicator: 'DAY-LEVEL',
    });
  }

  const dailyWorkload = Array.from({ length: 14 }, (_, offset) => {
    const date = addDaysStr(todayStr, offset);
    const override = overrideByDate.get(date);
    const isWorkday = workDaysIso.includes(isoWeekday(date));
    const rawCapacityMinutes = override ? Number(override.available_minutes ?? 0) : (isWorkday ? dailyCapacity : 0);
    const bufferMinutes = override ? 0 : Math.max(0, Math.round(rawCapacityMinutes * bufferRatio));
    const effectiveCapacityMinutes = override ? rawCapacityMinutes : Math.max(0, rawCapacityMinutes - bufferMinutes);
    const fixed = fixedByDate.get(date) ?? { meeting_minutes: 0, locked_block_minutes: 0, routine_minutes: 0 };
    const fixedCommitmentMinutes = fixed.meeting_minutes + fixed.locked_block_minutes + fixed.routine_minutes;
    const availableAfterFixedMinutes = Math.max(0, effectiveCapacityMinutes - fixedCommitmentMinutes);

    const originGroups = new Map<string, {
      origin_id: string;
      origin_title: string;
      goal_title: string | null;
      kind: 'parent_task' | 'single_task';
      total_minutes: number;
      unestimated_count: number;
      tasks: Array<{
        id: string;
        title: string;
        remaining_minutes: number | null;
        deadline: string;
        deadline_kind: string;
        relation: 'origin_task' | 'subtask';
      }>;
    }>();

    for (const task of planningTaskRows) {
      if (!isSchedulablePlanningLeaf(task)) continue;
      const { deadline, deadline_kind } = effectivePlanningDeadline(task);
      if (!deadline) continue;
      const belongsOnDate = deadline === date || (date === todayStr && deadline < todayStr);
      if (!belongsOnDate) continue;
      // The Today backlog is specifically work that still lacks a placement.
      // Keep deadline truth in overdue views, but do not duplicate tasks here
      // once they have a saved block/day placement in the visible horizon.
      if (date === todayStr && plannedLeafTaskIds.has(task.id)) continue;
      const remaining = remainingPlanningMinutes(task);
      const origin = rootPlanningTask(task);
      const originIsSame = origin.id === task.id;
      const key = originIsSame ? `task:${task.id}` : `origin:${origin.id}`;
      if (!originGroups.has(key)) {
        originGroups.set(key, {
          origin_id: origin.id,
          origin_title: originIsSame ? task.title : origin.title,
          goal_title: task.goal_title ?? origin.goal_title ?? null,
          kind: originIsSame ? 'single_task' : 'parent_task',
          total_minutes: 0,
          unestimated_count: 0,
          tasks: [],
        });
      }
      const group = originGroups.get(key)!;
      if (remaining === null) group.unestimated_count += 1;
      else group.total_minutes += remaining;
      group.tasks.push({
        id: task.id,
        title: task.title,
        remaining_minutes: remaining,
        deadline,
        deadline_kind: deadline_kind ?? 'due_date',
        relation: originIsSame ? 'origin_task' : 'subtask',
      });
    }

    const rollupContext = planningTaskRows
      .filter(task => isParentPlanningTask(task))
      .filter(task => {
        const { deadline } = effectivePlanningDeadline(task);
        return deadline === date || (date === todayStr && Boolean(deadline && deadline < todayStr));
      })
      .map(task => {
        const childLeaves = planningTaskRows.filter(child => isSchedulablePlanningLeaf(child) && isDescendantOf(child, task.id));
        const childKnownMinutes = childLeaves.reduce((sum, child) => sum + (remainingPlanningMinutes(child) ?? 0), 0);
        const childUnestimatedCount = childLeaves.filter(child => remainingPlanningMinutes(child) === null).length;
        return {
          id: task.id,
          title: task.title,
          goal_title: task.goal_title ?? null,
          own_remaining_minutes: remainingPlanningMinutes(task),
          child_leaf_minutes: childKnownMinutes,
          child_unestimated_count: childUnestimatedCount,
          child_count: Number(task.child_count ?? 0),
          note: 'Rollup/context only: do not add own_remaining_minutes to child_leaf_minutes.',
        };
      })
      .slice(0, 8);

    const groups = [...originGroups.values()]
      .sort((a, b) => b.total_minutes - a.total_minutes || a.origin_title.localeCompare(b.origin_title))
      .slice(0, 10)
      .map(group => ({
        ...group,
        tasks: group.tasks
          .sort((a, b) => (b.remaining_minutes ?? -1) - (a.remaining_minutes ?? -1) || a.title.localeCompare(b.title))
          .slice(0, 8),
      }));
    const dueLeafMinutes = [...originGroups.values()].reduce((sum, group) => sum + group.total_minutes, 0);

    return {
      date,
      capacity: {
        raw_capacity_minutes: rawCapacityMinutes,
        reserved_buffer_minutes: bufferMinutes,
        effective_capacity_minutes: effectiveCapacityMinutes,
        fixed_commitment_minutes: fixedCommitmentMinutes,
        meeting_minutes: fixed.meeting_minutes,
        locked_block_minutes: fixed.locked_block_minutes,
        routine_minutes: fixed.routine_minutes,
        available_after_fixed_minutes: availableAfterFixedMinutes,
        override_note: override?.note ?? null,
      },
      due_leaf_minutes: dueLeafMinutes,
      over_capacity_minutes: Math.max(0, dueLeafMinutes - availableAfterFixedMinutes),
      origin_groups: groups,
      rollup_context: rollupContext,
    };
  });
  const currentScheduleDays = dailyWorkload.map(day => {
    const rows = scheduleRowsByDate.get(day.date) ?? { timeline_blocks: [], day_level_tasks: [] };
    const timelineBlocks = [...rows.timeline_blocks]
      .sort((a, b) => a.start_hour - b.start_hour || a.title.localeCompare(b.title))
      .slice(0, 16);
    const dayLevelTasks = [...rows.day_level_tasks]
      .sort((a, b) => (b.remaining_minutes ?? -1) - (a.remaining_minutes ?? -1) || a.title.localeCompare(b.title))
      .slice(0, 16);
    const timelineMinutes = rows.timeline_blocks.reduce((sum, block) => sum + block.duration_minutes, 0);
    const dayLevelMinutes = rows.day_level_tasks.reduce((sum, task) => sum + (task.remaining_minutes ?? 0), 0);
    const scheduledMinutes = timelineMinutes + dayLevelMinutes;
    return {
      date: day.date,
      scheduled_minutes: scheduledMinutes,
      free_after_scheduled_minutes: day.capacity.effective_capacity_minutes - scheduledMinutes,
      timeline_blocks: timelineBlocks,
      day_level_tasks: dayLevelTasks,
      coverage: { timeline_blocks: rows.timeline_blocks.length, day_level_tasks: rows.day_level_tasks.length, shown_per_list_limit: 16 },
      due_work: {
        due_leaf_minutes: day.due_leaf_minutes,
        over_capacity_minutes: day.over_capacity_minutes,
      },
    };
  });

  // ── Compact goal → task hierarchy used on every model turn ────────────────
  // Rich prose is intentionally excluded here. The baseline gives the model
  // complete planning facts; named tasks are expanded separately below.
  const scheduledBlocksByTask = new Map<string, ContextTaskNode['scheduled_blocks']>();
  const addScheduledBlock = (taskId: string, block: ContextTaskNode['scheduled_blocks'][number]) => {
    if (!scheduledBlocksByTask.has(taskId)) scheduledBlocksByTask.set(taskId, []);
    const blocks = scheduledBlocksByTask.get(taskId)!;
    if (!blocks.some(existing =>
      existing.date === block.date
      && existing.time === block.time
      && existing.source === block.source)) {
      blocks.push(block);
    }
  };
  const calendarEventById = new Map(calendarEvents.map(event => [event.id, event]));
  for (const link of calendarEventLinks) {
    const event = calendarEventById.get(link.event_id);
    if (!event) continue;
    const date = eventDateServer(event.week_start, event.day_index);
    if (date < todayStr || date > fmtYMD(twoWeeksLater)) continue;
    addScheduledBlock(link.task_id, {
      date,
      time: fmtTimeStr(Number(event.start_hour ?? 0), Number(event.duration_hours ?? 0)),
      minutes: link.planned_minutes ?? Math.round(Number(event.duration_hours ?? 0) * 60),
      source: 'calendar',
    });
  }
  for (const task of planningTaskRows) {
    if (!task.start_date || task.start_date < todayStr || task.start_date > fmtYMD(twoWeeksLater)) continue;
    addScheduledBlock(task.id, {
      date: task.start_date,
      time: null,
      minutes: remainingPlanningMinutes(task),
      source: 'day',
    });
  }

  const taskNodeById = new Map<string, ContextTaskNode>();
  for (const task of planningTaskRows) {
    const { deadline, deadline_kind } = effectivePlanningDeadline(task);
    taskNodeById.set(task.id, {
      id: task.id,
      title: task.title,
      parent_task_id: task.parent_task_id ?? null,
      due_date: task.due_date ?? null,
      target_date: task.target_date ?? null,
      hard_deadline: task.hard_deadline ?? null,
      estimated_minutes: task.estimated_minutes ?? null,
      scheduling_enabled: task.scheduling_enabled ?? true,
      kind: task.kind ?? null,
      milestone_id: task.milestone_id ?? null,
      status: task.status ?? 'todo',
      priority: task.priority ?? 'medium',
      start_date: task.start_date ?? null,
      deadline,
      deadline_kind,
      remaining_minutes: remainingPlanningMinutes(task),
      logged_minutes: Number(task.logged_minutes ?? 0),
      feel_score: task.feel_score ?? null,
      blocker_ids: planningBlockerMap.get(task.id) ?? [],
      is_rollup: isParentPlanningTask(task),
      scheduled_blocks: (scheduledBlocksByTask.get(task.id) ?? [])
        .sort((a, b) => a.date.localeCompare(b.date) || String(a.time).localeCompare(String(b.time))),
      children: [],
    });
  }
  const rootNodesByGoal = new Map<string, ContextTaskNode[]>();
  for (const task of planningTaskRows) {
    const node = taskNodeById.get(task.id)!;
    const parent = task.parent_task_id ? taskNodeById.get(task.parent_task_id) : null;
    if (parent && planningTaskById.get(task.parent_task_id!)?.goal_id === task.goal_id) {
      parent.children.push(node);
      continue;
    }
    const goalKey = task.goal_id ?? 'unassigned';
    if (!rootNodesByGoal.has(goalKey)) rootNodesByGoal.set(goalKey, []);
    rootNodesByGoal.get(goalKey)!.push(node);
  }
  const sortTaskTree = (nodes: ContextTaskNode[]) => {
    nodes.sort((a, b) =>
      String(a.deadline ?? '9999-12-31').localeCompare(String(b.deadline ?? '9999-12-31'))
      || a.title.localeCompare(b.title));
    for (const node of nodes) sortTaskTree(node.children);
  };
  for (const nodes of rootNodesByGoal.values()) sortTaskTree(nodes);

  const goalTaskHierarchy = goals.map(goal => {
    const goalId = goal.id as string;
    const metrics = metricsMap[goalId];
    return {
      id: goalId,
      title: goal.title,
      status: goal.status,
      deadline: goal.deadline ?? null,
      total_incomplete_tasks: Number(metrics?.incomplete_count ?? 0),
      total_remaining_minutes: Number(metrics?.mins_remaining ?? 0),
      total_logged_minutes: Number(metrics?.mins_logged ?? 0),
      milestones: (allMilestones
        .filter(milestone => milestone.goal_id === goalId)
        .map(milestone => ({
          id: milestone.id,
          title: milestone.title,
          due_date: milestone.due_date ?? null,
          completed: Boolean(milestone.completed),
        }))),
      tasks: rootNodesByGoal.get(goalId) ?? [],
    };
  });
  if (rootNodesByGoal.has('unassigned')) {
    goalTaskHierarchy.push({
      id: 'unassigned',
      title: 'Unassigned tasks',
      status: 'active',
      deadline: null,
      total_incomplete_tasks: rootNodesByGoal.get('unassigned')!.length,
      total_remaining_minutes: 0,
      total_logged_minutes: 0,
      milestones: [],
      tasks: rootNodesByGoal.get('unassigned')!,
    });
  }

  // ── Rich context only for tasks explicitly named in this turn ─────────────
  const targetedTaskIds = findExplicitTaskMatches(userQuery, planningTaskRows);
  let targetedTaskContext: Record<string, unknown>[] = [];
  if (targetedTaskIds.length) {
    const [
      { rows: detailRows },
      { rows: childRows },
      { rows: noteRows },
      { rows: sessionRows },
      { rows: factRows },
    ] = await Promise.all([
      query(
        `SELECT t.id, t.title, t.description, t.status, t.priority, t.kind, t.tags_json,
                t.goal_id, g.title AS goal_title, t.parent_task_id, p.title AS parent_title,
                t.milestone_id, m.title AS milestone_title, t.start_date, t.due_date,
                t.target_date, t.hard_deadline, t.estimated_minutes, t.actual_minutes,
                t.feel_score, t.last_activity_at, t.completion_note,
                es_plan.summary_text AS planning_summary,
                es_sem.summary_text AS semantic_summary
         FROM tasks t
         LEFT JOIN goals g ON g.id=t.goal_id
         LEFT JOIN tasks p ON p.id=t.parent_task_id
         LEFT JOIN goal_milestones m ON m.id=t.milestone_id
         LEFT JOIN entity_summaries es_plan ON es_plan.entity_type='task' AND es_plan.entity_id=t.id AND es_plan.summary_type='planning'
         LEFT JOIN entity_summaries es_sem ON es_sem.entity_type='task' AND es_sem.entity_id=t.id AND es_sem.summary_type='semantic'
         WHERE t.id = ANY($1) AND ${activeTaskSql('t.id')}`,
        [targetedTaskIds],
      ),
      query(
        `SELECT id, parent_task_id, title, status, priority, start_date,
                COALESCE(hard_deadline,target_date,due_date) AS deadline,
                estimated_minutes, actual_minutes, feel_score, completed
         FROM tasks WHERE ${activeTaskSql()} AND parent_task_id = ANY($1)
         ORDER BY completed ASC, position ASC, created_at ASC LIMIT 30`,
        [targetedTaskIds],
      ),
      query(
        `SELECT task_id, LEFT(content,1200) AS content, created_at
         FROM task_notes WHERE task_id = ANY($1)
         ORDER BY created_at DESC LIMIT 20`,
        [targetedTaskIds],
      ),
      query(
        `SELECT task_id, started_at, ended_at, minutes, LEFT(notes,600) AS notes, source
         FROM work_sessions WHERE task_id = ANY($1)
         ORDER BY started_at DESC LIMIT 20`,
        [targetedTaskIds],
      ),
      query(
        `SELECT target_id AS task_id, fact_type, fact_text, confidence
         FROM extracted_facts
         WHERE target_type='task' AND target_id = ANY($1) AND status='active'
         ORDER BY confidence DESC LIMIT 20`,
        [targetedTaskIds],
      ),
    ]);
    targetedTaskContext = (detailRows as Record<string, unknown>[]).map(task => ({
      ...task,
      scheduled_blocks: scheduledBlocksByTask.get(String(task.id)) ?? [],
      blocker_ids: planningBlockerMap.get(String(task.id)) ?? [],
      children: (childRows as Record<string, unknown>[]).filter(child => child.parent_task_id === task.id),
      recent_notes: (noteRows as Record<string, unknown>[]).filter(note => note.task_id === task.id).slice(0, 5),
      recent_work_sessions: (sessionRows as Record<string, unknown>[]).filter(session => session.task_id === task.id).slice(0, 5),
      evidence_facts: (factRows as Record<string, unknown>[]).filter(fact => fact.task_id === task.id).slice(0, 5),
    }));
  }

  const milestonesByGoal: Record<string, Record<string, unknown>[]> = {};
  for (const m of allMilestones) {
    const gid = m.goal_id as string;
    if (!milestonesByGoal[gid]) milestonesByGoal[gid] = [];
    milestonesByGoal[gid].push(m);
  }

  const tasksByGoal: Record<string, typeof upcomingTaskCards> = {};
  for (const card of upcomingTaskCards) {
    const gid = card.goal_id ?? 'unassigned';
    if (!tasksByGoal[gid]) tasksByGoal[gid] = [];
    tasksByGoal[gid].push(card);
  }

  const goalContexts = goals.map(goal => {
    const metrics = metricsMap[goal.id as string];
    const minsRemaining = Number(metrics?.mins_remaining ?? 0);
    const deadline = goal.deadline as string | null;
    let feasibility: string | null = null;
    let daysUntilDeadline: number | null = null;
    if (deadline) {
      const dl = new Date(deadline);
      daysUntilDeadline = Math.ceil((dl.getTime() - today.getTime()) / 86400000);
      const available = Math.max(0, daysUntilDeadline) * effectiveCapacity;
      feasibility = daysUntilDeadline < 0 ? 'overdue' : minsRemaining === 0 ? 'on_track' : minsRemaining > available * 0.9 ? 'at_risk' : 'on_track';
    }

    return {
      id: goal.id,
      title: goal.title,
      category: goal.category,
      status: goal.status,
      deadline: goal.deadline ?? null,
      days_until_deadline: daysUntilDeadline,
      feasibility,
      total_incomplete_tasks: Number(metrics?.incomplete_count ?? 0),
      total_mins_remaining: minsRemaining,
      total_mins_logged: Number(metrics?.mins_logged ?? 0),
      planning_summary: (goal.planning_summary as string | null) ?? null,
      milestones: (milestonesByGoal[goal.id as string] ?? []).map(m => ({
        id: m.id,
        title: m.title,
        due_date: m.due_date ?? null,
        completed: Boolean(m.completed),
        planning_summary: (m.planning_summary as string | null) ?? null,
      })),
      upcoming_tasks: (tasksByGoal[goal.id as string] ?? []).map(card => ({
        id: card.entity_id,
        title: card.title,
        status: card.status,
        priority: card.priority,
        feel_score: card.feel_score ?? null,
        due_date: card.due_date ?? null,
        estimated_minutes: card.estimated_minutes ?? null,
        logged_minutes: card.logged_minutes ?? 0,
        remaining_minutes: card.remaining_minutes ?? null,
        planning_summary: card.planning_summary ?? null,
        blocker_ids: card.blocker_ids ?? [],
        evidence_facts: card.evidence_facts ?? [],
        milestone_id: card.milestone_id ?? null,
      })),
      meetings: meetings
        .filter(m => (m as Record<string, unknown>).goal_id === goal.id)
        .map(m => ({
          id: (m as Record<string, unknown>).id,
          title: (m as Record<string, unknown>).title,
          scheduled_at: (m as Record<string, unknown>).scheduled_at,
          duration_minutes: (m as Record<string, unknown>).duration_minutes,
          location: (m as Record<string, unknown>).location,
        })),
    };
  });

  // ── Deterministic scheduler (no LLM) ────────────────────────────────────────
  const scheduleContextCards = canonicalSchedulerTasks.map(task => ({
    entity_type: 'task',
    entity_id: task.id,
    title: task.title,
    remaining_minutes: task.estimated_minutes > 0 ? task.estimated_minutes : null,
    estimated_minutes: task.estimated_minutes > 0 ? task.estimated_minutes : null,
    due_date: task.due_date,
    priority: task.priority,
    blocker_ids: task.blocker_ids,
  }));
  const scheduleHorizonEnd = addDaysStr(todayStr, 13);

  const schedulerResult: SchedulerResult = computeSchedule({
    start_date: todayStr,
    // Unestimated tasks MUST be included: computeSchedule classifies them into
    // unestimated_task_ids. Filtering them out here made the scheduler report
    // "feasible" while being blind to the actual workload.
    tasks: scheduleContextCards
      // This result is explicitly named scheduler_result for the next 14 days.
      // Future-deadline work remains available in goal_task_hierarchy and
      // planning_focus, but counting its entire estimate here made the model
      // describe work due after the horizon as a current-horizon shortfall.
      .filter(c => c.entity_type === 'task' && c.due_date && c.due_date <= scheduleHorizonEnd)
      .map(c => ({
        id: c.entity_id,
        title: c.title,
        // Use remaining work (est - logged) so time already spent is not double-counted.
        // 0 = unestimated — the scheduler flags rather than schedules it.
        estimated_minutes: c.remaining_minutes ?? c.estimated_minutes ?? 0,
        due_date: c.due_date ?? null,
        priority: (c.priority ?? 'medium') as 'high' | 'medium' | 'low',
        blocker_ids: c.blocker_ids ?? [],
      })),
    // Merge calendar meetings + locked events — both reduce available capacity
    meetings: [
      ...meetings.map(m => ({
        date: String((m as Record<string, unknown>).scheduled_at).slice(0, 10),
        duration_minutes: Number((m as Record<string, unknown>).duration_minutes ?? 0),
      })),
      ...eventMeetings,
      ...routineCapacity(contextRoutines),
    ],
    prefs: {
      // DB stores work_days as ISO 1=Mon…7=Sun; scheduler uses getDay() 0=Sun…6=Sat. Convert via % 7.
      work_days: (JSON.parse(prefs.work_days as string) as number[]).map(d => d % 7),
      daily_capacity_minutes: dailyCapacity,
      buffer_ratio: bufferRatio,
      timezone: prefs.timezone as string | undefined,
    },
    overrides: (overrides as { date: string; available_minutes: number }[]),
    horizon_days: 14,
  });

  const ctx = {
    today: todayStr,
    routine_reservations: contextRoutines,
    schedule_prefs: {
      work_days: JSON.parse(prefs.work_days as string),
      work_start: prefs.work_start,
      work_end: prefs.work_end,
      daily_capacity_minutes: dailyCapacity,
      effective_capacity_minutes: effectiveCapacity,
      deep_work_start: prefs.deep_work_start,
      deep_work_end: prefs.deep_work_end,
      timezone: prefs.timezone ?? 'UTC',
      buffer_ratio: bufferRatio,
    },
    scheduler_result: {
      status: schedulerResult.status,
      total_available_minutes: schedulerResult.total_available_minutes,
      total_required_minutes: schedulerResult.total_required_minutes,
      gap_minutes: schedulerResult.gap_minutes,
      tasks_overflow: schedulerResult.tasks_overflow,
      unestimated_task_ids: schedulerResult.unestimated_task_ids,
      ...(schedulerResult.impossible_reason ? { impossible_reason: schedulerResult.impossible_reason } : {}),
    },
    active_goals: goalContexts,
    meetings_next_14_days: meetings.map(m => ({
      id: (m as Record<string, unknown>).id,
      title: (m as Record<string, unknown>).title,
      goal_id: (m as Record<string, unknown>).goal_id,
      scheduled_at: (m as Record<string, unknown>).scheduled_at,
      duration_minutes: (m as Record<string, unknown>).duration_minutes,
    })),
    recent_journal: recentJournals.map(j => ({ date: j.entry_date, summary: j.summary })),
    // Compact library listing so the model can reference/attach real resources
    resources: (await query(
      `SELECT r.id, r.title, r.type FROM resources r WHERE ${activeResourceSql('r.id')} ORDER BY r.created_at DESC LIMIT 50`,
    )).rows,
    schedule_overrides: overrides,
    retrieval_meta: {
      vector_degraded: retrievalResult.vector_degraded,
      ...(retrievalResult.vector_degraded_reason
        ? { degraded_reason: retrievalResult.vector_degraded_reason }
        : {}),
    },
    // Task universe coverage — lets AI report omissions rather than reasoning from partial data
    planning_coverage: {
      task_overview_limit: 200,
      resources_limit: 50,
      journal_summaries_limit: 10,
      details_limits: { children: 30, notes: 20, work_sessions: 20, evidence_facts: 20, per_task_notes: 5, per_task_sessions: 5, per_task_facts: 5 },
      total_incomplete: Number(coverage.total_incomplete ?? 0),
      tasks_in_context: planningTaskRows.length,
      overdue: Number(coverage.overdue ?? 0),
      upcoming_dated: Number(coverage.upcoming_dated ?? 0),
      undated: Number(coverage.undated ?? 0),
      unestimated: Number(coverage.unestimated ?? 0),
      in_progress: Number(coverage.in_progress ?? 0),
      blocked: Number(coverage.blocked ?? 0),
    },
    goal_task_hierarchy: goalTaskHierarchy,
    targeted_task_context: targetedTaskContext,
    attention_queue: attentionQueue,
    planning_buckets: planningBuckets,
    overdue_tasks: overdueTasks,
    daily_workload: dailyWorkload,
    current_schedule_days: currentScheduleDays,
  };

  console.log(`[ai] context size: ${JSON.stringify(ctx).length} chars${retrievalResult.vector_degraded ? ' [vector degraded]' : ''}`);

  // Citations: typed references to everything placed in the model's context,
  // with lane provenance. Returned to the CLIENT only — never sent to the
  // model (that would inflate the prompt for no benefit).
  const citations: ChatCitation[] = [
    ...upcomingTaskCards.map(c => ({
      entity_type: c.entity_type,
      entity_id: c.entity_id,
      title: c.title,
      matched_via: c.matched_via ?? [],
      ...(c.similarity !== undefined ? { similarity: Math.round(c.similarity * 1000) / 1000 } : {}),
      ...(c.topics?.length ? { topics: c.topics } : {}),
    })),
    ...recentJournals.map(j => ({
      entity_type: 'journal_entry',
      entity_id: j.id,
      title: `Journal — ${j.entry_date}`,
      matched_via: ['recency'],
    })),
  ];

  return { ctx, citations };
}

type ScheduleContext = Awaited<ReturnType<typeof getScheduleContext>>['ctx'];

/**
 * Progressive-disclosure context for the model:
 * - graph index with explicit coverage and on-demand paginated reads
 * - compact two-week schedule and risk signals
 * - rich prose/notes/work history only for explicitly named tasks
 */
function compactContextForModel(context: ScheduleContext, sections?: WorkspaceSection[]): Record<string, unknown> {
  const workloadByDate = new Map(context.daily_workload.map(day => [day.date, day]));
  const scheduleHorizon = context.current_schedule_days.map(day => {
    const workload = workloadByDate.get(day.date);
    return {
      date: day.date,
      capacity: workload?.capacity,
      capacity_minutes: workload?.capacity.available_after_fixed_minutes ?? 0,
      fixed_minutes: workload?.capacity.fixed_commitment_minutes ?? 0,
      scheduled_minutes: day.scheduled_minutes,
      free_minutes: day.free_after_scheduled_minutes,
      due_minutes: day.due_work.due_leaf_minutes,
      over_capacity_minutes: day.due_work.over_capacity_minutes,
      coverage: day.coverage,
      blocks: day.timeline_blocks.map(block => ({
        id: block.id,
        title: block.title,
        time: block.time_label,
        minutes: block.duration_minutes,
        indicator: block.indicator,
        task_ids: block.linked_tasks?.map(task => task.task_id) ?? [],
      })),
      day_tasks: day.day_level_tasks.map(task => ({
        id: task.id,
        title: task.title,
        minutes: task.remaining_minutes,
      })),
    };
  });
  const planningFocus = {
    must_finish_by_date: context.planning_buckets.must_finish_by_date.map(bucket => ({
      date: bucket.date,
      task_ids: bucket.tasks.map(task => task.id),
    })),
    large_tasks_needing_slices: context.planning_buckets.large_tasks_needing_slices.map(task => ({
      id: task.id,
      deadline: task.deadline,
      remaining_minutes: task.remaining_minutes,
      suggested_daily_minutes: task.suggested_daily_minutes,
    })),
    parent_rollups: context.planning_buckets.parent_rollups.map(task => ({
      id: task.id,
      earliest_child_deadline: task.earliest_child_deadline,
      latest_child_deadline: task.latest_child_deadline,
      dated_descendant_count: task.dated_descendant_count,
    })),
    unestimated_due_soon_ids: context.planning_buckets.unestimated_due_soon.map(task => task.id),
  };

  const compact: Record<string, unknown> = {
    today: context.today,
    schedule_prefs: context.schedule_prefs,
    scheduler_result: context.scheduler_result,
    planning_coverage: context.planning_coverage,
    graph: workspaceGraph(context.goal_task_hierarchy),
    schedule_horizon_next_14_days: scheduleHorizon,
    meetings_next_14_days: context.meetings_next_14_days,
    schedule_overrides: context.schedule_overrides,
    attention_queue: context.attention_queue,
    planning_focus: planningFocus,
    targeted_task_context: context.targeted_task_context,
    recent_journal: context.recent_journal,
    retrieval_meta: context.retrieval_meta,
    resources: context.resources,
    // Limits remain explicit even when the model requests only one section.
    // The overview is an index, not a claim to have read the entire database.
  };
  return selectWorkspaceSections(compact, sections);
}

interface ChatScheduleDayView {
  kind: 'day_schedule';
  date: string;
  work_start: number;
  work_end: number;
  capacity: {
    raw_capacity_minutes: number;
    reserved_buffer_minutes: number;
    effective_capacity_minutes: number;
    fixed_commitment_minutes: number;
    available_after_fixed_minutes: number;
  };
  scheduled_minutes: number;
  free_after_scheduled_minutes: number;
  due_leaf_minutes: number;
  over_capacity_minutes: number;
  timeline_blocks: Array<{
    id: string;
    title: string;
    type: 'meeting' | 'linked_task_block' | 'calendar_block' | 'unavailable';
    indicator: 'FIXED' | 'SCHEDULED' | 'UNLINKED';
    start_hour: number;
    end_hour: number;
    duration_minutes: number;
    time_label: string;
    linked_tasks?: Array<{
      task_id: string;
      title: string;
      origin_title: string | null;
      goal_title: string | null;
    }>;
  }>;
  day_level_tasks: Array<{
    id: string;
    title: string;
    origin_title: string;
    goal_title: string | null;
    remaining_minutes: number | null;
    indicator: 'DAY-LEVEL';
  }>;
  due_groups: Array<{
    origin_id: string;
    origin_title: string;
    goal_title: string | null;
    kind: 'parent_task' | 'single_task';
    total_minutes: number;
    unestimated_count: number;
    tasks: Array<{
      id: string;
      title: string;
      remaining_minutes: number | null;
      deadline: string;
      deadline_kind: string;
      relation: 'origin_task' | 'subtask';
    }>;
  }>;
}

function buildScheduleDayView(context: ScheduleContext, date: string): ChatScheduleDayView | null {
  const currentDays = context.current_schedule_days;
  if (!currentDays.length) return null;
  const scheduleDay = currentDays.find(day => day.date === date);
  if (!scheduleDay) return null;
  const workloadDay = context.daily_workload.find(day => day.date === scheduleDay.date);
  if (!workloadDay) return null;
  const timedMinutes = scheduleDay.timeline_blocks.reduce((sum, block) => sum + Number(block.duration_minutes ?? 0), 0);
  const focusCapacity = Number(workloadDay.capacity.effective_capacity_minutes ?? 0);

  return {
    kind: 'day_schedule',
    date: scheduleDay.date,
    work_start: Number(context.schedule_prefs.work_start ?? 9),
    work_end: Number(context.schedule_prefs.work_end ?? 18),
    capacity: {
      raw_capacity_minutes: Number(workloadDay.capacity.raw_capacity_minutes ?? 0),
      reserved_buffer_minutes: Number(workloadDay.capacity.reserved_buffer_minutes ?? 0),
      effective_capacity_minutes: Number(workloadDay.capacity.effective_capacity_minutes ?? 0),
      fixed_commitment_minutes: Number(workloadDay.capacity.fixed_commitment_minutes ?? 0),
      available_after_fixed_minutes: Number(workloadDay.capacity.available_after_fixed_minutes ?? 0),
    },
    // Only real timed blocks count as scheduled. A task with start_date but no
    // event is day-level/unscheduled work, not calendar placement.
    scheduled_minutes: timedMinutes,
    free_after_scheduled_minutes: focusCapacity - timedMinutes,
    due_leaf_minutes: Number(workloadDay.due_leaf_minutes ?? 0),
    over_capacity_minutes: Number(workloadDay.over_capacity_minutes ?? 0),
    timeline_blocks: scheduleDay.timeline_blocks,
    day_level_tasks: scheduleDay.day_level_tasks,
    due_groups: workloadDay.origin_groups,
  };
}

/**
 * Persists valid actions as durable pending proposals and returns them with
 * proposal_id attached. Duplicate suggestions (same type+payload) map back to
 * the existing pending proposal instead of accumulating.
 */
async function persistActionsAsProposals(
  actions: ValidatedAction[],
  sourceType: string,
  sourceId: string | null,
): Promise<ValidatedAction[]> {
  const now = new Date().toISOString();
  for (const action of actions) {
    if (action.rejected_reason) continue;
    const payloadStr = JSON.stringify(action.params);
    const idemKey = crypto.createHash('sha256').update(`${action.type}\0${payloadStr}`).digest('hex');
    const { rows: inserted } = await query(
      `INSERT INTO ai_action_proposals (id, action_type, action_payload, explanation, confidence, status, source_type, source_id, created_at, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9)
       ON CONFLICT (action_type, idempotency_key) WHERE status='pending' AND idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [crypto.randomUUID(), action.type, payloadStr, action.description, 0.8, sourceType, sourceId, now, idemKey],
    );
    if (inserted.length) {
      action.proposal_id = (inserted[0] as { id: string }).id;
    } else {
      const { rows: existing } = await query(
        `SELECT id FROM ai_action_proposals
         WHERE action_type=$1 AND idempotency_key=$2 AND status='pending' LIMIT 1`,
        [action.type, idemKey],
      );
      if (existing.length) action.proposal_id = (existing[0] as { id: string }).id;
    }
  }
  return actions;
}

async function answerConversation(
  turns: ConversationTurn[],
  options: { model?: string; source: string; sessionId: string | null; onTrace?: (trace: ChatCallTrace) => void; agentRunId?: string },
) {
  const contexts = new Map<string, Awaited<ReturnType<typeof getScheduleContext>>>();
  const citations = new Map<string, ChatCitation>();
  const loadContext = async (search = '') => {
    if (!contexts.has(search)) contexts.set(search, await getScheduleContext(search || undefined));
    const result = contexts.get(search)!;
    for (const citation of result.citations) citations.set(`${citation.entity_type}:${citation.entity_id}`, citation);
    return result.ctx;
  };
  const result = await runCopilotConversation({
    turns,
    clock: await readCopilotClock(),
    model: options.model,
    onTrace: options.onTrace,
    onTool: options.agentRunId ? async (name, status) => {
      await appendAgentEvent(options.agentRunId!, 'conversation_tool', `Read-only tool: ${name}`, null, { tool: name, status });
    } : undefined,
    tools: createCopilotTools({
      workspace: async (search, sections) => compactContextForModel(await loadContext(search), sections ?? (search ? ['tasks', 'details'] : undefined)),
      previewSchedule: args => buildPlanPayload(args as PlanWindowParams),
      previewRoutine: args => buildSeriesPayload(args as unknown as SeriesParams),
      scheduleDay: async date => buildScheduleDayView(await loadContext(), date),
      overdueTasks: async () => ({ tasks: (await loadContext()).overdue_tasks }),
    }),
  });
  return {
    ...result,
    actions: await persistActionsAsProposals(result.actions, options.source, options.sessionId),
    citations: [...citations.values()],
  };
}

// Both chat entry points use the same model-led conversation and read-only tools.
router.post('/chat', rateLimit(60, 60_000, 'ai-chat'), async (req, res) => {
  const schema = z.object({
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(16000) }).strict()).min(1).max(200),
    model: z.string().optional(),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Provide user/assistant messages, each no longer than 16000 characters.' });
  let model: string;
  try { model = resolveChatModel(parsed.data.model); }
  catch (error) { return res.status(400).json({ error: String(error) }); }
  try {
    res.json(await answerConversation(parsed.data.messages, { model, source: 'chat', sessionId: null }));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Copilot could not finish this reply. Please try again.' });
  }
});

// ── AI preferences adjuster ──────────────────────────────────────────────────
// The user describes their week in plain language; the model proposes prefs
// changes and day overrides. Output is STRICTLY validated and returned as a
// diff — nothing is written until the client applies it via the normal
// PUT /api/schedule-prefs and PUT /overrides/:date endpoints.

const PrefsSuggestionSchema = z.object({
  reply: z.string().max(2000).optional(),
  updates: z.object({
    work_days: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    daily_capacity_minutes: z.number().int().min(30).max(960).optional(),
    buffer_ratio: z.number().min(0).max(0.5).optional(),
    work_start: z.number().min(0).max(23.5).optional(),
    work_end: z.number().min(0.5).max(24).optional(),
  }).strict().optional(),
  day_overrides: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    available_minutes: z.number().int().min(0).max(960),
    note: z.string().max(200).optional(),
  }).strict()).max(21).optional(),
}).strict();

router.post('/prefs/suggest', rateLimit(20, 60_000, 'ai-prefs'), async (req, res) => {
  const { message } = req.body as { message?: string };
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  const { rows: prefsRows } = await query("SELECT * FROM user_schedule_prefs WHERE id='default'");
  const prefs = prefsRows[0] ?? {};
  const todayStr = fmtYMD(new Date());
  const [{ rows: weekSessions }, { rows: upcomingMeetings }, { rows: existingOverrides }] = await Promise.all([
    query(`SELECT COALESCE(SUM(minutes),0)::int AS mins, COUNT(DISTINCT DATE(started_at::timestamp))::int AS days
           FROM work_sessions WHERE started_at >= (CURRENT_DATE - INTERVAL '7 days')::TEXT`),
    query(`SELECT title, scheduled_at, duration_minutes FROM meetings
           WHERE ${activeMeetingSql()} AND DATE(scheduled_at::timestamp) BETWEEN $1 AND ($1::date + 14)::text ORDER BY scheduled_at LIMIT 20`, [todayStr]),
    query(`SELECT date, available_minutes, note FROM schedule_day_overrides WHERE date >= $1 ORDER BY date LIMIT 20`, [todayStr]),
  ]);

  const system = `You adjust a user's work-schedule preferences. Today is ${todayStr}. Respond with ONLY one JSON object:
{
  "reply": "1-3 sentences explaining what you changed and why",
  "updates": { "work_days": [1..7 ISO weekday numbers, Mon=1], "daily_capacity_minutes": 30-960, "buffer_ratio": 0-0.5, "work_start": 0-23.5, "work_end": 0.5-24 },
  "day_overrides": [ { "date": "YYYY-MM-DD", "available_minutes": 0-960, "note": "why" } ]
}
Rules: include ONLY fields that should change. Use day_overrides for one-off exceptions (travel, sick days, busy days) and updates for lasting changes. Dates must be today or later. Never invent constraints the user didn't state.

Current preferences: ${JSON.stringify({
    work_days: prefs.work_days, daily_capacity_minutes: prefs.daily_capacity_minutes,
    buffer_ratio: prefs.buffer_ratio, work_start: prefs.work_start, work_end: prefs.work_end, timezone: prefs.timezone,
  })}
Actual work logged last 7 days: ${JSON.stringify(weekSessions[0])}
Upcoming meetings (14d): ${JSON.stringify(upcomingMeetings)}
Existing day overrides: ${JSON.stringify(existingOverrides)}`;

  const raw = await chat([
    { role: 'system', content: system },
    { role: 'user', content: message.trim() },
  ], { temperature: 0.2, max_tokens: 1024 });

  let parsed: unknown;
  try { parsed = parseJSON(raw); } catch {
    return res.status(422).json({ error: 'Model returned unparseable output — try rephrasing.', raw: raw.slice(0, 300) });
  }
  const result = PrefsSuggestionSchema.safeParse(parsed);
  if (!result.success) {
    return res.status(422).json({
      error: 'Model proposed invalid changes (rejected by validation).',
      issues: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
    });
  }
  // Reject past-dated overrides outright
  const overrides = (result.data.day_overrides ?? []).filter(o => o.date >= todayStr);

  res.json({
    ok: true,
    reply: result.data.reply ?? '',
    current: {
      work_days: prefs.work_days, daily_capacity_minutes: prefs.daily_capacity_minutes,
      buffer_ratio: prefs.buffer_ratio, work_start: prefs.work_start, work_end: prefs.work_end,
    },
    updates: result.data.updates ?? {},
    day_overrides: overrides,
  });
});

// ── Schedule drafts: multiple alternative plans the user can pick from ──────
// Each draft runs the SAME deterministic scheduler under a different strategy;
// nothing mutates until the user applies a chosen draft.

async function loadSchedulerInputs(horizonDays: number) {
  const { rows: prefsRows } = await query("SELECT * FROM user_schedule_prefs WHERE id='default'");
  const prefs = (prefsRows[0] ?? { work_days: '[1,2,3,4,5]', daily_capacity_minutes: 480, buffer_ratio: 0.15 }) as Record<string, unknown>;
  const tz = prefs.timezone as string | undefined;
  const todayStr = tz
    ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
    : fmtYMD(new Date());
  const end = new Date(todayStr + 'T00:00:00');
  end.setDate(end.getDate() + horizonDays - 1);
  const endStr = fmtYMD(end);

  const [
    { rows: schedTasks },
    { rows: meetings },
    { rows: overrides },
    { rows: blockerEdges },
    { rows: taskDeadlineRows },
    { rows: goalTimelineRows },
    { rows: milestoneTimelineRows },
    { rows: plannedRows },
  ] = await Promise.all([
    query(
      `SELECT t.id, t.title, t.goal_id, g.title AS goal_title, t.milestone_id, t.parent_task_id,
              t.estimated_minutes, t.due_date, t.start_date, t.priority,
              t.kind, t.target_date, t.hard_deadline, t.scheduling_enabled,
              g.scheduling_enabled AS goal_scheduling_enabled,
              gm.scheduling_enabled AS milestone_scheduling_enabled,
              COUNT(child.id)::int AS child_count,
              COALESCE((
                SELECT SUM(ws.minutes)
                FROM work_sessions ws
                WHERE ws.task_id = t.id AND ws.minutes IS NOT NULL
              ), 0) as logged_minutes
       FROM tasks t
       LEFT JOIN goals g ON g.id = t.goal_id
       LEFT JOIN goal_milestones gm ON gm.id = t.milestone_id
       LEFT JOIN tasks child ON child.parent_task_id = t.id AND child.completed = false AND ${activeTaskSql('child.id')}
       WHERE t.completed = false AND ${activeTaskSql('t.id')}
       GROUP BY t.id, t.title, t.goal_id, g.title, t.milestone_id, t.parent_task_id,
                t.estimated_minutes, t.due_date, t.start_date, t.priority,
                t.kind, t.target_date, t.hard_deadline, t.scheduling_enabled,
                g.scheduling_enabled, gm.scheduling_enabled`,
    ),
    query(`SELECT scheduled_at, duration_minutes FROM meetings WHERE ${activeMeetingSql()} AND DATE(scheduled_at::timestamp) BETWEEN $1 AND $2`, [todayStr, endStr]),
    query(`SELECT date, available_minutes FROM schedule_day_overrides WHERE date BETWEEN $1 AND $2`, [todayStr, endStr]),
    query(`SELECT source_id as blocker_id, target_id as task_id FROM edges WHERE relationship='blocks' AND source_type='task' AND target_type='task' AND ${activeTaskSql('source_id')} AND ${activeTaskSql('target_id')}`),
    query(
      `SELECT id, parent_task_id, goal_id, milestone_id, start_date, due_date, target_date, hard_deadline
       FROM tasks WHERE completed=false AND ${activeTaskSql()}`,
    ),
    query(`SELECT id, start_date, target_date, hard_deadline, deadline FROM goals WHERE archived_at IS NULL`),
    query(`SELECT id, start_date, due_date, hard_deadline FROM goal_milestones WHERE ${activeMilestoneSql()}`),
    query(
      `SELECT etl.task_id,
              COALESCE(SUM(COALESCE(etl.planned_minutes, ROUND(e.duration_hours * 60))), 0)::int AS planned_minutes
       FROM event_task_links etl
       JOIN events e ON e.id = etl.event_id
       WHERE ${activeTaskSql('etl.task_id')} AND (e.week_start::date + e.day_index) BETWEEN $1::date AND $2::date
       GROUP BY etl.task_id`,
      [todayStr, endStr],
    ),
  ]);
  const resolveTaskTimeline = buildTaskTimelineResolver(
    taskDeadlineRows as unknown as TaskTimelineRow[],
    goalTimelineRows as unknown as GoalTimelineRow[],
    milestoneTimelineRows as unknown as MilestoneTimelineRow[],
  );

  const blockerMap = new Map<string, string[]>();
  for (const e of blockerEdges as { blocker_id: string; task_id: string }[]) {
    if (!blockerMap.has(e.task_id)) blockerMap.set(e.task_id, []);
    blockerMap.get(e.task_id)!.push(e.blocker_id);
  }
  const plannedMinutesByTask = new Map(
    (plannedRows as Array<{ task_id: string; planned_minutes: number }>).map(row => [row.task_id, Number(row.planned_minutes ?? 0)]),
  );
  const schedulerTaskRowById = new Map((schedTasks as Record<string, unknown>[]).map(row => [String(row.id), row]));
  const committedMinutesFor = (task: Record<string, unknown>) => {
    let id: string | null = String(task.id);
    let committed = 0;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      committed += plannedMinutesByTask.get(id) ?? 0;
      const row = schedulerTaskRowById.get(id);
      id = row?.parent_task_id ? String(row.parent_task_id) : null;
    }
    return committed;
  };

  // THE SCHEDULING GATE: Marina manages a task's time only when ALL hold —
  //   scheduling is enabled, a duration estimate exists, and a real date
  //   (hard_deadline > target_date > legacy due_date) exists. Everything else
  //   stays logged/classified but untouched, with an explicit reason.
  const tasks: Array<{
    id: string;
    title: string;
    goal_id: string | null;
    goal_title: string | null;
    estimated_minutes: number;
    start_date: string | null;
    due_date: string | null;
    priority: string;
    blocker_ids: string[];
  }> = [];
  const notSchedulable: Array<{ task_id: string; title: string; goal_id: string | null; reasons: string[] }> = [];
  for (const t of schedTasks as Record<string, unknown>[]) {
    const remaining = Math.max(0, Number(t.estimated_minutes ?? 0) - Number(t.logged_minutes ?? 0) - committedMinutesFor(t));
    const timeline = resolveTaskTimeline(t as Partial<TaskTimelineRow> & { id: unknown });
    const effectiveDue = timeline.due_date;
    const reasons: string[] = [];
    if (t.scheduling_enabled === false) reasons.push('scheduling disabled by user');
    if (t.goal_scheduling_enabled === false) reasons.push('automatic scheduling disabled for goal');
    if (t.milestone_scheduling_enabled === false) reasons.push('automatic scheduling disabled for milestone');
    if (Number(t.child_count ?? 0) > 0) reasons.push('parent task rolls up from child tasks');
    // A critical-path item with no active children is executable work. Only
    // parent rollups are excluded (already covered by child_count above).
    if (!(Number(t.estimated_minutes ?? 0) > 0)) reasons.push('missing estimated duration');
    else if (remaining === 0) reasons.push('estimate already fully logged or placed on the calendar');
    if (!effectiveDue) reasons.push('missing target date or deadline');
    if (reasons.length) {
      notSchedulable.push({ task_id: t.id as string, title: t.title as string, goal_id: (t.goal_id as string | null) ?? null, reasons });
      continue;
    }
    tasks.push({
      id: t.id as string,
      title: t.title as string,
      goal_id: (t.goal_id as string | null) ?? null,
      goal_title: (t.goal_title as string | null) ?? null,
      estimated_minutes: remaining,
      start_date: timeline.start_date,
      due_date: effectiveDue,
      priority: (t.priority as string) ?? 'medium',
      blocker_ids: blockerMap.get(t.id as string) ?? [],
    });
  }

  return {
    todayStr,
    taskById: new Map((schedTasks as Record<string, unknown>[]).map(t => [t.id as string, t])),
    tasks,
    notSchedulable,
    meetings: [...(meetings as Record<string, unknown>[]).map(m => ({
      date: String(m.scheduled_at).slice(0, 10),
      duration_minutes: Number(m.duration_minutes ?? 0),
    })), ...routineCapacity(await loadRoutineReservations(todayStr, endStr, todayStr))],
    prefs: {
      work_days: (JSON.parse(prefs.work_days as string) as number[]).map(d => d % 7),
      daily_capacity_minutes: Number(prefs.daily_capacity_minutes ?? 480),
      buffer_ratio: Number(prefs.buffer_ratio ?? 0.15),
      timezone: tz,
    },
    overrides: overrides as { date: string; available_minutes: number }[],
  };
}

// ── Chat plan (interactive calendar widget in the conversation) ───────────────
// Built when the model emits a plan_schedule action: the deterministic
// scheduler decides which day each task is worked on, layoutPlan packs those
// days into concrete timed blocks around meetings and existing calendar
// blocks. Nothing is written — the payload lives on the chat message until
// the user applies it from the widget.
/** Timed meetings + existing dated blocks between two dates — the fixed
 *  context every plan/series lays itself around. */
async function loadBusyWindow(fromStr: string, toStr: string) {
  const [{ rows: meetingRows }, { rows: eventRows }] = await Promise.all([
    query(
      `SELECT id, title, scheduled_at, duration_minutes FROM meetings
       WHERE ${activeMeetingSql()} AND DATE(scheduled_at::timestamp) BETWEEN $1 AND $2`,
      [fromStr, toStr],
    ),
    query(`SELECT id, title, day_index, start_hour, duration_hours, week_start FROM events WHERE week_start IS NOT NULL AND ${activeEventSql()}`),
  ]);

  const busy: Array<{ date: string; start_hour: number; duration_hours: number; title: string; kind: 'meeting' | 'block' }> = [];
  for (const m of meetingRows as Record<string, unknown>[]) {
    const dt = new Date(String(m.scheduled_at));
    if (Number.isNaN(dt.getTime())) continue;
    busy.push({
      date: String(m.scheduled_at).slice(0, 10),
      start_hour: dt.getHours() + dt.getMinutes() / 60,
      duration_hours: Math.max(0.25, Number(m.duration_minutes ?? 60) / 60),
      title: String(m.title ?? 'Meeting'),
      kind: 'meeting',
    });
  }
  for (const ev of eventRows as Record<string, unknown>[]) {
    const date = eventDateServer(String(ev.week_start), Number(ev.day_index ?? 0));
    if (date < fromStr || date > toStr) continue;
    busy.push({
      date,
      start_hour: Number(ev.start_hour ?? 9),
      duration_hours: Math.max(0.25, Number(ev.duration_hours ?? 1)),
      title: String(ev.title ?? 'Block'),
      kind: 'block',
    });
  }
  const { rows: routinePrefs } = await query("SELECT timezone FROM user_schedule_prefs WHERE id='default'");
  const routineToday = new Intl.DateTimeFormat('en-CA', { timeZone: String(routinePrefs[0]?.timezone || 'UTC') }).format(new Date());
  for (const routine of await loadRoutineReservations(fromStr, toStr, routineToday)) {
    if (!routine.preferred_time) continue;
    const [hour, minute] = routine.preferred_time.split(':').map(Number);
    busy.push({ date: routine.date, start_hour: hour + minute / 60, duration_hours: routine.minutes / 60, title: `Routine: ${routine.title}`, kind: 'block' });
  }
  return busy;
}

/** Unestimated-but-otherwise-schedulable tasks with a history-grounded guess
 *  each — the plan widget's one-tap estimate triage. */
async function loadEstimateTriage(notSchedulable: Array<{ task_id: string; title: string; reasons: string[] }>) {
  // A task qualifies for triage when the estimate is what's blocking it —
  // a missing date can ride along (the triage tap gives it the plan window's
  // end as target), but parent/disabled/exhausted tasks are out.
  const EST = 'missing estimated duration';
  const DATE = 'missing target date or deadline';
  const candidates = notSchedulable
    .filter(t => t.reasons.includes(EST) && t.reasons.every(r => r === EST || r === DATE))
    .slice(0, 10);
  if (!candidates.length) return [];

  const ids = candidates.map(t => t.task_id);
  const [{ rows: goalRows }, { rows: historyRows }] = await Promise.all([
    query(`SELECT id, goal_id FROM tasks WHERE id = ANY($1) AND ${activeTaskSql()}`, [ids]),
    query(`SELECT goal_id, actual_minutes FROM tasks WHERE completed = true AND ${activeTaskSql()} AND actual_minutes IS NOT NULL ORDER BY updated_at DESC LIMIT 500`),
  ]);
  const goalOf = new Map((goalRows as { id: string; goal_id: string | null }[]).map(r => [r.id, r.goal_id]));
  const history = historyRows as { goal_id: string | null; actual_minutes: number | null }[];

  return candidates.map(t => {
    const s = suggestEstimate({ goal_id: goalOf.get(t.task_id) ?? null }, history);
    return {
      task_id: t.task_id,
      title: t.title,
      suggested_minutes: s.minutes,
      basis: s.basis,
      needs_date: t.reasons.includes(DATE),
    };
  });
}

async function buildPlanPayload(windowParams: PlanWindowParams) {
  // Resolve the window the user meant (a day, a range, an afternoon, "next
  // 3 hours") against the wall clock, then plan only inside it.
  const clock = await readCopilotClock();
  const [hour, minute] = clock.time.split(':').map(Number);
  if (windowParams.from_date && windowParams.from_date < clock.today) throw new Error('Cannot preview a new plan in the past. Ask for a future window.');
  const window = resolvePlanWindow(windowParams, clock.today, hour + minute / 60);
  if (window.to > addDaysStr(clock.today, 89)) throw new Error('Calendar previews currently cover the next 90 days. Ask for a window within that range.');

  // Scheduler inputs must span from today THROUGH the window's end (its
  // queries anchor at today); the schedule itself starts at the window start.
  const daysFromToday = Math.max(
    1,
    Math.round((new Date(window.to + 'T00:00:00').getTime() - new Date(clock.today + 'T00:00:00').getTime()) / 86_400_000) + 1,
  );
  const inp = await loadSchedulerInputs(Math.min(daysFromToday, 90));
  const todayStr = window.from;
  const endStr = window.to;
  const horizonDays = Math.max(
    1,
    Math.round((new Date(endStr + 'T00:00:00').getTime() - new Date(todayStr + 'T00:00:00').getTime()) / 86_400_000) + 1,
  );
  const daysBetweenPlanDates = (from: string, to: string) =>
    Math.round((new Date(to + 'T00:00:00').getTime() - new Date(from + 'T00:00:00').getTime()) / 86_400_000);
  const futureSliceCutoff = addDaysStr(endStr, horizonDays <= 2 ? 7 : 14);
  const largeSliceFloor = Math.max(180, Math.round(inp.prefs.daily_capacity_minutes * 0.5));
  const scope = resolvePlanTaskScope(windowParams, inp.taskById);
  const scopedTasks = scope ? inp.tasks.filter(task => scope.has(task.id)) : inp.tasks;
  const uncappedPlanTasks = scopedTasks.flatMap(task => {
    if (!task.due_date) return [];
    if (scope) return [task];
    if (task.due_date <= endStr) return [task];
    if (task.due_date > futureSliceCutoff || task.estimated_minutes < largeSliceFloor) return [];

    const daysUntilDeadline = Math.max(1, daysBetweenPlanDates(todayStr, task.due_date) + 1);
    const windowDays = Math.min(horizonDays, daysUntilDeadline);
    const bufferedRemaining = Math.ceil(task.estimated_minutes * (1 + (inp.prefs.buffer_ratio ?? 0)));
    const suggestedSlice = Math.ceil(bufferedRemaining / daysUntilDeadline) * windowDays;
    const sliceMinutes = Math.min(task.estimated_minutes, Math.max(30, suggestedSlice));
    return [{ ...task, estimated_minutes: sliceMinutes }];
  });
  const planTasks = uncappedPlanTasks.map(task => (
    windowParams.max_daily_minutes
      ? { ...task, max_daily_minutes: windowParams.max_daily_minutes }
      : task
  ));

  const schedulerResult = computeSchedule({
    start_date: todayStr,
    tasks: planTasks,
    meetings: inp.meetings,
    prefs: inp.prefs,
    overrides: inp.overrides,
    horizon_days: horizonDays,
  });

  // Work window hours (loadSchedulerInputs doesn't surface them); an
  // hour-scoped request ("this afternoon") overrides them.
  const { rows: prefsRows } = await query("SELECT work_start, work_end FROM user_schedule_prefs WHERE id='default'");
  const prefRow = (prefsRows[0] ?? {}) as Record<string, unknown>;
  const workStart = window.startHour ?? Number(prefRow.work_start ?? 9);
  const workEnd = window.endHour ?? Number(prefRow.work_end ?? 18);

  // Busy calendar time in the horizon: timed meetings + existing dated blocks
  const busy = await loadBusyWindow(todayStr, endStr);

  const layout = layoutPlan({
    dayAssignments: schedulerResult.day_assignments,
    tasks: planTasks.map(t => ({ id: t.id, title: t.title, remaining_minutes: t.estimated_minutes })),
    workStart,
    workEnd,
    busy: busy.map(b => ({ date: b.date, start_hour: b.start_hour, end_hour: b.start_hour + b.duration_hours })),
  });
  const taskDeadlineById = new Map(planTasks.map(t => [t.id, t.due_date]));
  const blocks = layout.blocks.map(block => {
    const dueDate = taskDeadlineById.get(block.task_id) ?? null;
    const planningRole =
      !dueDate ? 'no_deadline'
        : dueDate < block.date ? 'overdue'
          : dueDate === block.date ? 'due_on_block_day'
            : dueDate <= endStr ? 'due_in_window'
              : 'before_deadline';
    return {
      ...block,
      due_date: dueDate,
      planning_role: planningRole,
    };
  });

  return {
    kind: 'plan' as const,
    from: todayStr,
    to: endStr,
    work_start: workStart,
    work_end: workEnd,
    needs_estimate: await loadEstimateTriage(inp.notSchedulable.filter(task => !scope || scope.has(task.task_id))),
    excluded_tasks: inp.notSchedulable.filter(task => !scope || scope.has(task.task_id)),
    days: schedulerResult.day_assignments.map(d => ({
      date: d.date,
      // Hour-scoped windows ("this afternoon") can't offer more capacity
      // than the window itself holds.
      available_minutes: window.startHour !== undefined
        ? Math.min(d.available_minutes, Math.round((workEnd - workStart) * 60))
        : d.available_minutes,
    })),
    busy,
    blocks,
    unplaced: layout.unplaced,
    scheduler: {
      status: schedulerResult.status,
      gap_minutes: schedulerResult.gap_minutes,
      unestimated_count: schedulerResult.unestimated_task_ids.length,
      overflow_count: schedulerResult.tasks_overflow.length,
    },
    status: 'pending' as const,
    adjustments: {} as Record<string, { date: string; start_hour: number }>,
  };
}

async function buildSeriesPayload(p: SeriesParams) {
  const todayStr = (await readCopilotClock()).today;
  if (p.start_date < todayStr) throw new Error('Cannot preview a new routine in the past. Ask for a future start date.');
  if (p.task_id) {
    const { rows } = await query(`SELECT id FROM tasks WHERE id=$1 AND ${activeTaskSql()}`, [p.task_id]);
    if (!rows.length) throw new Error('The requested task is unavailable. Read the current task details; no substitute was selected.');
  }
  const start = p.start_date > todayStr ? p.start_date : todayStr;
  const end = p.end_date >= start ? p.end_date : start;
  const blocks = expandSeries({ ...p, start_date: start, end_date: end });
  const to = blocks.length ? blocks[blocks.length - 1].date : end;
  return {
    kind: 'series' as const,
    from: start,
    to,
    work_start: Math.floor(p.start_hour),
    work_end: Math.ceil(Math.max(p.end_hour, p.start_hour + 0.5)),
    needs_estimate: [] as Array<{ task_id: string; title: string; suggested_minutes: number; basis: string }>,
    days: [] as Array<{ date: string; available_minutes: number }>,
    busy: await loadBusyWindow(start, to),
    blocks,
    unplaced: [] as Array<{ task_id: string; title: string; minutes: number }>,
    scheduler: { status: 'series', gap_minutes: 0, unestimated_count: 0, overflow_count: 0 },
    status: 'pending' as const,
    adjustments: {} as Record<string, { date: string; start_hour: number }>,
  };
}

// POST /api/ai/schedule/plan/apply — commit a chat plan: every block becomes a
// real calendar event linked to its task; earliest block per task sets its
// start day. One transaction — the calendar shows exactly what was approved.
const PlanApplySchema = z.object({
  blocks: z.array(z.object({
    // Series blocks may carry no task — they're standalone routine time.
    task_id: z.string().min(1).optional(),
    title: z.string().min(1).max(500),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    start_hour: z.number().min(0).max(23.75),
    duration_hours: z.number().min(0.25).max(12),
    planned_minutes: z.number().int().min(1).max(1440).optional(),
  }).strict()).min(1).max(200),
  clear_task_dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(14).optional(),
}).strict();

router.post('/schedule/plan/apply', async (req, res) => {
  const parsedBody = PlanApplySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(422).json({
      error: 'invalid plan',
      issues: parsedBody.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).slice(0, 10),
    });
  }
  const { blocks, clear_task_dates } = parsedBody.data;
  const linked = blocks.filter((b): b is typeof b & { task_id: string } => Boolean(b.task_id));
  const taskIds = [...new Set(linked.map(b => b.task_id))];
  try {
    await transaction(async client => {
      if (taskIds.length && clear_task_dates?.length) {
        const { rows: existingRows } = await client.query(
          `SELECT DISTINCT e.id, e.week_start, e.day_index, e.locked
           FROM events e
           JOIN event_task_links etl ON etl.event_id = e.id
           WHERE etl.task_id = ANY($1)
             AND e.week_start IS NOT NULL
             AND COALESCE(e.locked, false) = false`,
          [taskIds],
        );
        const clearSet = new Set(clear_task_dates);
        const eventIds = (existingRows as Array<{ id: string; week_start: string; day_index: number; locked: boolean }>)
          .filter(ev => clearSet.has(eventDateServer(ev.week_start, Number(ev.day_index ?? 0))))
          .map(ev => ev.id);
        if (eventIds.length) {
          await client.query(`DELETE FROM event_task_links WHERE event_id = ANY($1)`, [eventIds]);
          await client.query(`DELETE FROM events WHERE id = ANY($1)`, [eventIds]);
        }
      }

      let startByTask = new Map<string, string | null>();
      if (taskIds.length) {
        const { rows: taskRows } = await client.query(
          `SELECT id, start_date FROM tasks WHERE id = ANY($1) AND completed = false AND ${activeTaskSql()}`,
          [taskIds],
        );
        if (taskRows.length !== taskIds.length) {
          throw Object.assign(new Error('Plan references unknown or completed tasks'), { status: 400 });
        }
        startByTask = new Map((taskRows as { id: string; start_date: string | null }[]).map(r => [r.id, r.start_date]));
      }
      const now = new Date().toISOString();
      for (const b of blocks) {
        const { week_start, day_index } = dateToWeekPosServer(b.date);
        const evId = crypto.randomUUID();
        await client.query(
          `INSERT INTO events (id,title,type,day_index,start_hour,duration_hours,time_str,description,week_start,connected_resource_json,locked,source,created_at,updated_at)
           VALUES ($1,$2,'Focus',$3,$4,$5,$6,'',$7,NULL,false,'ai',$8,$8)`,
          [evId, b.title, day_index, b.start_hour, b.duration_hours, fmtTimeStr(b.start_hour, b.duration_hours), week_start, now],
        );
        if (b.task_id) {
          await client.query(
            `INSERT INTO event_task_links (id,event_id,task_id,planned_minutes,created_at) VALUES ($1,$2,$3,$4,$5)`,
            [crypto.randomUUID(), evId, b.task_id, b.planned_minutes ?? null, now],
          );
        }
      }
      const firstDate = new Map<string, string>();
      for (const b of [...linked].sort((a, b2) => a.date.localeCompare(b2.date))) {
        if (!firstDate.has(b.task_id)) firstDate.set(b.task_id, b.date);
      }
      for (const [taskId, date] of firstDate) {
        if (startByTask.get(taskId) !== date) {
          await client.query(`UPDATE tasks SET start_date=$1, updated_at=$2 WHERE id=$3`, [date, now, taskId]);
        }
      }
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return res.status(status).json({ error: (err as Error).message });
  }
  res.json({ ok: true, created: blocks.length });
});

// PATCH /api/ai/sessions/:id/messages/:msgId/plan — persist the plan widget's
// state (applied/discarded + the user's drag adjustments) into the message
// metadata so a reloaded conversation shows the plan exactly as it was left.
const PlanStateSchema = z.object({
  status: z.enum(['pending', 'applied', 'discarded']).optional(),
  adjustments: z.record(z.string(), z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    start_hour: z.number().min(0).max(23.75),
    // The user pruned this block from the plan (restorable, never spliced)
    removed: z.boolean().optional(),
  }).strict()).optional(),
  // Rebuild the plan server-side for the same (or adjusted) window — used
  // after estimate triage so newly estimated tasks get laid in. The server
  // computes the new payload itself; the client never writes plan blocks.
  refresh_window: z.object({
    horizon_days: z.number().int().min(1).max(90).optional(),
    from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    start_hour: z.number().min(0).max(23.75).optional(),
    end_hour: z.number().min(0.25).max(24).optional(),
  }).strict().optional(),
}).strict();

router.patch('/sessions/:id/messages/:msgId/plan', async (req, res) => {
  const parsedBody = PlanStateSchema.safeParse(req.body);
  if (!parsedBody.success) return res.status(422).json({ error: 'invalid plan state' });
  const { rows } = await query(
    `SELECT metadata_json FROM chat_messages WHERE id=$1 AND session_id=$2`,
    [req.params.msgId, req.params.id],
  );
  if (!rows.length) return res.status(404).json({ error: 'Message not found' });
  let meta: Record<string, unknown>;
  try { meta = JSON.parse((rows[0] as { metadata_json: string | null }).metadata_json ?? '{}') ?? {}; } catch { meta = {}; }
  let plan = meta.plan as Record<string, unknown> | undefined;
  if (!plan) return res.status(400).json({ error: 'Message carries no plan' });

  if (parsedBody.data.refresh_window) {
    const rebuilt = await buildPlanPayload(parsedBody.data.refresh_window);
    meta.plan = { ...rebuilt, status: 'pending' };
    plan = meta.plan as Record<string, unknown>;
  }
  if (parsedBody.data.status) plan.status = parsedBody.data.status;
  if (parsedBody.data.adjustments) {
    plan.adjustments = { ...(plan.adjustments as Record<string, unknown> ?? {}), ...parsedBody.data.adjustments };
  }
  await query(`UPDATE chat_messages SET metadata_json=$1 WHERE id=$2`, [JSON.stringify(meta), req.params.msgId]);
  res.json({ ok: true, plan: parsedBody.data.refresh_window ? plan : undefined });
});

// POST /api/ai/schedule/drafts {horizon_days} → 3 alternative plans
router.post('/schedule/drafts', async (req, res) => {
  const horizonDays = Math.min(Math.max(3, Number((req.body as Record<string, unknown>)?.horizon_days ?? 14)), 35);
  const inp = await loadSchedulerInputs(horizonDays);

  const estimable = inp.tasks.filter(t => t.estimated_minutes > 0);
  const totalRequired = estimable.reduce((s, t) => s + t.estimated_minutes, 0);

  const strategies: Array<{ id: string; name: string; description: string; run: () => SchedulerResult }> = [
    {
      id: 'deadline',
      name: 'Deadline-driven',
      description: 'Earliest deadlines and highest priorities first — safest for due dates.',
      run: () => computeSchedule({ start_date: inp.todayStr, tasks: inp.tasks, meetings: inp.meetings, prefs: inp.prefs, overrides: inp.overrides, horizon_days: horizonDays }),
    },
    {
      id: 'spread',
      name: 'Evenly spread',
      description: 'Caps each day near the average needed load — steadier pace, more slack per day.',
      run: () => {
        const workdayCount = Math.max(1, Math.round(horizonDays * (inp.prefs.work_days.length / 7)));
        const avg = Math.ceil(totalRequired / workdayCount / (1 - inp.prefs.buffer_ratio));
        const capped = Math.max(60, Math.min(inp.prefs.daily_capacity_minutes, avg + 30));
        return computeSchedule({
          start_date: inp.todayStr, tasks: inp.tasks, meetings: inp.meetings,
          prefs: { ...inp.prefs, daily_capacity_minutes: capped },
          overrides: inp.overrides, horizon_days: horizonDays,
        });
      },
    },
    {
      id: 'sprint',
      name: 'Front-loaded sprint',
      description: 'Packs everything as early as possible — clears the plate fast, heavier days now.',
      run: () => computeSchedule({
        start_date: inp.todayStr,
        // Everything urgent: strips deadline spacing so the packer front-loads
        tasks: inp.tasks.map(t => ({ ...t, priority: 'high' })),
        meetings: inp.meetings, prefs: inp.prefs, overrides: inp.overrides,
        horizon_days: Math.min(horizonDays, 7),
      }),
    },
  ];

  let unestimatedIds: string[] = [];
  const drafts = strategies.map(s => {
    const result = s.run();
    if (s.id === 'deadline') unestimatedIds = result.unestimated_task_ids;
    const firstDay = new Map<string, string>();
    for (const day of result.day_assignments) {
      for (const tid of day.task_ids) if (!firstDay.has(tid)) firstDay.set(tid, day.date);
    }
    const assignments = [...firstDay.entries()].map(([taskId, date]) => {
      const t = inp.taskById.get(taskId);
      return {
        task_id: taskId,
        title: (t?.title as string) ?? taskId,
        start_date: date,
        current_start: (t?.start_date as string | null) ?? null,
        days: result.day_assignments.filter(d => d.task_ids.includes(taskId)).map(d => d.date),
      };
    }).filter(a => a.start_date !== a.current_start);
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      stats: {
        status: result.status,
        gap_minutes: result.gap_minutes,
        tasks_scheduled: firstDay.size,
        changes: assignments.length,
        busiest_day_minutes: Math.max(0, ...result.day_assignments.map(d => d.used_minutes)),
        days_used: result.day_assignments.filter(d => d.used_minutes > 0).length,
      },
      assignments,
      day_assignments: result.day_assignments,
    };
  });

  res.json({ ok: true, drafts, unestimated_task_ids: unestimatedIds, not_schedulable: inp.notSchedulable });
});

// POST /api/ai/schedule/drafts/apply {assignments:[{task_id,start_date}]}
// The chosen draft was the preview/confirmation — apply is one transaction.
router.post('/schedule/drafts/apply', async (req, res) => {
  const body = req.body as { assignments?: Array<{ task_id?: string; start_date?: string }> };
  const assignments = (body.assignments ?? []).filter(
    a => typeof a.task_id === 'string' && typeof a.start_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.start_date),
  ) as Array<{ task_id: string; start_date: string }>;
  if (!assignments.length) return res.status(400).json({ error: 'assignments required ({task_id, start_date YYYY-MM-DD})' });
  if (assignments.length > 200) return res.status(400).json({ error: 'too many assignments' });

  const now = new Date().toISOString();
  let updated = 0;
  await transaction(async client => {
    for (const a of assignments) {
      const { rowCount } = await client.query(
        `UPDATE tasks SET start_date=$1, updated_at=$2 WHERE id=$3 AND completed=false`,
        [a.start_date, now, a.task_id],
      );
      updated += rowCount ?? 0;
    }
  });
  res.json({ ok: true, updated, requested: assignments.length });
});

// GET /api/ai/entity-summaries/:type/:id
router.get('/entity-summaries/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const { rows } = await query(
    'SELECT summary_type, summary_text FROM entity_summaries WHERE entity_type=$1 AND entity_id=$2',
    [type, id],
  );
  if (!rows.length) return res.status(404).json({ error: 'No summaries found for this entity' });
  const summaries: Record<string, string> = {};
  for (const r of rows) {
    summaries[(r as Record<string, unknown>).summary_type as string] = (r as Record<string, unknown>).summary_text as string;
  }
  res.json({ entity_type: type, entity_id: id, summaries });
});

// GET /api/ai/health
// GET /api/ai/retrieval/debug — requires RETRIEVAL_DEBUG=true; never enabled merely by NODE_ENV
router.get('/retrieval/debug', async (req, res) => {
  if (process.env.RETRIEVAL_DEBUG !== 'true') {
    return res.status(403).json({ error: 'Retrieval debug is disabled. Set RETRIEVAL_DEBUG=true to enable.' });
  }
  const { q, goalIds, limit = '10', horizonDays = '14' } = req.query as Record<string, string>;
  try {
    const result = await buildRetrievalContext({
      query: q || undefined,
      goalIds: goalIds ? goalIds.split(',').filter(Boolean) : undefined,
      horizonDays: Number(horizonDays),
      limit: Number(limit),
    });
    res.json({
      card_count: result.cards.length,
      query: q || null,
      vector_degraded: result.vector_degraded,
      vector_degraded_reason: result.vector_degraded_reason,
      cards: result.cards.map(c => ({
        entity_type: c.entity_type,
        entity_id: c.entity_id,
        title: c.title,
        status: c.status,
        priority: c.priority,
        due_date: c.due_date ?? null,
        estimated_minutes: c.estimated_minutes ?? null,
        remaining_minutes: c.remaining_minutes ?? null,
        planning_summary_snippet: c.planning_summary?.slice(0, 120) ?? null,
        blocker_ids: c.blocker_ids ?? [],
        evidence_facts: c.evidence_facts ?? [],
        similarity: c.similarity ?? null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/health', async (_req, res) => {
  const health = await ollamaHealth();
  res.json({
    ...health,
    model: CHAT_MODEL,
    nvidia_fallback_model: NVIDIA_MODEL,
    nvidia_configured: NVIDIA_CONFIGURED,
    fallback_model: FALLBACK_MODEL || null,
    chat_cooldown: getChatCooldownStatus(),
  });
});

// GET /api/ai/org-inbox — surfaces unreviewed items that need human attention
router.get('/org-inbox', async (_req, res) => {
  const [
    { rows: pendingProposals },
    { rows: failedJournals },
    { rows: needsReviewFacts },
    { rows: staleGoalSummaries },
    { rows: unestimatedHighPriority },
    { rows: overdueTasks },
    { rows: dueSoonTasks },
    { rows: blockedTasks },
    { rows: staleInProgressTasks },
  ] = await Promise.all([
    query(`
      SELECT id, action_type, action_payload, explanation, confidence, created_at, source_type, source_id
      FROM ai_action_proposals WHERE status='pending'
      ORDER BY confidence DESC, created_at ASC LIMIT 20`),
    query(`
      SELECT id, entry_date, ingestion_status, ingestion_attempts
      FROM journal_entries WHERE ingestion_status IN ('failed','needs_review')
      ORDER BY entry_date DESC LIMIT 20`),
    query(`
      SELECT ef.id, ef.fact_type, ef.fact_text, ef.confidence, ef.source_type, ef.source_id, ef.target_type, ef.target_id
      FROM extracted_facts ef
      WHERE ef.needs_review = true AND ef.status = 'active' AND ${activeEntitySql('ef.source_type', 'ef.source_id')} AND ${activeEntitySql('ef.target_type', 'ef.target_id')}
      ORDER BY ef.confidence ASC LIMIT 20`),
    query(`
      SELECT g.id, g.title, g.status
      FROM goals g
      WHERE g.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM entity_summaries es
          WHERE es.entity_type='goal' AND es.entity_id=g.id
            AND es.summary_type='planning'
            AND es.needs_review = false
        )
      LIMIT 10`),
    query(`
      SELECT t.id, t.title, t.priority, t.due_date, g.title AS goal_title
      FROM tasks t
      LEFT JOIN goals g ON g.id = t.goal_id
      WHERE t.completed = false AND ${activeTaskSql('t.id')}
        AND t.priority IN ('high','critical')
        AND (t.estimated_minutes IS NULL OR t.estimated_minutes = 0)
        AND (g.archived_at IS NULL OR t.goal_id IS NULL)
      LIMIT 10`),
    query(`
      SELECT t.id, t.title, t.status, t.priority,
             COALESCE(t.hard_deadline,t.target_date,t.due_date) AS deadline,
             g.title AS goal_title
      FROM tasks t
      LEFT JOIN goals g ON g.id = t.goal_id
      WHERE t.completed = false AND ${activeTaskSql('t.id')}
        AND t.status <> 'done'
        AND COALESCE(t.hard_deadline,t.target_date,t.due_date) < CURRENT_DATE::text
        AND (g.archived_at IS NULL OR t.goal_id IS NULL)
      ORDER BY COALESCE(t.hard_deadline,t.target_date,t.due_date) ASC
      LIMIT 10`),
    query(`
      SELECT t.id, t.title, t.status, t.priority,
             COALESCE(t.hard_deadline,t.target_date,t.due_date) AS deadline,
             g.title AS goal_title
      FROM tasks t
      LEFT JOIN goals g ON g.id = t.goal_id
      WHERE t.completed = false AND ${activeTaskSql('t.id')}
        AND t.status <> 'done'
        AND COALESCE(t.hard_deadline,t.target_date,t.due_date)
            BETWEEN CURRENT_DATE::text AND (CURRENT_DATE + INTERVAL '3 days')::date::text
        AND (g.archived_at IS NULL OR t.goal_id IS NULL)
      ORDER BY COALESCE(t.hard_deadline,t.target_date,t.due_date) ASC
      LIMIT 10`),
    query(`
      SELECT t.id, t.title, t.status, t.priority,
             COALESCE(t.hard_deadline,t.target_date,t.due_date) AS deadline,
             g.title AS goal_title
      FROM tasks t
      LEFT JOIN goals g ON g.id = t.goal_id
      WHERE t.completed = false AND ${activeTaskSql('t.id')}
        AND t.status = 'blocked'
        AND (g.archived_at IS NULL OR t.goal_id IS NULL)
      ORDER BY t.updated_at ASC
      LIMIT 10`),
    query(`
      SELECT t.id, t.title, t.status, t.priority, t.last_activity_at,
             COALESCE(t.hard_deadline,t.target_date,t.due_date) AS deadline,
             g.title AS goal_title
      FROM tasks t
      LEFT JOIN goals g ON g.id = t.goal_id
      WHERE t.completed = false AND ${activeTaskSql('t.id')}
        AND t.status = 'in_progress'
        AND COALESCE(t.last_activity_at,t.updated_at) < (NOW() - INTERVAL '7 days')::text
        AND (g.archived_at IS NULL OR t.goal_id IS NULL)
      ORDER BY COALESCE(t.last_activity_at,t.updated_at) ASC
      LIMIT 10`),
  ]);

  const sections = [
    { bucket: 'overdue_tasks',             items: overdueTasks,            label: 'Overdue tasks' },
    { bucket: 'due_soon_tasks',            items: dueSoonTasks,            label: 'Tasks due in the next 3 days' },
    { bucket: 'blocked_tasks',              items: blockedTasks,            label: 'Blocked tasks' },
    { bucket: 'stale_in_progress',          items: staleInProgressTasks,    label: 'In-progress tasks with no activity for 7 days' },
    { bucket: 'pending_proposals',         items: await activeProposals(pendingProposals),         label: 'AI proposals awaiting review' },
    { bucket: 'failed_journal_ingestion',  items: failedJournals,           label: 'Journal entries with failed AI extraction' },
    { bucket: 'facts_needing_review',      items: needsReviewFacts,         label: 'Extracted facts flagged for human review' },
    { bucket: 'goals_missing_summary',     items: staleGoalSummaries,       label: 'Goals without a planning summary' },
    { bucket: 'high_priority_unestimated', items: unestimatedHighPriority,  label: 'High/critical tasks missing time estimate' },
  ];

  const total = sections.reduce((s, sec) => s + sec.items.length, 0);
  res.json({ total, sections, timestamp: new Date().toISOString() });
});

// POST /api/ai/entity-summaries/backfill
// Generates deterministic planning/evidence/graph_card summaries for all entities
// that are missing a planning summary.
router.post('/entity-summaries/backfill', async (_req, res) => {
  const ENTITY_TYPES: Array<{ table: string; type: string }> = [
    { table: 'goals', type: 'goal' },
    { table: 'tasks', type: 'task' },
    { table: 'goal_milestones', type: 'milestone' },
    { table: 'resources', type: 'resource' },
    { table: 'meetings', type: 'meeting' },
  ];

  let queued = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const { table, type } of ENTITY_TYPES) {
    const { rows: entities } = await query(
      `SELECT e.id FROM ${table} e
       WHERE NOT EXISTS (
         SELECT 1 FROM entity_summaries es
         WHERE es.entity_type=$1 AND es.entity_id=e.id AND es.summary_type='planning'
       )
       LIMIT 200`,
      [type],
    );

    for (const row of entities as { id: string }[]) {
      try {
        await generateDeterministicSummaries(type, row.id);
        queued++;
      } catch (err) {
        errors.push(`${type}/${row.id}: ${String(err)}`);
      }
    }

    const { rows: withSummary } = await query(
      `SELECT COUNT(*) as c FROM ${table} e
       WHERE EXISTS (
         SELECT 1 FROM entity_summaries es
         WHERE es.entity_type=$1 AND es.entity_id=e.id AND es.summary_type='planning'
       )`,
      [type],
    );
    skipped += Number((withSummary[0] as Record<string, unknown>).c ?? 0);
  }

  res.json({ queued, skipped, errors: errors.slice(0, 20) });
});

// ─── Chat session management (Epic 42 — durable conversation runtime) ─────────

// GET /api/ai/sessions — list sessions (most recent first)
router.get('/sessions', async (_req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.title, s.model, s.created_at, s.updated_at,
            COUNT(m.id)::int AS message_count
     FROM chat_sessions s
     LEFT JOIN chat_messages m ON m.session_id = s.id AND m.role != 'system'
     WHERE s.archived = false
     GROUP BY s.id
     ORDER BY s.updated_at DESC
     LIMIT 100`,
  );
  res.json(rows);
});

// POST /api/ai/sessions — create a new session
router.post('/sessions', async (req, res) => {
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  const { title, model } = req.body as { title?: string; model?: string };
  let selectedModel: string;
  try {
    selectedModel = resolveChatModel(model);
  } catch (error) {
    return res.status(400).json({ error: String((error as Error).message), available_models: CHAT_MODEL_OPTIONS });
  }
  await query(
    `INSERT INTO chat_sessions (id, title, model, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)`,
    [id, title ?? null, selectedModel, now, now],
  );
  res.json({ id, title: title ?? null, model: selectedModel, created_at: now, updated_at: now });
});

// GET /api/ai/sessions/:id/messages — retrieve message history for a session
router.get('/sessions/:id/messages', async (req, res) => {
  const { rows: session } = await query('SELECT id FROM chat_sessions WHERE id=$1', [req.params.id]);
  if (!session.length) return res.status(404).json({ error: 'Session not found' });
  const { rows } = await query(
    `SELECT id, role, content, metadata_json, created_at FROM chat_messages
     WHERE session_id=$1 AND role != 'system'
     ORDER BY created_at ASC`,
    [req.params.id],
  );
  // Hydrate action cards with the CURRENT proposal status so a reloaded
  // conversation shows applied/rejected state instead of stale "pending".
  const messages = rows as Array<Record<string, unknown>>;
  const proposalIds = new Set<string>();
  for (const m of messages) {
    if (!m.metadata_json) continue;
    try {
      const meta = JSON.parse(m.metadata_json as string);
      for (const a of meta.actions ?? []) if (a.proposal_id) proposalIds.add(a.proposal_id);
    } catch { /* tolerate malformed metadata */ }
  }
  let statusById: Record<string, string> = {};
  if (proposalIds.size) {
    const { rows: props } = await query(
      `SELECT id, status FROM ai_action_proposals WHERE id = ANY($1)`,
      [[...proposalIds]],
    );
    statusById = Object.fromEntries((props as { id: string; status: string }[]).map(p => [p.id, p.status]));
  }
  const hydrated = messages.map(m => {
    if (!m.metadata_json) return { ...m, metadata: null, metadata_json: undefined };
    try {
      const meta = JSON.parse(m.metadata_json as string);
      for (const a of meta.actions ?? []) {
        if (a.proposal_id) a.proposal_status = statusById[a.proposal_id] ?? 'missing';
      }
      return { ...m, metadata: meta, metadata_json: undefined };
    } catch {
      return { ...m, metadata: null, metadata_json: undefined };
    }
  });
  res.json(hydrated);
});

// POST /api/ai/sessions/:id/chat — send a message in a session (history auto-loaded)
router.post('/sessions/:id/chat', rateLimit(60, 60_000, 'ai-session-chat'), async (req, res) => {
  const input = z.object({ message: z.string().min(1).max(16000).refine(value => Boolean(value.trim())), model: z.string().optional() }).strict().safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'A message between 1 and 16000 characters is required.' });
  const { message, model } = input.data;
  const requestStartedAt = Date.now();
  const modelCalls: ChatRuntimeCall[] = [];

  // Load or create session
  const { rows: sessionRows } = await query<{ id: string; model: string | null }>(
    'SELECT id, model FROM chat_sessions WHERE id=$1',
    [req.params.id],
  );
  if (!sessionRows.length) return res.status(404).json({ error: 'Session not found' });
  let selectedModel: string;
  try {
    selectedModel = resolveChatModel(model ?? sessionRows[0].model);
  } catch (error) {
    return res.status(400).json({ error: String((error as Error).message), available_models: CHAT_MODEL_OPTIONS });
  }
  if (model && model !== sessionRows[0].model) {
    await query('UPDATE chat_sessions SET model=$1 WHERE id=$2', [selectedModel, req.params.id]);
  }
  const runtimeInfo = (): ChatRuntime => ({
    total_ms: Date.now() - requestStartedAt,
    primary_model: selectedModel,
    fallback_model: NVIDIA_CONFIGURED && NVIDIA_MODEL !== selectedModel
      ? NVIDIA_MODEL
      : FALLBACK_MODEL || null,
    local_fallback_model: NVIDIA_CONFIGURED && NVIDIA_MODEL !== selectedModel
      ? FALLBACK_MODEL || null
      : null,
    model_calls: [...modelCalls],
  });

  // Preserve both sides of the exchange plus saved card facts. No classifier
  // extracts the last few user messages or replaces the current request.
  const { rows: historyRows } = await query<{
    role: 'user' | 'assistant'; content: string; metadata_json: string | null;
  }>(`SELECT role,content,metadata_json FROM (
      SELECT role,content,metadata_json,created_at,id FROM chat_messages
      WHERE session_id=$1 AND role IN ('user','assistant') ORDER BY created_at DESC,id DESC LIMIT 100
    ) recent ORDER BY created_at ASC, CASE role WHEN 'user' THEN 0 ELSE 1 END ASC`, [req.params.id]);
  const history: ConversationTurn[] = historyRows.map(row => {
    let context: unknown;
    try {
      const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null;
      if (metadata) context = {
        actions: metadata.actions?.map((action: ValidatedAction) => ({ type: action.type, description: action.description, params: action.params, proposal_id: action.proposal_id })),
        plan: metadata.plan ? { from: metadata.plan.from, to: metadata.plan.to, status: metadata.plan.status, blocks: metadata.plan.blocks?.slice(0, 30) } : undefined,
        plan_options: metadata.plan_options?.options?.map((plan: { name: string; from: string; to: string; blocks?: unknown[] }) => ({ name: plan.name, from: plan.from, to: plan.to, blocks: plan.blocks?.slice(0, 10) })),
        displayed_date: metadata.schedule_day_view?.date,
      };
    } catch { /* Invalid legacy metadata must not hide the actual conversation. */ }
    return { role: row.role, content: row.content, context };
  });
  const agentRunId = await startAgentRun({
    source: 'copilot_chat', agentKind: 'conversation', sessionId: req.params.id,
    userMessage: message, model: selectedModel, metadata: { history_messages: history.length, routing: 'model_led' },
  });
  try {
    const result = await answerConversation([...history, { role: 'user', content: message }], {
      model: selectedModel, source: 'chat_session', sessionId: req.params.id, agentRunId,
      onTrace: trace => modelCalls.push({ phase: 'answer', ...trace }),
    });
    const runtime = runtimeInfo();
    const now = new Date().toISOString();
    const userMessageId = crypto.randomUUID(); const messageId = crypto.randomUUID();
    const metadata = { ...result, agent_run_id: agentRunId, model: selectedModel, runtime };
    await query(`INSERT INTO chat_messages (id,session_id,role,content,metadata_json,created_at)
      VALUES ($1,$2,'user',$3,NULL,$4),($5,$2,'assistant',$6,$7,$4)`,
      [userMessageId,req.params.id,message,now,messageId,result.reply,JSON.stringify(metadata)]);
    await query('UPDATE chat_sessions SET updated_at=$1 WHERE id=$2', [now,req.params.id]);
    await setAgentIntent(agentRunId, result.conversation.needs_clarification ? 'clarification' : result.actions[0]?.type ?? 'conversation', 0, { routing: 'model_led', action_count: result.actions.length });
    await finishAgentRun(agentRunId, 'completed', result.reply, { metadata: { action_count: result.actions.length, tool_calls: result.conversation.tool_calls, runtime } });
    res.json({ ...result, session_id: req.params.id, message_id: messageId, agent_run_id: agentRunId, runtime });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Copilot could not finish this reply. Please try again.';
    await finishAgentRun(agentRunId, 'failed', null, { error: message }).catch(() => {});
    res.status(502).json({ error: message });
  }
});

// DELETE /api/ai/sessions/:id — archive (soft delete) a session
router.delete('/sessions/:id', async (req, res) => {
  const { rowCount } = await query(`UPDATE chat_sessions SET archived=true WHERE id=$1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true });
});

export { router as aiRouter };
