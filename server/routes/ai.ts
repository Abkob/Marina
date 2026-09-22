import { Router } from 'express';
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
import {
  hasExplicitSchedulePlanIntent,
  hasEstimateOrRoutineIntent,
  hasTaskConfigurationIntent,
  wantsOverdueTaskList,
  wantsScheduleDayView,
} from '../services/scheduleIntent.js';
import { assertSafeAIContext } from '../utils/contextSafety.js';
import { rateLimit } from '../utils/rateLimit.js';
import { generateDeterministicSummaries, generateEntitySummary } from '../services/summaryGenerator.js';
import { markEmbeddingStale, queueEmbeddingUpsert } from '../services/embeddingLifecycle.js';
import { appendAgentEvent, finishAgentRun, setAgentIntent, startAgentRun } from '../services/agentLedger.js';
import {
  applyScheduleIntentDecision,
  buildToolPlan,
  classifyScheduleIntent,
  interpretObjective,
  type ScheduleIntentDecision,
} from '../services/semanticOrchestrator.js';
import { searchResearchEvidence } from '../services/researchRag.js';
import { findExplicitTaskMatches } from '../services/contextTargeting.js';
import { synchronizedTaskDeadlineUpdates } from '../utils/taskDeadline.js';
import { runInBackground } from '../utils/background.js';
import { simpleConversationReply } from '../services/conversationFastPath.js';
import {
  buildTaskTimelineResolver,
  type GoalTimelineRow,
  type MilestoneTimelineRow,
  type TaskTimelineRow,
  type TimelineSource,
} from '../services/taskTimeline.js';

const router = Router();

// Fast paths are useful for cheap, literal lookups, but they intentionally
// bypass the answer model. Keep them feature-gated so nuanced conversations
// can always reach the full semantic model while deterministic schedulers
// remain available as post-understanding calculation tools.
const COPILOT_DETERMINISTIC_FAST_PATHS =
  process.env.AMINA_COPILOT_DETERMINISTIC_FAST_PATHS !== 'false';

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
                    AND child.completed = false
                )
            ), 0) as mins_remaining,
            COALESCE(SUM(ws.logged) FILTER (
              WHERE NOT t.completed
                AND NOT EXISTS (
                  SELECT 1 FROM tasks child
                  WHERE child.parent_task_id = t.id
                    AND child.completed = false
                )
            ), 0) as mins_logged
     FROM tasks t
     LEFT JOIN (SELECT task_id, SUM(minutes) as logged FROM work_sessions WHERE minutes IS NOT NULL GROUP BY task_id) ws ON ws.task_id=t.id
     WHERE t.goal_id = ANY($1)
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
  let coverageSql = `
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
    WHERE t.completed = false
      AND t.status <> 'done'
      AND (g.archived_at IS NULL OR t.goal_id IS NULL)
  `;
  if (goalIds.length) {
    coverageParams.push(goalIds);
    coverageSql += ` AND t.goal_id = ANY($${coverageParams.length})`;
  }
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
     LEFT JOIN tasks child ON child.parent_task_id = t.id AND child.completed = false
     WHERE t.completed = false
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
     FROM meetings WHERE scheduled_at >= $1 AND scheduled_at <= $2 ORDER BY scheduled_at ASC`,
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
     WHERE week_start IS NOT NULL
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
       WHERE etl.event_id = ANY($1)`,
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
     WHERE relationship='blocks' AND source_type='task' AND target_type='task'`,
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
    const timelineMinutes = timelineBlocks.reduce((sum, block) => sum + block.duration_minutes, 0);
    const dayLevelMinutes = dayLevelTasks.reduce((sum, task) => sum + (task.remaining_minutes ?? 0), 0);
    const scheduledMinutes = timelineMinutes + dayLevelMinutes;
    return {
      date: day.date,
      scheduled_minutes: scheduledMinutes,
      free_after_scheduled_minutes: day.capacity.effective_capacity_minutes - scheduledMinutes,
      timeline_blocks: timelineBlocks,
      day_level_tasks: dayLevelTasks,
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
         WHERE t.id = ANY($1)`,
        [targetedTaskIds],
      ),
      query(
        `SELECT id, parent_task_id, title, status, priority, start_date,
                COALESCE(hard_deadline,target_date,due_date) AS deadline,
                estimated_minutes, actual_minutes, feel_score, completed
         FROM tasks WHERE parent_task_id = ANY($1)
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
      `SELECT id, title, type FROM resources ORDER BY created_at DESC LIMIT 50`,
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

async function loadModelSelectedScheduleScope(decision: ScheduleIntentDecision) {
  if (decision.operation !== 'move_existing' || !decision.source_date || !decision.target_date) return null;
  const dates = [decision.source_date, decision.target_date];
  const [{ rows: tasks }, { rows: events }] = await Promise.all([
    query(
      `SELECT id, title, status, completed, start_date, due_date, target_date, hard_deadline,
              estimated_minutes, actual_minutes
       FROM tasks
       WHERE start_date = ANY($1) OR due_date = ANY($1) OR target_date = ANY($1) OR hard_deadline = ANY($1)
       ORDER BY completed ASC, title`,
      [dates],
    ),
    query(
      `SELECT e.id, e.title, e.type, e.week_start, e.day_index, e.start_hour,
              e.duration_hours, e.locked, e.source,
              COALESCE(array_remove(array_agg(etl.task_id), NULL), ARRAY[]::text[]) AS task_ids
       FROM events e
       LEFT JOIN event_task_links etl ON etl.event_id=e.id
       WHERE e.week_start IS NOT NULL
       GROUP BY e.id
       ORDER BY e.start_hour`,
    ),
  ]);
  const eventFacts = (events as Array<Record<string, unknown>>).flatMap(event => {
    const date = eventDateServer(String(event.week_start), Number(event.day_index ?? 0));
    return dates.includes(date) ? [{ ...event, date }] : [];
  });
  const taskFacts = tasks as Array<Record<string, unknown>>;
  const relevantTypes = new Set(decision.scope.entity_types);
  const belongsToDate = (task: Record<string, unknown>, date: string) =>
    (relevantTypes.has('tasks') && task.start_date === date)
    || (relevantTypes.has('deadlines')
      && (task.due_date === date || task.target_date === date || task.hard_deadline === date));
  return {
    selected_by_model: {
      operation: decision.operation,
      source_date: decision.source_date,
      target_date: decision.target_date,
      scope: decision.scope,
      preserve_event_times: decision.preserve_event_times,
    },
    source: {
      tasks: taskFacts.filter(task => belongsToDate(task, decision.source_date!)),
      events: relevantTypes.has('events') ? eventFacts.filter(event => event.date === decision.source_date) : [],
    },
    target: {
      tasks: taskFacts.filter(task => belongsToDate(task, decision.target_date!)),
      events: relevantTypes.has('events') ? eventFacts.filter(event => event.date === decision.target_date) : [],
    },
  };
}

/**
 * Progressive-disclosure context for the model:
 * - complete compact hierarchy on every turn
 * - compact two-week schedule and risk signals
 * - rich prose/notes/work history only for explicitly named tasks
 */
function compactContextForModel(context: ScheduleContext, userQuery?: string | null): Record<string, unknown> {
  const workloadByDate = new Map(context.daily_workload.map(day => [day.date, day]));
  const scheduleHorizon = context.current_schedule_days.map(day => {
    const workload = workloadByDate.get(day.date);
    return {
      date: day.date,
      capacity_minutes: workload?.capacity.available_after_fixed_minutes ?? 0,
      fixed_minutes: workload?.capacity.fixed_commitment_minutes ?? 0,
      scheduled_minutes: day.scheduled_minutes,
      free_minutes: day.free_after_scheduled_minutes,
      due_minutes: day.due_work.due_leaf_minutes,
      over_capacity_minutes: day.due_work.over_capacity_minutes,
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
  const asksForResources = /\b(file|document|resource|upload|attachment|library|paper|pdf)\b/i.test(userQuery ?? '');

  const compact: Record<string, unknown> = {
    today: context.today,
    schedule_prefs: context.schedule_prefs,
    scheduler_result: context.scheduler_result,
    planning_coverage: context.planning_coverage,
    goal_task_hierarchy: context.goal_task_hierarchy,
    schedule_horizon_next_14_days: scheduleHorizon,
    meetings_next_14_days: context.meetings_next_14_days,
    schedule_overrides: context.schedule_overrides,
    attention_queue: context.attention_queue,
    planning_focus: planningFocus,
    targeted_task_context: context.targeted_task_context,
    recent_journal: context.recent_journal.slice(0, 3),
    retrieval_meta: context.retrieval_meta,
    ...(asksForResources ? { resources: context.resources.slice(0, 20) } : {}),
  };

  // The hierarchy is the non-negotiable complete baseline. If unusually long
  // titles/notes approach the safety cap, trim optional targeted prose first.
  if (JSON.stringify(compact).length >= 48_000) {
    compact.recent_journal = [];
    compact.meetings_next_14_days = context.meetings_next_14_days.slice(0, 10);
    compact.targeted_task_context = context.targeted_task_context.map(task => ({
      ...task,
      recent_notes: [],
      recent_work_sessions: [],
      evidence_facts: [],
    }));
  }
  return compact;
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

const WEEKDAY_INDEX: Array<{ index: number; patterns: RegExp[] }> = [
  { index: 0, patterns: [/\bsunday\b/i, /\bsun\b/i] },
  { index: 1, patterns: [/\bmonday\b/i, /\bmon\b/i] },
  { index: 2, patterns: [/\btuesday\b/i, /\btues\b/i, /\btue\b/i, /\bteus\w*\b/i, /\btueds\w*\b/i] },
  { index: 3, patterns: [/\bwednesday\b/i, /\bwed\b/i] },
  { index: 4, patterns: [/\bthursday\b/i, /\bthu\b/i, /\bthur\b/i] },
  { index: 5, patterns: [/\bfriday\b/i, /\bfri\b/i] },
  { index: 6, patterns: [/\bsaturday\b/i, /\bsat\b/i] },
];

function addDaysLocal(date: string, days: number): string {
  return addDaysStr(date, days);
}

function resolveScheduleDayViewDate(message: string | null | undefined, today: string, availableDates: string[]): string {
  const text = (message ?? '').toLowerCase();
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (iso && availableDates.includes(iso)) return iso;
  if (/\b(tomorrow|tmrw|tmr)\b/.test(text)) {
    const tomorrow = addDaysLocal(today, 1);
    if (availableDates.includes(tomorrow)) return tomorrow;
  }
  if (/\btoday\b/.test(text)) return today;

  const todayIndex = new Date(today + 'T00:00:00').getDay();
  for (const weekday of WEEKDAY_INDEX) {
    if (!weekday.patterns.some(pattern => pattern.test(text))) continue;
    const offset = (weekday.index - todayIndex + 7) % 7;
    const date = addDaysLocal(today, offset);
    if (availableDates.includes(date)) return date;
  }

  return today;
}

function buildScheduleDayView(context: ScheduleContext, userMessage?: string | null): ChatScheduleDayView | null {
  if (!wantsScheduleDayView(userMessage)) return null;
  const currentDays = context.current_schedule_days;
  if (!currentDays.length) return null;
  const date = resolveScheduleDayViewDate(userMessage, context.today, currentDays.map(day => day.date));
  const scheduleDay = currentDays.find(day => day.date === date) ?? currentDays[0];
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

function formatChatScheduleDayReply(view: ChatScheduleDayView): string {
  const fmt = (minutes: number) => {
    const rounded = Math.round(minutes);
    const abs = Math.abs(rounded);
    if (abs === 0) return '0h';
    if (abs < 60) return `${rounded}m`;
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return `${rounded < 0 ? '-' : ''}${h}h${m ? ` ${m}m` : ''}`;
  };
  const date = new Date(view.date + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
  if (view.due_leaf_minutes > 0) {
    const placed = view.scheduled_minutes > 0 ? `${fmt(view.scheduled_minutes)} is on your calendar` : 'nothing is on your calendar';
    const overflow = view.over_capacity_minutes > 0 ? ` ${fmt(view.over_capacity_minutes)} will not fit in your available time.` : '';
    return `${date}: ${placed}, and ${fmt(view.due_leaf_minutes)} is still unscheduled.${overflow}`;
  }
  if (view.scheduled_minutes > 0) return `${date}: ${fmt(view.scheduled_minutes)} is scheduled, with ${fmt(Math.max(0, view.free_after_scheduled_minutes))} still open.`;
  return `${date} is empty. Nothing is scheduled or due.`;
}

function formatDeadlineOverviewReply(context: ScheduleContext, userMessage?: string | null): string {
  const inferred = inferPlanWindowFromMessage(userMessage, context.today).params;
  const fromDate = inferred.from_date ?? context.today;
  const toDate = inferred.to_date ?? addDaysStr(fromDate, 6);
  const groups = context.planning_buckets.must_finish_by_date
    .filter(group => group.date >= fromDate && group.date <= toDate);
  const formatMinutes = (minutes: number | null) => {
    if (minutes === null) return 'unestimated';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return `${hours}h${remainder ? ` ${remainder}m` : ''}`;
  };
  const formatDate = (date: string) => new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
  if (!groups.length) {
    return `You have no incomplete tasks with deadlines from ${formatDate(fromDate)} through ${formatDate(toDate)}.`;
  }
  const lines = groups.flatMap(group => [
    `**${formatDate(group.date)}**`,
    ...group.tasks.map(task => {
      const goal = task.goal_title ? ` · ${task.goal_title}` : '';
      return `- ${task.title} (${formatMinutes(task.remaining_minutes)}${goal})`;
    }),
    '',
  ]);
  const taskCount = groups.reduce((sum, group) => sum + group.tasks.length, 0);
  return `Here are ${taskCount} incomplete task${taskCount === 1 ? '' : 's'} grouped by their current database deadlines:\n\n${lines.join('\n').trim()}`;
}

function formatOverdueTaskReply(context: ScheduleContext): string | null {
  if (!context.overdue_tasks.length) return 'You have no open tasks with an overdue effective deadline.';
  return `You have ${context.overdue_tasks.length} overdue open tasks. I grouped them by project and ordered them by urgency below.`;
}

const SYSTEM_PROMPT = `You are Amina Copilot — an intelligent life planning assistant embedded in Amina OS, a personal goal and project management system.

You have full visibility into the user's goals, milestones, tasks, meetings, work sessions, and journal entries. Your job is to:

1. Analyze schedules for feasibility — flag tasks/goals that won't fit before their deadlines
2. Help the user add tasks, goals, milestones by understanding natural language
3. Intelligently place new items into the right goal/milestone based on context
4. Suggest date and priority adjustments when things are at risk
5. Surface patterns from journal entries and recent activity
6. Always be honest about what's genuinely infeasible
7. Act as a proactive executive assistant: find vague or oversized tasks that
   need concrete next steps, stale work that needs attention, and genuine
   routines that should repeat on specific days

## Response format
ALWAYS respond with a valid JSON object (no markdown wrapping, pure JSON):
{
  "reply": "Your conversational reply (use markdown for formatting)",
  "actions": [
    {
      "id": "a1",
      "type": "create_task",
      "description": "Human-readable description of this action",
      "params": {
        "goal_id": "...",
        "parent_task_id": null,
        "milestone_id": null,
        "title": "...",
        "due_date": "YYYY-MM-DD",
        "start_date": "YYYY-MM-DD",
        "priority": "high|medium|low",
        "estimated_minutes": 120,
        "status": "todo"
      }
    },
    {
      "id": "a2",
      "type": "break_down_task",
      "description": "Turn one existing vague or oversized task into concrete child tasks",
      "params": {
        "parent_task_id": "<existing task id>",
        "tasks": [
          {
            "title": "Concrete next step",
            "due_date": "YYYY-MM-DD",
            "start_date": "YYYY-MM-DD",
            "priority": "high|medium|low",
            "estimated_minutes": 60
          }
        ]
      }
    },
    {
      "id": "a3",
      "type": "create_goal",
      "description": "...",
      "params": {
        "title": "...",
        "description": "...",
        "deadline": "YYYY-MM-DD",
        "start_date": "YYYY-MM-DD",
        "category": "Work|Personal|Health|Learning|Home|Money|Creative|Admin"
      }
    },
    {
      "id": "a4",
      "type": "create_goal_with_tasks",
      "description": "Create a goal and its starter tasks in one transaction",
      "params": {
        "title": "...",
        "description": "...",
        "deadline": "YYYY-MM-DD",
        "start_date": "YYYY-MM-DD",
        "category": "Work|Personal|Health|Learning|Home|Money|Creative|Admin",
        "tasks": [
          {
            "title": "...",
            "due_date": "YYYY-MM-DD",
            "start_date": "YYYY-MM-DD",
            "priority": "high|medium|low",
            "estimated_minutes": 60,
            "status": "todo"
          }
        ]
      }
    },
    {
      "id": "a5",
      "type": "update_task",
      "description": "...",
      "params": {
        "task_id": "...",
        "due_date": "YYYY-MM-DD",
        "start_date": "YYYY-MM-DD",
        "priority": "high|medium|low",
        "status": "todo|in_progress|inactive|done",
        "estimated_minutes": 60
      }
    },
    {
      "id": "a6",
      "type": "update_goal",
      "description": "...",
      "params": {
        "goal_id": "...",
        "deadline": "YYYY-MM-DD",
        "status": "Safe|Watch|Risky"
      }
    },
    {
      "id": "a7",
      "type": "create_milestone",
      "description": "...",
      "params": {
        "goal_id": "...",
        "title": "...",
        "description": "...",
        "due_date": "YYYY-MM-DD",
        "color": "#6366f1"
      }
    },
    {
      "id": "a8",
      "type": "attach_resource",
      "description": "File <resource title> under <target title>",
      "params": {
        "resource_id": "<id from the resources list>",
        "target_type": "goal|task|milestone",
        "target_id": "<id>"
      }
    },
    {
      "id": "a9",
      "type": "plan_schedule",
      "description": "Lay the user's tasks onto their calendar ONLY when they explicitly ask you to plan, schedule, reschedule, organize, fill, fit, suggest, or recommend a schedule",
      "params": {
        "task_id": "<optional — use when the user asks to place one specific task>",
        "max_daily_minutes": 120,
        "horizon_days": 14,
        "from_date": "YYYY-MM-DD",
        "to_date": "YYYY-MM-DD",
        "start_hour": 13.5,
        "end_hour": 18,
        "relative_hours": 3
      }
    },
    {
      "id": "a10",
      "type": "create_block_series",
      "description": "Recurring routine time, e.g. every morning 6-9 for a month",
      "params": {
        "title": "Morning study",
        "start_date": "YYYY-MM-DD",
        "end_date": "YYYY-MM-DD",
        "start_hour": 6,
        "end_hour": 9,
        "days_of_week": [1, 2, 3, 4, 5],
        "task_id": "<optional — link every session to this task>"
      }
    },
    {
      "id": "a11",
      "type": "move_schedule_items",
      "description": "Move existing records selected by the semantic request from one date to another",
      "params": {
        "source_date": "YYYY-MM-DD",
        "target_date": "YYYY-MM-DD",
        "entity_types": ["tasks", "deadlines", "events"],
        "preserve_event_times": true
      }
    }
  ],
  "feasibility": {
    "status": "on_track|at_risk|critical",
    "summary": "...",
    "issues": [
      { "goal_id": "...", "goal_title": "...", "issue": "...", "severity": "warning|critical" }
    ]
  }
}

## Context structure
The JSON injected under "Current data" has these top-level keys:
- today: ISO date string
- schedule_prefs.effective_capacity_minutes: available work minutes per day after buffer (use THIS for scheduling math, not daily_capacity_minutes)
- scheduler_result: pre-computed feasibility analysis — TRUST THIS, do not redo the math yourself
  - status: 'feasible' | 'tight' | 'risky' | 'impossible'
  - gap_minutes: positive = surplus capacity, negative = overloaded
  - tasks_overflow: IDs of tasks that cannot fit in the 14-day horizon
  - unestimated_task_ids: IDs of tasks with no time estimate (flag these to the user)
  - impossible_reason: human-readable explanation when status is 'impossible'
  - task_diagnostics[].recovery_allocated_minutes / recovery_finish_date: best-effort work proposed after a cutoff cannot be met; this does not erase the missed deadline
- goal_task_hierarchy[]: COMPLETE compact baseline, grouped by goal
  - tasks[] are recursively nested under their parent tasks in children[]
  - each task includes its deadline and deadline_kind, remaining/logged minutes, feel_score, blockers, rollup status, and saved scheduled_blocks
  - remaining_minutes is estimated_minutes minus logged_minutes; null means unestimated
  - feel_score is the user's subjective 0-100 attention signal; null means not rated
  - is_rollup=true means the task is a container; do not add its own time to its children's time
- targeted_task_context[]: rich context included ONLY when this turn explicitly names a task
  - may include description, summaries, parent, children, recent task notes, recent work sessions, evidence facts, and saved schedule blocks
  - use this richer context for task-specific questions; an empty array means no task was explicitly targeted
- meetings_next_14_days[]: all meetings in the next 14 days
- recent_journal[]: AI summaries of recent journal entries (no raw text) — use for context on recent activity
- resources[]: included only for file/resource-related turns. When the user uploads a file in chat, its resource_id is stated in their message — use attach_resource to file it under goals/tasks/milestones THEY name. Never attach without being asked.
- schedule_overrides[]: days with non-standard capacity (vacation, sick day, etc.)
- schedule_horizon_next_14_days[]: compact authoritative schedule and due-work view
  - capacity_minutes is focus capacity left after fixed commitments
  - scheduled_minutes / free_minutes show saved placement load
  - due_minutes / over_capacity_minutes show deadline load
  - blocks[] are timed meetings/calendar blocks; task_ids link blocks back to goal_task_hierarchy
  - day_tasks[] are assigned to that date without a precise time
- planning_coverage: counts of ALL incomplete tasks by bucket (not just those in context)
  - total_incomplete: total across all active goals
  - tasks_in_context: how many are included in goal_task_hierarchy (capped at 200)
  - overdue / upcoming_dated / undated / unestimated / in_progress / blocked: bucket counts
  - When total_incomplete > tasks_in_context, mention that omitted tasks exist and they may affect planning
- attention_queue[]: pre-computed tasks needing attention, with signals such as OVERDUE, DUE_SOON, STARTING_SOON, BLOCKED, STALE_IN_PROGRESS, and HIGH_PRIORITY_UNESTIMATED
- OVERDUE entries in attention_queue are the authoritative open overdue set represented in context. Deadline precedence is hard_deadline, then target_date, then due_date (including inherited due dates).
- planning_focus: compact deadline-derived indexes
  - must_finish_by_date[] maps dates to task IDs
  - large_tasks_needing_slices[] gives remaining work and suggested daily minutes
  - parent_rollups[] carries the earliest/latest known child deadlines for undated container tasks
  - unestimated_due_soon_ids[] identifies work that cannot be scheduled honestly yet

## Rules
- Default schedule behavior is diagnostic: show the current schedule/workload with indicators. Do NOT recommend a new schedule, do NOT create plan_schedule, and do NOT propose schedule changes unless the user explicitly asks for planning, scheduling, rescheduling, fitting, filling, fixing, suggesting, or recommending a schedule.
- Informational schedule questions ("show/check/analyze/review/break down my Tuesday schedule", "show me a schedule", "why is Tuesday overloaded?", "what is my capacity?", "how much is each task taking?", "show my week") are NOT plan_schedule actions. Return actions: [] and answer from schedule_horizon_next_14_days, planning_focus, and goal_task_hierarchy.
- When the user says "don't suggest", "just show", "only breakdown", or asks to "show with indications", do not include recommendations, prioritization advice, rescheduling advice, or a trailing invitation to help fix it. Only report schedule facts and diagnostic indicators.
- Use clear diagnostic indicators in schedule breakdowns, for example: OVER CAPACITY, FREE TIME, FIXED COMMITMENT, DUE, OVERDUE, NEAR DEADLINE, UNESTIMATED, PARENT/ROLLUP. These are labels about the current data, not recommendations.
- Display user-facing durations in hours-first format: 10h, 1h 30m, 45m only for sub-hour items. Never write raw totals like 600min, 850min, or "850 minutes" in prose; use the minute-valued JSON fields only for internal math.
- A plan_schedule action is allowed only for explicit calendar-planning requests such as "plan my week", "schedule Tuesday", "make me a schedule", "reschedule my tasks", "fit my tasks in before Friday", "fill my free time", "fix my schedule", or "suggest/recommend a schedule". Derive the window from their words using the context's today date:
  - When the user names one specific task, include its exact task_id. Do not plan unrelated tasks.
  - When the user limits work per day (for example "2 hours a day"), include max_daily_minutes (120 in that example). Never silently exceed it.
  - a specific day → from_date = to_date = that date (resolve weekday names to the NEXT such date)
  - a range or horizon → from_date/to_date, or horizon_days from today (default 14)
  - part of a day ("this afternoon", "tonight") → also set start_hour/end_hour as 24h decimals (13.5 = 1:30 PM)
  - relative to right now ("the next 3 hours") → set relative_hours ONLY; the server knows the clock, you don't
  All params are optional — omit what the user didn't constrain. The app renders the plan as an interactive calendar the user can drag and apply.
- With plan_schedule, "reply" is your recommendation, not a schedule: 1–3 sentences on what to hit first and why, what's at risk, and what won't fit. NEVER enumerate day-by-day placements in text — the calendar shows them.
- Follow the Semantic request contract over generic scheduling defaults. When operation is move_existing, inspect semantic_schedule_scope, explain exactly what exists on the source date and what is already on the target date, and emit move_schedule_items using the contract's source_date, target_date, entity_types, and preserve_event_times. Do not emit plan_schedule, do not pull in unrelated backlog tasks, and do not discuss the global 14-day feasibility result unless the user asked for a broader feasibility review.
- For other move/reschedule/fix requests that create new placements rather than shifting existing dated records, do not claim you already moved tasks in prose. Emit plan_schedule when appropriate and keep reply short; nothing changes until the user confirms it.
- For schedule replies, use planning_focus and attention_queue vocabulary precisely:
  1. URGENT means tasks in must_finish_by_date for the requested date/window, plus overdue tasks.
  2. BIG/NEAR-DEADLINE means large_tasks_needing_slices: say "start/continue before its YYYY-MM-DD deadline", never "due today" unless that date is the actual deadline.
  3. BACKGROUND means far-deadline or undated leaf work in goal_task_hierarchy: suggest a small slice only if urgent and near-deadline work leaves slack.
  4. PARENT means a task with is_rollup=true: name it as context, but schedule/link leaf subtasks when possible.
     An undated parent is not timeless when parent_rollups gives child deadlines: use the earliest child date for urgency, the latest as the last known child cutoff, and keep scheduling the leaf children rather than assigning the parent a fabricated deadline.
- For "check/show schedule" day replies, keep reply text to 1-2 short sentences and do NOT enumerate the timeline as bullets. The app renders a visual day schedule widget. Use text only for a compact summary of the strongest indicators.
- In schedule replies, show block duration from blocks[].minutes, not linked task estimates. If free_minutes is negative, label it as PLACED OVERBOOKED by the absolute value; if positive, label it as FREE AFTER PLACED SCHEDULE.
- Display buffer as a reserved positive number ("Reserved buffer: 1h 25m"), not as a negative bullet. The formula should read like "14h 10m raw - 1h 25m buffer - 0h fixed = 12h 45m available".
- For pure workload/capacity breakdown replies, use schedule_horizon_next_14_days for that date and show its capacity, fixed, scheduled, free, due, and over-capacity values in hours-first format.
- Never double-count task hierarchies. A task with is_rollup=true is a container. Do not add its own estimate to child/subtask estimates.
- Never say a task is "due Monday/Tuesday/today" unless its actual hard_deadline, target_date, or due_date equals that date. If it is being worked earlier than its deadline, say "work on it before the deadline" or "slice toward <date>".
- RECURRING/ROUTINE requests ("every day 6–9am for a month", "weekday mornings until August", "gym MWF at 7") are ONE create_block_series action: derive start/end dates from their words (default span: one month), days_of_week (1=Mon…7=Sun) ONLY when they restrict days, task_id when they name an existing task. The app shows every occurrence on a calendar for one-tap apply.
- WHOLE-SCHEDULE/SMART-REVIEW requests must audit the complete goal_task_hierarchy and attention_queue, then reason across schedule_horizon_next_14_days, planning_coverage, planning_focus, meetings, blockers, estimates, logged work, feel scores, and recent journal summaries. Do not collapse a week or range review to one day. Rank the few interventions that materially improve the plan instead of dumping every task.
- BREAKDOWN requests and smart reviews may emit break_down_task for an existing vague, oversized, unestimated, or repeatedly stalled task. Create 2–8 concrete, verb-led child tasks with realistic estimates. Preserve the parent's goal and never invent a breakdown when the task is already atomic.
- REMINDER/ATTENTION behavior: explicitly surface overdue work, tasks starting soon, stale in-progress tasks, blocked tasks, and high-priority unestimated tasks. Explain what needs attention and why. Never claim a notification was scheduled unless an actual calendar or routine action is present.
- Only propose create_block_series when the user states a cadence or the stored data clearly describes a repeating routine. If cadence is unknown, ask one focused follow-up in the reply instead of guessing days or times.
- CREATE GOAL requests are not schedule requests. If the user asks to create/add/start a new goal and includes starter tasks, emit ONE create_goal_with_tasks action. "deadline is open" means omit deadline. "starts tomorrow" belongs in start_date. Resolve relative dates to YYYY-MM-DD using Current data today.
- Unestimated tasks are excluded from plans, but the plan widget lets the user estimate them with one tap — if many tasks lack estimates, mention it in your reply and encourage the quick triage.
- actions[] may be empty if no changes are needed
- Only propose actions that make sense given the user's data
- Use schedule_prefs.effective_capacity_minutes for all scheduling math
- Use remaining_minutes (not estimated_minutes) when computing how much work is left
- Treat feel_score as an important user signal when comparing otherwise similar tasks. Combine it with deadlines, blockers, remaining work, and priority; never present it as an objective measurement.
- When a task has blocker_ids, do not schedule it before all blockers are done
- For a task-specific request, read targeted_task_context first. For broad reviews, rely on the complete goal_task_hierarchy and do not assume absent prose means absent work.
- Milestones are checkpoints — suggest them when a goal has many unstructured tasks
- Dates must be YYYY-MM-DD
- estimated_minutes: be realistic (30min=30, 1h=60, 3h=180)
- Omit null fields from params entirely
- Use recent_journal summaries to understand what the user has been working on recently`;

const MOVE_EXISTING_SYSTEM_PROMPT = `You are Amina's semantic schedule-move agent. A separate model has already interpreted the user's intent and selected a source date, target date, entity scope, and time-preservation rule. Your job is to inspect the provided semantic_schedule_scope and produce a grounded proposed operation.

Return one valid JSON object only:
{
  "reply": "grounded explanation",
  "actions": [{
    "id": "a1",
    "type": "move_schedule_items",
    "description": "clear description",
    "params": {
      "source_date": "YYYY-MM-DD",
      "target_date": "YYYY-MM-DD",
      "entity_types": ["tasks", "deadlines", "events"],
      "preserve_event_times": true
    }
  }]
}

Rules:
- Reason from semantic_schedule_scope, not keywords and not a global planning horizon.
- In reply, count and name the source records that match the selected entity types. Distinguish task start dates, task deadlines, and calendar events.
- Briefly state what already exists on the target date and that those target records are not part of the move.
- Do not mention 14-day feasibility, backlog overflow, unrelated tasks, or plan_schedule.
- Do not say the move already happened. It is a proposal awaiting confirmation.
- If there are no matching source records, explain that and return actions: [].
- Copy dates, entity_types, and preserve_event_times from the semantic request contract exactly. Never invent IDs or dates.`;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
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

// POST /api/ai/chat — rate-limited: 60 per minute to prevent runaway Ollama calls
function coalesceNewGoalStarterTasks(actions: ValidatedAction[]): ValidatedAction[] {
  if (actions.some(action => action.type === 'create_goal_with_tasks' && !action.rejected_reason)) {
    return actions;
  }

  const goalIndex = actions.findIndex(action => action.type === 'create_goal' && !action.rejected_reason);
  if (goalIndex < 0) return actions;

  const unlinkedTaskActions = actions.filter(action =>
    action.type === 'create_task'
    && !action.rejected_reason
    && !action.params.goal_id
    && typeof action.params.title === 'string'
  );
  if (!unlinkedTaskActions.length) return actions;

  const goalAction = actions[goalIndex];
  const goalParams = goalAction.params;
  const taskActionIds = new Set(unlinkedTaskActions.map(action => action.id));
  const compound: ValidatedAction = {
    id: goalAction.id,
    type: 'create_goal_with_tasks',
    description: goalAction.description ?? `Create ${String(goalParams.title)} with starter tasks`,
    params: {
      title: goalParams.title,
      ...(goalParams.description ? { description: goalParams.description } : {}),
      ...(goalParams.deadline ? { deadline: goalParams.deadline } : {}),
      ...(goalParams.start_date ? { start_date: goalParams.start_date } : {}),
      ...(goalParams.category ? { category: goalParams.category } : {}),
      tasks: unlinkedTaskActions.map(action => ({
        title: action.params.title,
        ...(action.params.due_date ? { due_date: action.params.due_date } : {}),
        ...(action.params.start_date ? { start_date: action.params.start_date } : {}),
        ...(action.params.priority ? { priority: action.params.priority } : {}),
        ...(action.params.estimated_minutes ? { estimated_minutes: action.params.estimated_minutes } : {}),
        ...(action.params.status ? { status: action.params.status } : {}),
      })),
    },
  };

  return actions.flatMap((action, index) => {
    if (index === goalIndex) return [compound];
    if (taskActionIds.has(action.id)) return [];
    return [action];
  });
}

type ParsedChatEnvelope = { reply?: string; actions?: unknown[]; feasibility?: unknown };

function recoverReplyFromMalformedJSON(raw: string): string | null {
  const marker = raw.match(/"reply"\s*:\s*"/i);
  if (marker?.index === undefined) return null;
  const start = marker.index + marker[0].length;
  let escaped = false;
  let encoded = '';
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"' && !escaped) break;
    encoded += char;
    if (char === '\\' && !escaped) escaped = true;
    else escaped = false;
  }
  try { return JSON.parse(`"${encoded}"`) as string; } catch { return encoded.trim() || null; }
}

function parseChatEnvelope(raw: string): ParsedChatEnvelope {
  try {
    return parseJSON<ParsedChatEnvelope>(raw);
  } catch {
    const recoveredReply = recoverReplyFromMalformedJSON(raw);
    return {
      reply: recoveredReply
        ? `${recoveredReply}\n\n_I could not create the requested action because the model returned malformed structured data. No changes were made._`
        : 'I could not parse the model response into a safe action. No changes were made.',
      actions: [],
    };
  }
}

function normalizeTaskScopedActions(
  actions: ValidatedAction[],
  context: ScheduleContext,
  userMessage: string | null | undefined,
): ValidatedAction[] {
  const knownTaskIds = new Set<string>();
  const visit = (nodes: ContextTaskNode[]) => {
    for (const node of nodes) {
      knownTaskIds.add(node.id);
      visit(node.children);
    }
  };
  for (const goal of context.goal_task_hierarchy) visit(goal.tasks);
  const targetedIds = context.targeted_task_context
    .map(task => String(task.id ?? ''))
    .filter(Boolean);
  const dailyCap = inferMaxDailyMinutes(userMessage);
  const taskScopedTypes = new Set(['update_task', 'plan_schedule', 'create_block_series']);

  return actions.map(action => {
    if (action.rejected_reason || !taskScopedTypes.has(action.type)) return action;
    const params = { ...action.params };
    const taskId = typeof params.task_id === 'string' ? params.task_id : null;
    if ((!taskId || !knownTaskIds.has(taskId)) && targetedIds.length === 1) {
      params.task_id = targetedIds[0];
    } else if (taskId && !knownTaskIds.has(taskId)) {
      return { ...action, rejected_reason: `unknown task_id '${taskId}'` };
    }
    if (action.type === 'plan_schedule' && dailyCap) {
      params.max_daily_minutes = dailyCap;
    }
    return { ...action, params };
  });
}

function ensurePacedPlanAction(
  actions: ValidatedAction[],
  context: ScheduleContext,
  userMessage: string | null | undefined,
  schedulePlanAllowed: boolean,
): ValidatedAction[] {
  if (!schedulePlanAllowed || actions.some(action => action.type === 'plan_schedule' && !action.rejected_reason)) {
    return actions;
  }
  const dailyCap = inferMaxDailyMinutes(userMessage);
  const targetedIds = [...new Set(context.targeted_task_context
    .map(task => String(task.id ?? ''))
    .filter(Boolean))];
  if (!dailyCap || targetedIds.length !== 1) return actions;

  const window = inferPlanWindowFromMessage(userMessage, context.today).params;
  return [
    ...actions.filter(action => action.type !== 'unknown'),
    {
      id: 'paced-plan',
      type: 'plan_schedule',
      description: `Spread the named task across the requested window without exceeding ${dailyCap} minutes per day`,
      params: {
        ...window,
        task_id: targetedIds[0],
        max_daily_minutes: dailyCap,
      },
    },
  ];
}

router.post('/chat', rateLimit(60, 60_000, 'ai-chat'), async (req, res) => {
  const { messages }: { messages: ChatMessage[] } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  try {
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content;
    const planningMessage = resolvePlanningRequestMessage(lastUserMessage, messages);
    const dueDateUpdate = COPILOT_DETERMINISTIC_FAST_PATHS
      ? await applyExplicitBatchDueDate(lastUserMessage)
      : null;
    if (dueDateUpdate) {
      return res.json({
        reply: `Moved ${dueDateUpdate.tasks.length} task due date${dueDateUpdate.tasks.length !== 1 ? 's' : ''} to ${dueDateUpdate.date}: ${dueDateUpdate.tasks.join(', ')}.`,
        actions: [], citations: [], due_date_update: dueDateUpdate,
      });
    }
    const recentUserMessages = messages
      .filter(message => message.role === 'user')
      .map(message => message.content)
      .slice(0, -1);
    const scheduleDecision = await classifyScheduleIntent(lastUserMessage ?? '', recentUserMessages, {
      currentDate: fmtYMD(new Date()),
    });
    const semanticFrame = applyScheduleIntentDecision(
      interpretObjective(lastUserMessage ?? ''),
      scheduleDecision,
    );
    const toolPlan = buildToolPlan(semanticFrame);
    const schedulePlanRequested = scheduleDecision.mode === 'propose_change';
    const taskConfigurationRequested = hasTaskConfigurationIntent(lastUserMessage);
    if (COPILOT_DETERMINISTIC_FAST_PATHS && schedulePlanRequested && !taskConfigurationRequested) {
      const directPlanOptions = await buildPlanOptionsPayload(planningMessage);
      if (directPlanOptions) {
        return res.json({
          reply: directPlanOptions.advisory ?? 'I prepared the actual calendar placement below. Nothing changes until you apply a layout.',
          actions: [],
          citations: [],
          semantic: { frame: semanticFrame, schedule_decision: scheduleDecision, tool_plan: toolPlan, research_evidence_count: 0 },
          plan_options: directPlanOptions,
        });
      }
    }
    const researchEvidence = semanticFrame.domain === 'research' || semanticFrame.domain === 'mixed'
      ? await searchResearchEvidence(lastUserMessage ?? '', 8)
      : [];
    const { ctx: context, citations } = await getScheduleContext(lastUserMessage);
    const semanticScheduleScope = await loadModelSelectedScheduleScope(scheduleDecision);
    const overdueReply = COPILOT_DETERMINISTIC_FAST_PATHS && wantsOverdueTaskList(lastUserMessage)
      ? formatOverdueTaskReply(context)
      : null;
    if (overdueReply) {
      return res.json({
        reply: overdueReply,
        actions: [],
        citations: [],
        semantic: { frame: semanticFrame, schedule_decision: scheduleDecision, tool_plan: toolPlan, research_evidence_count: 0 },
        overdue_tasks_view: { tasks: context.overdue_tasks },
      });
    }
    const directDayView = COPILOT_DETERMINISTIC_FAST_PATHS && wantsScheduleDayView(lastUserMessage)
      ? buildScheduleDayView(context, lastUserMessage)
      : null;
    if (directDayView) {
      return res.json({
        reply: formatChatScheduleDayReply(directDayView),
        actions: [],
        citations: [],
        schedule_day_view: directDayView,
        semantic: { frame: semanticFrame, schedule_decision: scheduleDecision, tool_plan: toolPlan, research_evidence_count: 0 },
      });
    }
    const modelContext = compactContextForModel(context, lastUserMessage);
    const answerContext = scheduleDecision.operation === 'move_existing'
      ? { today: context.today }
      : modelContext;
    const answerSystemPrompt = scheduleDecision.operation === 'move_existing'
      ? MOVE_EXISTING_SYSTEM_PROMPT
      : SYSTEM_PROMPT;
    console.log(
      `[ai] model context: ${JSON.stringify(answerContext).length} chars, targeted tasks: ${context.targeted_task_context.length}`,
    );
    assertSafeAIContext(answerContext);
    // Compact JSON — pretty-printing inflates the prompt ~30% in tokens, which
    // slows local-model prompt evaluation and squeezes the context window.
    const contextStr = JSON.stringify(answerContext);

    const systemWithContext = `${answerSystemPrompt}

## Semantic request contract
${JSON.stringify({ frame: semanticFrame, schedule_decision: scheduleDecision, tool_plan: toolPlan })}
Treat this contract as the selected operation boundary. Never emit plan_schedule unless schedule_decision.mode is "propose_change". Never perform scheduling arithmetic yourself; only explain server-computed schedule results. Any mutating operation must remain a proposal until confirmed.

## Semantic schedule scope selected by the model
${JSON.stringify(semanticScheduleScope)}
When this is non-null, it is the authoritative source/target slice for this request. Describe and act on these records only; target records are context and must not be moved as if they came from the source.

## Retrieved research evidence
${JSON.stringify(researchEvidence)}
Only make research claims supported by these passages. Cite paper_id, chunk_id, and pages when available. If evidence is empty or insufficient, say so.

## Current data (as of ${context.today}):
${contextStr}`;

    // Build Ollama message history: system + conversation
    const ollamaMessages = [
      { role: 'system' as const, content: systemWithContext },
      ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    const raw = await chat(ollamaMessages, { temperature: 0.3, max_tokens: 8192, jsonMode: true });

    const parsed = parseChatEnvelope(raw);
    const scheduleDayView = directDayView;
    const schedulePlanAllowed = schedulePlanRequested;
    const validatedAll = ensurePacedPlanAction(
      normalizeTaskScopedActions(
        coalesceNewGoalStarterTasks(Array.isArray(parsed.actions) ? validateModelActions(parsed.actions) : []),
        context,
        lastUserMessage,
      ),
      context,
      planningMessage,
      schedulePlanAllowed,
    );
    const seriesAction = validatedAll.find(action => action.type === 'create_block_series' && !action.rejected_reason);
    const planAction = !seriesAction && schedulePlanAllowed
      ? validatedAll.find(action => action.type === 'plan_schedule' && !action.rejected_reason)
      : undefined;
    const planOptions = !scheduleDayView && !overdueReply && planAction
      ? await buildPlanOptionsPayload(planningMessage, planAction.params as PlanWindowParams)
      : null;
    const plan = !scheduleDayView && !overdueReply && seriesAction
      ? await buildSeriesPayload(seriesAction.params as unknown as SeriesParams)
      : null;
    const replyText = planOptions
      ? planOptions.advisory ?? 'I made a few visual calendar options. Pick the layout that looks right; nothing changes until you apply one.'
      : scheduleDayView ? formatChatScheduleDayReply(scheduleDayView) : overdueReply ?? parsed.reply;

    // Validate model actions (strict schemas), persist as durable proposals,
    // and return actions carrying their proposal_id so the client applies
    // through the transactional proposal path.
    const guardedActions = (scheduleDayView || overdueReply ? [] : validatedAll)
      .filter(action => action.type !== 'plan_schedule' && action.type !== 'create_block_series');
    const validated = guardedActions.length
      ? await persistActionsAsProposals(guardedActions, 'chat', null)
      : [];

    res.json({
      ...parsed,
      reply: replyText,
      feasibility: overdueReply || scheduleDecision.operation === 'move_existing' ? undefined : parsed.feasibility,
      actions: validated,
      citations,
      semantic: {
        frame: semanticFrame,
        schedule_decision: scheduleDecision,
        tool_plan: toolPlan,
        research_evidence_count: researchEvidence.length,
      },
      ...(plan ? { plan } : {}),
      ...(planOptions ? { plan_options: planOptions } : {}),
      ...(scheduleDayView ? { schedule_day_view: scheduleDayView } : {}),
    });
  } catch (err) {
    const msg = String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch')) {
      return res.status(503).json({
        error: `Cannot reach Ollama at ${process.env.OLLAMA_HOST ?? 'http://localhost:11434'}. Is it running? Model: ${CHAT_MODEL}`,
      });
    }
    res.status(500).json({ error: msg });
  }
});

// POST /api/ai/apply — QUARANTINED direct-mutation path.
// All chat actions now flow through durable proposals
// (POST /api/ai/proposals/:id/apply — transactional, locked, double-apply safe).
// This endpoint stays only as an explicit escape hatch and is disabled unless
// ALLOW_DIRECT_AI_APPLY=true.
router.post('/apply', async (req, res) => {
  if (process.env.ALLOW_DIRECT_AI_APPLY !== 'true') {
    return res.status(410).json({
      error: 'Direct apply is disabled. Apply the durable proposal instead: POST /api/ai/proposals/:id/apply',
    });
  }
  const { type, params } = req.body as { type: string; params: Record<string, unknown> };
  const now = new Date().toISOString();
  const id  = crypto.randomUUID();

  if (type === 'create_task') {
    const { goal_id, parent_task_id, milestone_id, title, due_date, start_date, priority, estimated_minutes, status } = params;
    const { rows: countRows } = await query('SELECT COUNT(*) as c FROM tasks WHERE goal_id=$1', [goal_id ?? null]);
    const count = Number((countRows[0] as Record<string, unknown>).c ?? 0);
    await query(
      `INSERT INTO tasks (id,goal_id,parent_task_id,milestone_id,title,description,status,priority,kind,tags_json,due_date,start_date,estimated_minutes,completed,position,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id, goal_id ?? null, parent_task_id ?? null, milestone_id ?? null, title, '', status ?? 'todo', priority ?? 'medium', 'manual', '[]', due_date ?? null, start_date ?? null, estimated_minutes ?? null, false, count, now, now],
    );
    if (goal_id) {
      await query(
        `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [id + '_edge', goal_id, 'goal', id, 'task', 'contains', '{}', now],
      );
    }
    runInBackground(generateEntitySummary('task', id), 'AI create task summary');
    runInBackground(queueEmbeddingUpsert('task', id), 'AI create task embedding queue');
    return res.json({ id });
  }

  if (type === 'create_goal') {
    const { title, description, deadline, start_date, category } = params;
    await query(
      `INSERT INTO goals (id,title,description,category,status,progress,deadline,start_date,overdue,activity_level,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, title, description ?? '', category ?? 'Work', 'Safe', 0, deadline ?? null, start_date ?? null, false, 1, now, now],
    );
    runInBackground(generateEntitySummary('goal', id), 'AI create goal summary');
    runInBackground(queueEmbeddingUpsert('goal', id), 'AI create goal embedding queue');
    return res.json({ id });
  }

  if (type === 'create_goal_with_tasks') {
    const { title, description, deadline, start_date, category, tasks } = params as {
      title: string;
      description?: string;
      deadline?: string;
      start_date?: string;
      category?: string;
      tasks?: Array<Record<string, unknown>>;
    };
    const taskIds: string[] = [];
    await transaction(async client => {
      await client.query(
        `INSERT INTO goals (id,title,description,category,status,progress,deadline,start_date,overdue,activity_level,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, title, description ?? '', category ?? 'Work', 'Safe', 0, deadline ?? null, start_date ?? null, false, 1, now, now],
      );
      for (const [index, task] of (tasks ?? []).entries()) {
        const taskId = crypto.randomUUID();
        taskIds.push(taskId);
        await client.query(
          `INSERT INTO tasks (id,goal_id,parent_task_id,milestone_id,title,description,status,priority,kind,tags_json,due_date,start_date,estimated_minutes,completed,position,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            taskId,
            id,
            null,
            null,
            task.title,
            '',
            task.status ?? 'todo',
            task.priority ?? 'medium',
            'manual',
            '[]',
            task.due_date ?? null,
            task.start_date ?? start_date ?? null,
            task.estimated_minutes ?? null,
            false,
            index,
            now,
            now,
          ],
        );
        await client.query(
          `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [crypto.randomUUID(), id, 'goal', taskId, 'task', 'contains', '{}', now],
        );
      }
    });
    runInBackground(generateEntitySummary('goal', id), 'AI create goal with tasks summary');
    runInBackground(queueEmbeddingUpsert('goal', id), 'AI create goal with tasks embedding queue');
    for (const taskId of taskIds) {
      runInBackground(generateEntitySummary('task', taskId), 'AI create goal task summary');
      runInBackground(queueEmbeddingUpsert('task', taskId), 'AI create goal task embedding queue');
    }
    return res.json({ id, task_ids: taskIds });
  }

  if (type === 'update_task') {
    const { task_id, ...fields } = params;
    const { rows: existingTasks } = await query('SELECT target_date, hard_deadline FROM tasks WHERE id=$1', [task_id]);
    if (!existingTasks.length) return res.status(404).json({ error: 'Task not found' });
    const updates: Record<string, unknown> = { updated_at: now };
    const allowed = ['due_date','start_date','priority','status','estimated_minutes','milestone_id'];
    for (const k of allowed) {
      if (fields[k] !== undefined) updates[k] = fields[k];
    }
    Object.assign(updates, synchronizedTaskDeadlineUpdates(
      fields,
      existingTasks[0] as Record<string, unknown>,
    ));
    const entries = Object.entries(updates);
    const sets = entries.map(([col], i) => `${col}=$${i + 1}`).join(',');
    const vals = entries.map(([, v]) => v);
    await query(`UPDATE tasks SET ${sets} WHERE id=$${vals.length + 1}`, [...vals, task_id]);
    runInBackground(markEmbeddingStale('task', task_id as string), 'AI update task stale embedding');
    runInBackground(queueEmbeddingUpsert('task', task_id as string), 'AI update task embedding queue');
    return res.json({ ok: true });
  }

  if (type === 'update_goal') {
    const { goal_id, ...fields } = params;
    const updates: Record<string, unknown> = { updated_at: now };
    if (fields.deadline !== undefined) updates.deadline = fields.deadline;
    if (fields.status   !== undefined) updates.status   = fields.status;
    const entries = Object.entries(updates);
    const sets = entries.map(([col], i) => `${col}=$${i + 1}`).join(',');
    const vals = entries.map(([, v]) => v);
    await query(`UPDATE goals SET ${sets} WHERE id=$${vals.length + 1}`, [...vals, goal_id]);
    // Fire side effects after successful update (embedding invalidation + summary refresh)
    runInBackground(generateEntitySummary('goal', goal_id as string), 'AI update goal summary');
    runInBackground(markEmbeddingStale('goal', goal_id as string), 'AI update goal stale embedding');
    runInBackground(queueEmbeddingUpsert('goal', goal_id as string), 'AI update goal embedding queue');
    return res.json({ ok: true });
  }

  if (type === 'create_milestone') {
    const { goal_id, title, description, due_date, color } = params;
    const { rows: countRows } = await query('SELECT COUNT(*) as c FROM goal_milestones WHERE goal_id=$1', [goal_id]);
    const count = Number((countRows[0] as Record<string, unknown>).c ?? 0);
    await query(
      `INSERT INTO goal_milestones (id,goal_id,title,description,due_date,color,position,completed,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, goal_id, title ?? '', description ?? '', due_date ?? null, color ?? '#6366f1', count, false, now, now],
    );
    runInBackground(generateEntitySummary('milestone', id), 'AI create milestone summary');
    return res.json({ id });
  }

  res.status(400).json({ error: `Unknown action type: ${type}` });
});

// GET /api/ai/proposals — pending AI-proposed actions
router.get('/proposals', async (_req, res) => {
  const { rows } = await query(
    `SELECT a.*, je.entry_date AS source_entry_date
     FROM ai_action_proposals a
     LEFT JOIN journal_entries je ON a.source_type='journal_entry' AND a.source_id=je.id
     WHERE a.status='pending'
     ORDER BY a.confidence DESC, a.created_at ASC`,
  );
  res.json(rows);
});

// POST /api/ai/proposals/:id/apply
router.post('/proposals/:id/apply', async (req, res) => {
  const proposalId = req.params.id;
  let actionType = '';
  let actionResult: Record<string, unknown> = {};

  await transaction(async client => {
    // Lock the row first to prevent duplicate-apply races
    const { rows } = await client.query(
      `SELECT * FROM ai_action_proposals WHERE id=$1 FOR UPDATE`,
      [proposalId],
    );
    if (!rows.length) {
      const err = Object.assign(new Error('Proposal not found'), { status: 404 });
      throw err;
    }
    const proposal = rows[0] as Record<string, unknown>;
    if (proposal.status !== 'pending') {
      const err = Object.assign(new Error(`Proposal already ${proposal.status as string}`), { status: 409 });
      throw err;
    }

    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(proposal.action_payload as string ?? '{}'); } catch { /* */ }

    const now = new Date().toISOString();
    const newId = crypto.randomUUID();
    actionType = proposal.action_type as string;

    if (actionType === 'create_task') {
      const { goal_id, parent_task_id, milestone_id, title, due_date, start_date, priority, estimated_minutes, status } = payload;
      const { rows: countRows } = await client.query('SELECT COUNT(*) as c FROM tasks WHERE goal_id=$1', [goal_id ?? null]);
      const count = Number((countRows[0] as Record<string, unknown>).c ?? 0);
      await client.query(
        `INSERT INTO tasks (id,goal_id,parent_task_id,milestone_id,title,description,status,priority,kind,tags_json,due_date,start_date,estimated_minutes,completed,position,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [newId, goal_id ?? null, parent_task_id ?? null, milestone_id ?? null, title, '', status ?? 'todo', priority ?? 'medium', 'manual', '[]', due_date ?? null, start_date ?? null, estimated_minutes ?? null, false, count, now, now],
      );
      actionResult.id = newId;
      actionResult.created_task_id = newId; // for post-commit side effects
    } else if (actionType === 'break_down_task') {
      const { parent_task_id, tasks } = payload as {
        parent_task_id: string;
        tasks: Array<{
          title: string;
          due_date?: string;
          start_date?: string;
          priority?: string;
          estimated_minutes?: number;
        }>;
      };
      const { rows: parentRows } = await client.query<{
        id: string;
        goal_id: string | null;
        milestone_id: string | null;
        due_date: string | null;
      }>(
        `SELECT id, goal_id, milestone_id, due_date
         FROM tasks WHERE id=$1`,
        [parent_task_id],
      );
      if (!parentRows.length) {
        throw Object.assign(new Error('Parent task not found'), { status: 404 });
      }
      const parent = parentRows[0];
      const { rows: countRows } = await client.query(
        'SELECT COUNT(*) as c FROM tasks WHERE parent_task_id=$1',
        [parent_task_id],
      );
      const startPosition = Number((countRows[0] as Record<string, unknown>).c ?? 0);
      const createdTaskIds: string[] = [];

      for (const [index, child] of tasks.entries()) {
        if (child.due_date && parent.due_date && child.due_date > parent.due_date.slice(0, 10)) {
          throw Object.assign(
            new Error(`Child task "${child.title}" cannot be due after its parent (${parent.due_date.slice(0, 10)})`),
            { status: 409 },
          );
        }
        const childId = crypto.randomUUID();
        createdTaskIds.push(childId);
        await client.query(
          `INSERT INTO tasks
            (id,goal_id,parent_task_id,milestone_id,title,description,status,priority,kind,tags_json,
             due_date,start_date,estimated_minutes,completed,position,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,'','todo',$6,'manual','[]',$7,$8,$9,false,$10,$11,$11)`,
          [
            childId,
            parent.goal_id,
            parent_task_id,
            parent.milestone_id,
            child.title,
            child.priority ?? 'medium',
            child.due_date ?? null,
            child.start_date ?? null,
            child.estimated_minutes ?? null,
            startPosition + index,
            now,
          ],
        );
        if (parent.goal_id) {
          await client.query(
            `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
             VALUES ($1,$2,'goal',$3,'task','contains',$4,$5) ON CONFLICT DO NOTHING`,
            [crypto.randomUUID(), parent.goal_id, childId, JSON.stringify({ kind: 'ai_breakdown' }), now],
          );
        }
        await client.query(
          `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
           VALUES ($1,$2,'task',$3,'task','subtask_of',$4,$5) ON CONFLICT DO NOTHING`,
          [crypto.randomUUID(), childId, parent_task_id, JSON.stringify({ origin: 'ai_breakdown' }), now],
        );
      }
      actionResult.id = parent_task_id;
      actionResult.created_task_ids = createdTaskIds;
    } else if (actionType === 'update_task') {
      const { task_id, ...fields } = payload;
      const { rows: existingTasks } = await client.query(
        'SELECT target_date, hard_deadline FROM tasks WHERE id=$1 FOR UPDATE',
        [task_id],
      );
      if (!existingTasks.length) throw Object.assign(new Error('Task not found'), { status: 404 });
      const updates: Record<string, unknown> = { updated_at: now };
      const allowed = ['due_date', 'start_date', 'priority', 'status', 'estimated_minutes', 'milestone_id'];
      for (const k of allowed) { if (fields[k] !== undefined) updates[k] = fields[k]; }
      Object.assign(updates, synchronizedTaskDeadlineUpdates(
        fields,
        existingTasks[0] as Record<string, unknown>,
      ));
      const entries = Object.entries(updates);
      const sets = entries.map(([col], i) => `${col}=$${i + 1}`).join(',');
      const vals = entries.map(([, v]) => v);
      await client.query(`UPDATE tasks SET ${sets} WHERE id=$${vals.length + 1}`, [...vals, task_id]);
      actionResult.updated_task_id = task_id; // for post-commit side effects
    } else if (actionType === 'move_schedule_items') {
      const { source_date, target_date, entity_types, preserve_event_times } = payload as {
        source_date: string;
        target_date: string;
        entity_types: Array<'tasks' | 'deadlines' | 'events'>;
        preserve_event_times: true;
      };
      if (!preserve_event_times || source_date === target_date) {
        throw Object.assign(new Error('Invalid semantic move request'), { status: 400 });
      }
      const selected = new Set(entity_types);
      let movedEvents = 0;
      let lockedEvents = 0;
      let movedTaskStarts = 0;
      let movedTaskDeadlines = 0;

      if (selected.has('events')) {
        const { rows: eventRows } = await client.query(
          `SELECT id, week_start, day_index, locked FROM events WHERE week_start IS NOT NULL FOR UPDATE`,
        );
        const sourceEvents = (eventRows as Array<{ id: string; week_start: string; day_index: number; locked: boolean }>)
          .filter(event => eventDateServer(event.week_start, Number(event.day_index ?? 0)) === source_date);
        const movableIds = sourceEvents.filter(event => !event.locked).map(event => event.id);
        lockedEvents = sourceEvents.length - movableIds.length;
        if (movableIds.length) {
          const target = dateToWeekPosServer(target_date);
          const result = await client.query(
            `UPDATE events SET week_start=$1, day_index=$2, updated_at=$3 WHERE id = ANY($4)`,
            [target.week_start, target.day_index, now, movableIds],
          );
          movedEvents = result.rowCount ?? 0;
        }
      }

      if (selected.has('tasks')) {
        const result = await client.query(
          `UPDATE tasks SET start_date=$1, updated_at=$2
           WHERE completed=false AND start_date=$3`,
          [target_date, now, source_date],
        );
        movedTaskStarts = result.rowCount ?? 0;
      }

      if (selected.has('deadlines')) {
        const result = await client.query(
          `UPDATE tasks
           SET due_date=CASE WHEN due_date=$1 THEN $2 ELSE due_date END,
               target_date=CASE WHEN target_date=$1 THEN $2 ELSE target_date END,
               hard_deadline=CASE WHEN hard_deadline=$1 THEN $2 ELSE hard_deadline END,
               updated_at=$3
           WHERE completed=false AND (due_date=$1 OR target_date=$1 OR hard_deadline=$1)`,
          [source_date, target_date, now],
        );
        movedTaskDeadlines = result.rowCount ?? 0;
      }

      actionResult = {
        source_date,
        target_date,
        moved_events: movedEvents,
        locked_events_unchanged: lockedEvents,
        moved_task_start_dates: movedTaskStarts,
        moved_task_deadlines: movedTaskDeadlines,
      };
    } else if (actionType === 'create_goal') {
      const { title, description, deadline, start_date, category } = payload;
      await client.query(
        `INSERT INTO goals (id,title,description,category,status,progress,deadline,start_date,overdue,activity_level,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [newId, title, description ?? '', category ?? 'Work', 'Safe', 0, deadline ?? null, start_date ?? null, false, 1, now, now],
      );
      actionResult.id = newId;
      actionResult.created_goal_id = newId; // for post-commit side effects
    } else if (actionType === 'create_goal_with_tasks') {
      const { title, description, deadline, start_date, category, tasks } = payload as {
        title: string;
        description?: string;
        deadline?: string;
        start_date?: string;
        category?: string;
        tasks?: Array<Record<string, unknown>>;
      };
      const createdTaskIds: string[] = [];
      await client.query(
        `INSERT INTO goals (id,title,description,category,status,progress,deadline,start_date,overdue,activity_level,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [newId, title, description ?? '', category ?? 'Work', 'Safe', 0, deadline ?? null, start_date ?? null, false, 1, now, now],
      );
      for (const [index, task] of (tasks ?? []).entries()) {
        const taskId = crypto.randomUUID();
        createdTaskIds.push(taskId);
        await client.query(
          `INSERT INTO tasks (id,goal_id,parent_task_id,milestone_id,title,description,status,priority,kind,tags_json,due_date,start_date,estimated_minutes,completed,position,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            taskId,
            newId,
            null,
            null,
            task.title,
            '',
            task.status ?? 'todo',
            task.priority ?? 'medium',
            'manual',
            '[]',
            task.due_date ?? null,
            task.start_date ?? start_date ?? null,
            task.estimated_minutes ?? null,
            false,
            index,
            now,
            now,
          ],
        );
        await client.query(
          `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [crypto.randomUUID(), newId, 'goal', taskId, 'task', 'contains', '{}', now],
        );
      }
      actionResult.id = newId;
      actionResult.created_goal_id = newId;
      actionResult.created_task_ids = createdTaskIds;
    } else if (actionType === 'update_goal') {
      const { goal_id, ...fields } = payload;
      const updates: Record<string, unknown> = { updated_at: now };
      if (fields.deadline !== undefined) updates.deadline = fields.deadline;
      if (fields.status   !== undefined) updates.status   = fields.status;
      const entries = Object.entries(updates);
      const sets = entries.map(([col], i) => `${col}=$${i + 1}`).join(',');
      const vals = entries.map(([, v]) => v);
      await client.query(`UPDATE goals SET ${sets} WHERE id=$${vals.length + 1}`, [...vals, goal_id]);
      // Store goal_id so post-commit side effects can be triggered after the transaction
      actionResult.updated_goal_id = goal_id;
    } else if (actionType === 'create_milestone') {
      const { goal_id, title, description, due_date, color } = payload;
      const { rows: countRows } = await client.query('SELECT COUNT(*) as c FROM goal_milestones WHERE goal_id=$1', [goal_id]);
      const count = Number((countRows[0] as Record<string, unknown>).c ?? 0);
      await client.query(
        `INSERT INTO goal_milestones (id,goal_id,title,description,due_date,color,position,completed,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [newId, goal_id, title ?? '', description ?? '', due_date ?? null, color ?? '#6366f1', count, false, now, now],
      );
      actionResult.id = newId;
      actionResult.created_milestone_id = newId; // for post-commit summary generation
    } else if (actionType === 'attach_resource') {
      const { resource_id, target_type, target_id } = payload as { resource_id: string; target_type: string; target_id: string };
      // Both endpoints must exist — an attach to a hallucinated id must fail loudly
      const { rows: resRows } = await client.query('SELECT id, title FROM resources WHERE id=$1', [resource_id]);
      if (!resRows.length) throw Object.assign(new Error('Resource not found'), { status: 404 });
      const targetTable = target_type === 'goal' ? 'goals' : target_type === 'task' ? 'tasks' : 'goal_milestones';
      const { rows: tgtRows } = await client.query(`SELECT id FROM ${targetTable} WHERE id=$1`, [target_id]);
      if (!tgtRows.length) throw Object.assign(new Error(`${target_type} not found`), { status: 404 });
      await client.query(
        `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
         VALUES ($1,$2,'resource',$3,$4,'attached_to','{}',$5) ON CONFLICT DO NOTHING`,
        [crypto.randomUUID(), resource_id, target_id, target_type, now],
      );
      actionResult.attached_resource_id = resource_id;
      actionResult.attached_to = `${target_type}:${target_id}`;
    } else {
      const err = Object.assign(new Error(`Unknown action type: ${actionType}`), { status: 400 });
      throw err;
    }

    // Transition proposal to applied in same transaction — prevents double-apply
    await client.query(
      `UPDATE ai_action_proposals SET status='applied', applied_at=$1 WHERE id=$2`,
      [now, proposalId],
    );
  });

  // Post-commit side effects: run after the transaction so they're never rolled back with it.
  // We fire-and-forget so the response is immediate, but these always execute after commit.
  if (actionResult.created_task_id) {
    const tid = actionResult.created_task_id as string;
    runInBackground(generateEntitySummary('task', tid), 'proposal create task summary');
    runInBackground(queueEmbeddingUpsert('task', tid), 'proposal create task embedding queue');
    delete actionResult.created_task_id;
  }
  if (Array.isArray(actionResult.created_task_ids)) {
    for (const tid of actionResult.created_task_ids as string[]) {
      runInBackground(generateEntitySummary('task', tid), 'proposal create goal task summary');
      runInBackground(queueEmbeddingUpsert('task', tid), 'proposal create goal task embedding queue');
    }
    delete actionResult.created_task_ids;
  }
  if (actionResult.updated_task_id) {
    const tid = actionResult.updated_task_id as string;
    runInBackground(markEmbeddingStale('task', tid), 'proposal update task stale embedding');
    runInBackground(queueEmbeddingUpsert('task', tid), 'proposal update task embedding queue');
    delete actionResult.updated_task_id;
  }
  if (actionResult.created_goal_id) {
    const gid = actionResult.created_goal_id as string;
    runInBackground(generateEntitySummary('goal', gid), 'proposal create goal summary');
    runInBackground(queueEmbeddingUpsert('goal', gid), 'proposal create goal embedding queue');
    delete actionResult.created_goal_id;
  }
  if (actionResult.updated_goal_id) {
    const gid = actionResult.updated_goal_id as string;
    runInBackground(generateEntitySummary('goal', gid), 'proposal update goal summary');
    runInBackground(markEmbeddingStale('goal', gid), 'proposal update goal stale embedding');
    runInBackground(queueEmbeddingUpsert('goal', gid), 'proposal update goal embedding queue');
    delete actionResult.updated_goal_id;
  }
  if (actionResult.created_milestone_id) {
    const mid = actionResult.created_milestone_id as string;
    runInBackground(generateEntitySummary('milestone', mid), 'proposal create milestone summary');
    delete actionResult.created_milestone_id;
  }

  res.json({ ok: true, action_type: actionType, ...actionResult });
});

// POST /api/ai/proposals/:id/reject — only pending proposals may be rejected
router.post('/proposals/:id/reject', async (req, res) => {
  await transaction(async client => {
    const { rows } = await client.query(
      `SELECT status FROM ai_action_proposals WHERE id=$1 FOR UPDATE`,
      [req.params.id],
    );
    if (!rows.length) {
      throw Object.assign(new Error('Proposal not found'), { status: 404 });
    }
    const { status } = rows[0] as { status: string };
    if (status !== 'pending') {
      throw Object.assign(new Error(`Cannot reject a proposal with status '${status}'`), { status: 409 });
    }
    await client.query(
      `UPDATE ai_action_proposals SET status='rejected' WHERE id=$1`,
      [req.params.id],
    );
  });
  res.json({ ok: true });
});

// GET /api/ai/schedule-preview — next 35 days with tasks, meetings, proposals, scheduler result
router.get('/schedule-preview', async (req, res) => {
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
       FROM tasks WHERE completed=false ORDER BY due_date ASC NULLS LAST`,
    ),
    query(
      `SELECT id, title, goal_id, scheduled_at, duration_minutes, location
       FROM meetings WHERE DATE(scheduled_at::timestamp) BETWEEN $1 AND $2 ORDER BY scheduled_at ASC`,
      [displayFromStr, displayToStr],
    ),
    query(
      `SELECT dl.id, dl.goal_id, dl.date, dl.title, dl.color, g.title as goal_title
       FROM goal_deadlines dl
       LEFT JOIN goals g ON g.id = dl.goal_id
       WHERE dl.date BETWEEN $1 AND $2
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
       WHERE t.completed = false
         AND COALESCE(t.scheduling_enabled, true) = true
         AND COALESCE(g.scheduling_enabled, true) = true
         AND COALESCE(gm.scheduling_enabled, true) = true
         AND t.kind <> 'critical_path'
         AND NOT EXISTS (
           SELECT 1 FROM tasks child
           WHERE child.parent_task_id = t.id
             AND child.completed = false
         )
       GROUP BY t.id, t.title, t.goal_id, g.title, t.milestone_id, t.parent_task_id,
                t.estimated_minutes, t.start_date, t.due_date, t.target_date, t.hard_deadline, t.priority`,
    ),
    query(
      `SELECT source_id as blocker_id, target_id as task_id
       FROM edges WHERE relationship='blocks' AND source_type='task' AND target_type='task'`,
    ),
    query(
      `SELECT id, parent_task_id, goal_id, milestone_id, start_date, due_date, target_date, hard_deadline
       FROM tasks WHERE completed=false`,
    ),
    query(`SELECT id, start_date, target_date, hard_deadline, deadline FROM goals`),
    query(`SELECT id, start_date, due_date, hard_deadline FROM goal_milestones`),
    query(
      `SELECT id, title, goal_id, scheduled_at, duration_minutes, location
       FROM meetings WHERE DATE(scheduled_at::timestamp) BETWEEN $1 AND $2 ORDER BY scheduled_at ASC`,
      [todayStr, schedulerEndStr],
    ),
    query(`SELECT date, available_minutes, note FROM schedule_day_overrides WHERE date BETWEEN $1 AND $2`, [todayStr, schedulerEndStr]),
    query(
      `SELECT etl.task_id,
              COALESCE(SUM(COALESCE(etl.planned_minutes, ROUND(e.duration_hours * 60))), 0)::int AS planned_minutes
       FROM event_task_links etl
       JOIN events e ON e.id = etl.event_id
       WHERE (e.week_start::date + e.day_index) BETWEEN $1::date AND $2::date
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
     FROM events WHERE week_start IS NOT NULL
       AND duration_hours > 0
       AND week_start BETWEEN $1 AND $2`,
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
    (taskDeadlineRows as TaskDeadlineRow[]).map(row => [row.id, row.parent_task_id]),
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
  for (const p of proposals) {
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

// POST /api/ai/schedule/propose — turn the deterministic scheduler's current
// day assignments into durable update_task proposals (start_date). The
// schedule is NEVER auto-applied: the user previews and confirms each
// proposal through the standard transactional proposal apply path.
router.post('/schedule/propose', async (req, res) => {
  const horizonDays = Math.min(Math.max(1, Number((req.body as Record<string, unknown>)?.horizon_days ?? 7)), 35);
  const inp = await loadSchedulerInputs(horizonDays);
  const todayStr = inp.todayStr;

  const schedulerResult = computeSchedule({
    start_date: todayStr,
    tasks: inp.tasks,
    meetings: inp.meetings,
    prefs: inp.prefs,
    overrides: inp.overrides,
    horizon_days: horizonDays,
  });

  // First assigned day per task = proposed start_date
  const firstDayByTask = new Map<string, string>();
  for (const day of schedulerResult.day_assignments) {
    for (const tid of day.task_ids) {
      if (!firstDayByTask.has(tid)) firstDayByTask.set(tid, day.date);
    }
  }

  const taskById = inp.taskById;
  const now = new Date().toISOString();

  // Re-proposing replaces prior pending scheduler proposals instead of accumulating.
  await query(`DELETE FROM ai_action_proposals WHERE source_type='scheduler' AND status='pending'`);

  const created: Array<Record<string, unknown>> = [];
  for (const [taskId, startDate] of firstDayByTask) {
    const task = taskById.get(taskId);
    if (!task) continue;
    // No-op moves are noise — only propose when the start date actually changes.
    if ((task.start_date as string | null) === startDate) continue;
    const assignedDays = schedulerResult.day_assignments.filter(d => d.task_ids.includes(taskId)).map(d => d.date);
    const payload = { task_id: taskId, start_date: startDate };
    const payloadStr = JSON.stringify(payload);
    const idemKey = crypto.createHash('sha256').update(`update_task\0${payloadStr}`).digest('hex');
    const explanation =
      `Scheduler: start "${task.title}" on ${startDate}` +
      (assignedDays.length > 1 ? ` (split across ${assignedDays.length} days: ${assignedDays.join(', ')})` : '') +
      (task.due_date ? ` to meet its ${task.due_date} deadline` : '') +
      `. Previous start: ${(task.start_date as string | null) ?? 'none'}.`;
    const { rows: inserted } = await query(
      `INSERT INTO ai_action_proposals (id, action_type, action_payload, explanation, confidence, status, source_type, source_id, created_at, idempotency_key)
       VALUES ($1,'update_task',$2,$3,0.9,'pending','scheduler',NULL,$4,$5)
       ON CONFLICT (action_type, idempotency_key) WHERE status='pending' AND idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [crypto.randomUUID(), payloadStr, explanation, now, idemKey],
    );
    if (inserted.length) {
      created.push({
        proposal_id: (inserted[0] as { id: string }).id,
        task_id: taskId,
        title: task.title,
        before: { start_date: (task.start_date as string | null) ?? null },
        after: { start_date: startDate },
        assigned_days: assignedDays,
        explanation,
      });
    }
  }

  res.json({
    ok: true,
    scheduler_result: {
      status: schedulerResult.status,
      gap_minutes: schedulerResult.gap_minutes,
      unestimated_task_ids: schedulerResult.unestimated_task_ids,
      tasks_overflow: schedulerResult.tasks_overflow,
      impossible_reason: schedulerResult.impossible_reason ?? null,
    },
    not_schedulable: inp.notSchedulable,
    proposals_created: created.length,
    proposals: created,
  });
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
           WHERE DATE(scheduled_at::timestamp) BETWEEN $1 AND ($1::date + 14)::text ORDER BY scheduled_at LIMIT 20`, [todayStr]),
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
       LEFT JOIN tasks child ON child.parent_task_id = t.id AND child.completed = false
       WHERE t.completed = false
       GROUP BY t.id, t.title, t.goal_id, g.title, t.milestone_id, t.parent_task_id,
                t.estimated_minutes, t.due_date, t.start_date, t.priority,
                t.kind, t.target_date, t.hard_deadline, t.scheduling_enabled,
                g.scheduling_enabled, gm.scheduling_enabled`,
    ),
    query(`SELECT scheduled_at, duration_minutes FROM meetings WHERE DATE(scheduled_at::timestamp) BETWEEN $1 AND $2`, [todayStr, endStr]),
    query(`SELECT date, available_minutes FROM schedule_day_overrides WHERE date BETWEEN $1 AND $2`, [todayStr, endStr]),
    query(`SELECT source_id as blocker_id, target_id as task_id FROM edges WHERE relationship='blocks' AND source_type='task' AND target_type='task'`),
    query(
      `SELECT id, parent_task_id, goal_id, milestone_id, start_date, due_date, target_date, hard_deadline
       FROM tasks WHERE completed=false`,
    ),
    query(`SELECT id, start_date, target_date, hard_deadline, deadline FROM goals`),
    query(`SELECT id, start_date, due_date, hard_deadline FROM goal_milestones`),
    query(
      `SELECT etl.task_id,
              COALESCE(SUM(COALESCE(etl.planned_minutes, ROUND(e.duration_hours * 60))), 0)::int AS planned_minutes
       FROM event_task_links etl
       JOIN events e ON e.id = etl.event_id
       WHERE (e.week_start::date + e.day_index) BETWEEN $1::date AND $2::date
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

  // THE SCHEDULING GATE: Amina manages a task's time only when ALL hold —
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
       WHERE DATE(scheduled_at::timestamp) BETWEEN $1 AND $2`,
      [fromStr, toStr],
    ),
    query(`SELECT id, title, day_index, start_hour, duration_hours, week_start FROM events WHERE week_start IS NOT NULL`),
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
    query(`SELECT id, goal_id FROM tasks WHERE id = ANY($1)`, [ids]),
    query(`SELECT goal_id, actual_minutes FROM tasks WHERE completed = true AND actual_minutes IS NOT NULL ORDER BY updated_at DESC LIMIT 500`),
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
  const nowClock = new Date();
  const window = resolvePlanWindow(windowParams, fmtYMD(nowClock), nowClock.getHours() + nowClock.getMinutes() / 60);

  // Scheduler inputs must span from today THROUGH the window's end (its
  // queries anchor at today); the schedule itself starts at the window start.
  const daysFromToday = Math.max(
    1,
    Math.round((new Date(window.to + 'T00:00:00').getTime() - new Date(fmtYMD(nowClock) + 'T00:00:00').getTime()) / 86_400_000) + 1,
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
  const uncappedPlanTasks = inp.tasks.flatMap(task => {
    if (!task.due_date) return [];
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
      && (!windowParams.task_id || task.id === windowParams.task_id)
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
    needs_estimate: await loadEstimateTriage(inp.notSchedulable),
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

const PLAN_FOLLOWUP_PATTERN = /\b(show\s+me\s+how|show\s+how|show\s+it|what\s+would\s+that\s+look|how\s+would\s+that\s+look|calendar\s+view|different\s+plans?|options?)\b/i;

function resolvePlanningRequestMessage(current: string | null | undefined, messages: ChatMessage[]): string | null {
  if (hasExplicitSchedulePlanIntent(current)) {
    const explicitTimes = current ? [...current.matchAll(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi)].length : 0;
    if (current && /\b(them|those|these|it)\b/i.test(current) && explicitTimes < 2) {
      for (let i = messages.length - 2; i >= 0; i -= 1) {
        const message = messages[i];
        if (message.role === 'user' && hasExplicitSchedulePlanIntent(message.content)) {
          return `${message.content}\nFollow-up: ${current}`;
        }
      }
    }
    return current ?? null;
  }
  if (!current || !PLAN_FOLLOWUP_PATTERN.test(current)) return current ?? null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'user' && hasExplicitSchedulePlanIntent(message.content)) return message.content;
  }
  return current;
}

const PLAN_WEEKDAY_PATTERNS: Array<{ index: number; pattern: RegExp }> = [
  { index: 0, pattern: /\b(sunday|sun)\b/i },
  { index: 1, pattern: /\b(monday|mon)\b/i },
  { index: 2, pattern: /\b(tuesday|tues|tue|teus\w*|tueds\w*)\b/i },
  { index: 3, pattern: /\b(wednesday|wed)\b/i },
  { index: 4, pattern: /\b(thursday|thurs?|thur|thirs\w*)\b/i },
  { index: 5, pattern: /\b(friday|fri)\b/i },
  { index: 6, pattern: /\b(saturday|sat)\b/i },
];

const PLAN_MONTH_INDEX: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9,
  october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/** Resolve conversational dates such as "Aug 30" without asking the model. */
function namedCalendarDates(text: string, today: string): string[] {
  const results: string[] = [];
  const pattern = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi;
  const todayDate = new Date(today + 'T00:00:00');
  for (const match of text.matchAll(pattern)) {
    const month = PLAN_MONTH_INDEX[match[1].toLowerCase()];
    const day = Number(match[2]);
    let year = match[3] ? Number(match[3]) : todayDate.getFullYear();
    let candidate = new Date(year, month, day);
    if (!match[3] && candidate < todayDate) {
      year += 1;
      candidate = new Date(year, month, day);
    }
    if (candidate.getFullYear() !== year || candidate.getMonth() !== month || candidate.getDate() !== day) continue;
    results.push(fmtYMD(candidate));
  }
  return results;
}

function weekdayDateFromToday(index: number, today: string): string {
  const todayIndex = new Date(today + 'T00:00:00').getDay();
  return addDaysStr(today, (index - todayIndex + 7) % 7);
}

function previousOrTodayWeekdayDate(index: number, today: string): string {
  const todayIndex = new Date(today + 'T00:00:00').getDay();
  return addDaysStr(today, -((todayIndex - index + 7) % 7));
}

function inferTimeWindowFromMessage(message: string | null | undefined): Pick<PlanWindowParams, 'start_hour' | 'end_hour'> {
  const text = (message ?? '').toLowerCase();
  const match = text.match(/\b(?:around|at|starting(?:\s+at)?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (!match) return {};
  let hour = Number(match[1]) % 12;
  if (match[3] === 'pm') hour += 12;
  const start = hour + Number(match[2] ?? 0) / 60;
  const durationMatch = text.match(/\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\b/);
  const duration = durationMatch ? Math.min(16, Math.max(0.5, Number(durationMatch[1]))) : 1;
  return { start_hour: start, end_hour: Math.min(24, start + duration) };
}

function inferMaxDailyMinutes(message: string | null | undefined): number | undefined {
  const text = (message ?? '').toLowerCase();
  const minutes = text.match(/\b(\d+)\s*(?:m|min|mins|minutes?)\s+(?:a|per)\s+(?:day|weekday)\b/);
  if (minutes) return Math.min(960, Math.max(15, Number(minutes[1])));
  const hours = text.match(/\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\s+(?:a|per)\s+(?:day|weekday)\b/);
  if (hours) return Math.min(960, Math.max(15, Math.round(Number(hours[1]) * 60)));
  return undefined;
}

function requestsCalendarDailyCadence(message: string | null | undefined): boolean {
  const text = (message ?? '').toLowerCase();
  if (!inferMaxDailyMinutes(message) || /\bweekday(?:s)?\b/.test(text)) return false;
  return /\b(?:every|each)\s+day\b/.test(text)
    || /\b(?:the\s+)?(?:whole|entire)\s+month\b/.test(text)
    || /\ball\s+month\b/.test(text);
}

function weekdayMentions(text: string, today: string) {
  const mentions: Array<{ index: number; date: string; at: number }> = [];
  for (const weekday of PLAN_WEEKDAY_PATTERNS) {
    const match = weekday.pattern.exec(text);
    if (match?.index !== undefined) {
      mentions.push({ index: weekday.index, date: weekdayDateFromToday(weekday.index, today), at: match.index });
    }
  }
  return mentions.sort((a, b) => a.at - b.at);
}

function inferPlanWindowFromMessage(message: string | null | undefined, today: string): {
  params: PlanWindowParams;
  sourceDate?: string;
} {
  const text = (message ?? '').toLowerCase();
  const isoDates = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match => match[0]);
  if (isoDates.length >= 2) {
    const moveLike = /\b(move|reschedule|shift|push|transfer)\b/.test(text);
    return {
      params: { from_date: isoDates[moveLike && isoDates.length >= 3 ? 1 : 0], to_date: isoDates.at(-1) },
      ...(moveLike ? { sourceDate: isoDates[0] } : {}),
    };
  }
  if (isoDates.length === 1) return { params: { from_date: isoDates[0], to_date: isoDates[0] } };

  const namedDates = namedCalendarDates(text, today);
  if (namedDates.length >= 2) {
    return { params: { from_date: namedDates[0], to_date: namedDates.at(-1)! } };
  }
  if (namedDates.length === 1) {
    const pacedRange = Boolean(inferMaxDailyMinutes(message))
      || /\b(?:through|until|over\s+the\s+(?:whole\s+)?month|from\s+now)\b/.test(text);
    return pacedRange
      ? { params: { from_date: today, to_date: namedDates[0] } }
      : { params: { from_date: namedDates[0], to_date: namedDates[0] } };
  }

  const mentions = weekdayMentions(text, today);
  const moveLike = /\b(move|reschedule|shift|push|transfer)\b/.test(text);
  if (moveLike && mentions.length >= 2) {
    const targets = mentions.slice(1);
    return {
      params: { from_date: targets[0].date, to_date: targets.at(-1)!.date },
      sourceDate: previousOrTodayWeekdayDate(mentions[0].index, today),
    };
  }
  if (mentions.length >= 2) {
    return { params: { from_date: mentions[0].date, to_date: mentions.at(-1)!.date } };
  }
  if (mentions.length === 1) {
    return { params: { from_date: mentions[0].date, to_date: mentions[0].date } };
  }
  if (/\b(tomorrow|tmrw|tmr)\b/.test(text)) {
    const tomorrow = addDaysStr(today, 1);
    return { params: { from_date: tomorrow, to_date: tomorrow } };
  }
  if (/\btoday\b/.test(text)) return { params: { from_date: today, to_date: today } };
  if (/\bweek\b/.test(text)) return { params: { from_date: today, to_date: addDaysStr(today, 6) } };
  return { params: { from_date: today, to_date: addDaysStr(today, 13) } };
}

async function applyExplicitBatchDueDate(message: string | null | undefined): Promise<{ date: string; tasks: string[] } | null> {
  const text = (message ?? '').toLowerCase();
  // A compound estimate/routine/deadline instruction must reach the action
  // model as one coherent turn; consuming just its deadline would silently
  // drop the rest of the user's command.
  if (hasEstimateOrRoutineIntent(text)) return null;
  // Merely mentioning a deadline while asking to move/schedule work must never
  // mutate that deadline. Require an explicit assignment phrase such as
  // "change the due date to Saturday" or "set deadline on Friday".
  const explicitDeadlineAssignment = /\b(?:due\s*dates?|deadline)\b[^.!?\n]{0,80}\b(?:to|on)\b/.test(text);
  if (!/\b(move|change|set|update|push|reschedule)\b/.test(text) || !explicitDeadlineAssignment) return null;
  const today = fmtYMD(new Date());
  const weekday = PLAN_WEEKDAY_PATTERNS.find(item => item.pattern.test(text));
  const namedDate = namedCalendarDates(text, today).at(-1) ?? null;
  const date = /\btomorrow\b/.test(text)
    ? addDaysStr(today, 1)
    : namedDate ?? (weekday ? weekdayDateFromToday(weekday.index, today) : null);
  if (!date) return null;

  const { rows } = await query<{ id: string; title: string; goal_title: string | null }>(
    `SELECT t.id, t.title, g.title AS goal_title FROM tasks t LEFT JOIN goals g ON g.id=t.goal_id WHERE t.completed=false`,
  );
  const normalized = text.replace(/[^a-z0-9]+/g, ' ').trim();
  const matchedIds = new Set(findExplicitTaskMatches(message, rows));
  const named = rows.filter(task => matchedIds.has(task.id));
  const goal = rows
    .filter(task => task.goal_title && normalized.includes(task.goal_title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()))
    .sort((a, b) => (b.goal_title?.length ?? 0) - (a.goal_title?.length ?? 0))[0]?.goal_title;
  const selected = named.length
    ? named
    : goal && /\b(all|every)\b/.test(text)
      ? rows.filter(task => task.goal_title === goal)
      : [];
  if (!selected.length) return null;
  const rootIds = [...new Set(selected.map(task => task.id))];
  // A named parent is a task river/container. Moving only that row leaves its
  // executable descendants on stale deadlines, which makes day/overdue views
  // contradict the user's command. Keep the whole named subtree coherent.
  const { rows: subtreeRows } = await query<{ id: string; title: string }>(
    `WITH RECURSIVE task_subtree AS (
       SELECT id, title FROM tasks WHERE id = ANY($1) AND completed=false
       UNION
       SELECT child.id, child.title
       FROM tasks child
       JOIN task_subtree parent ON child.parent_task_id = parent.id
       WHERE child.completed=false
     )
     SELECT id, title FROM task_subtree`,
    [rootIds],
  );
  const ids = [...new Set(subtreeRows.map(task => task.id))];
  const now = new Date().toISOString();
  await query(
    `UPDATE tasks
     SET due_date=$1,
         target_date=$1,
         hard_deadline=CASE WHEN hard_deadline IS NULL THEN NULL ELSE $1 END,
         updated_at=$2
     WHERE id = ANY($3)`,
    [date, now, ids],
  );
  return { date, tasks: subtreeRows.map(task => task.title) };
}

async function loadTaskIdsScheduledOnDate(date: string): Promise<Set<string>> {
  const [{ rows: linkedRows }, { rows: startRows }] = await Promise.all([
    query(
      `SELECT etl.task_id, e.week_start, e.day_index
       FROM event_task_links etl
       JOIN events e ON e.id = etl.event_id
       JOIN tasks t ON t.id = etl.task_id
       WHERE t.completed = false AND e.week_start IS NOT NULL`,
    ),
    query(`SELECT id FROM tasks WHERE completed = false AND start_date = $1`, [date]),
  ]);
  const ids = new Set<string>();
  for (const row of linkedRows as Array<{ task_id: string; week_start: string; day_index: number }>) {
    if (eventDateServer(row.week_start, Number(row.day_index ?? 0)) === date) ids.add(row.task_id);
  }
  for (const row of startRows as Array<{ id: string }>) ids.add(row.id);
  return ids;
}

async function buildPlanOptionsPayload(message: string | null | undefined, explicitParams?: PlanWindowParams) {
  const nowClock = new Date();
  const today = fmtYMD(nowClock);
  const inferred = inferPlanWindowFromMessage(message, today);
  const inferredHours = inferTimeWindowFromMessage(message);
  const userDefinesPacedRange = Boolean(
    inferMaxDailyMinutes(message)
    && namedCalendarDates((message ?? '').toLowerCase(), today).length,
  );
  const mergedParams = inferred.sourceDate || userDefinesPacedRange
    ? {
      ...inferredHours,
      ...(explicitParams ?? {}),
      from_date: inferred.params.from_date,
      to_date: inferred.params.to_date,
    }
    : { ...inferred.params, ...inferredHours, ...(explicitParams ?? {}) };
  const window = resolvePlanWindow(mergedParams, today, nowClock.getHours() + nowClock.getMinutes() / 60);
  const horizonDays = Math.max(
    1,
    Math.round((new Date(window.to + 'T00:00:00').getTime() - new Date(window.from + 'T00:00:00').getTime()) / 86_400_000) + 1,
  );
  const daysFromToday = Math.max(
    1,
    Math.round((new Date(window.to + 'T00:00:00').getTime() - new Date(today + 'T00:00:00').getTime()) / 86_400_000) + 1,
  );
  const inp = await loadSchedulerInputs(Math.min(Math.max(daysFromToday, horizonDays), 90));
  const rawText = (message ?? '').toLowerCase();
  const explicitTimeCount = [...rawText.matchAll(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/g)].length;
  const explicitDurationCount = [...rawText.matchAll(/\b\d+(?:\.\d+)?\s*(?:h|hr|hrs|hours|min|mins|minutes)\b/g)].length;
  const requestedDailyCap = inferMaxDailyMinutes(message) ?? mergedParams.max_daily_minutes;
  // A cadence such as "2 hours a day" is a distribution constraint, not an
  // instruction to create one block whose length is the task's total estimate.
  // Let the scheduler spread that work across the full requested window.
  if (!requestedDailyCap && (explicitTimeCount >= 1 || explicitDurationCount >= 1)) {
    const allRows = [...inp.taskById.values()];
    const normalized = rawText.replace(/[^a-z0-9]+/g, ' ').trim();
    const namedRows = allRows
      .filter(row => {
        const title = String(row.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        return title.length >= 4 && normalized.includes(title);
      })
      .sort((a, b) => rawText.indexOf(String(a.title).toLowerCase()) - rawText.indexOf(String(b.title).toLowerCase()));
    if (namedRows.length >= 1) {
      const namedIds = new Set(namedRows.map(row => String(row.id)));
      // If both a river/container and its named children appear, place the
      // explicitly named leaves. Drop only duplicate ancestors—not sibling
      // tasks. This preserves commands that name two or more subtasks.
      const namedAncestorIds = new Set<string>();
      for (const row of namedRows) {
        let parentId = row.parent_task_id ? String(row.parent_task_id) : null;
        const seen = new Set<string>();
        while (parentId && !seen.has(parentId)) {
          seen.add(parentId);
          if (namedIds.has(parentId)) namedAncestorIds.add(parentId);
          const parent = inp.taskById.get(parentId);
          parentId = parent?.parent_task_id ? String(parent.parent_task_id) : null;
        }
      }
      const placementRows = namedRows.filter(row => !namedAncestorIds.has(String(row.id)));
      const weekdayMatches = weekdayMentions(rawText, today);
      const targetDate = /\btoday\b/.test(rawText)
        ? today
        : /\btomorrow\b/.test(rawText)
          ? addDaysStr(today, 1)
          : weekdayMatches.at(-1)?.date ?? window.from;
      const { rows: exactPrefsRows } = await query("SELECT work_start, work_end FROM user_schedule_prefs WHERE id='default'");
      const exactPrefs = (exactPrefsRows[0] ?? { work_start: 9, work_end: 18 }) as Record<string, unknown>;
      const rawMinutes = rawText.match(/\b(\d+)\s*(?:min|mins|minutes)\b/);
      const rawHours = rawText.match(/\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours)\b/);
      const totalRequestedMinutes = rawMinutes ? Number(rawMinutes[1]) : rawHours ? Math.round(Number(rawHours[1]) * 60) : null;
      const inferredById = new Map(placementRows.map(row => {
        const descendantMinutes = allRows
          .filter(candidate => candidate.parent_task_id === row.id && !(candidate.child_count as number))
          .reduce((sum, candidate) => sum + Number(candidate.estimated_minutes ?? 0), 0);
        return [String(row.id), descendantMinutes || Number(row.estimated_minutes ?? 0) || 60] as const;
      }));
      const inferredTotal = placementRows.reduce((sum, row) => sum + (inferredById.get(String(row.id)) ?? 60), 0);
      const sharedTotal = placementRows.length > 1 && explicitTimeCount === 0 && explicitDurationCount === 1 && totalRequestedMinutes !== null;
      let remainingSharedMinutes = totalRequestedMinutes ?? 0;
      let sequentialStart = Number(exactPrefs.work_start ?? 9);
      const explicitBlocks = placementRows.flatMap((row, rowIndex) => {
        const title = String(row.title);
        const startAt = rawText.indexOf(title.toLowerCase());
        if (startAt < 0) return [];
        const nextComma = rawText.indexOf(',', startAt);
        const clause = rawText.slice(startAt, nextComma >= 0 ? nextComma : startAt + 180);
        const time = clause.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
        let startHour = sharedTotal ? sequentialStart : Number(exactPrefs.work_start ?? 9);
        if (time) {
          let hour = Number(time[1]) % 12;
          if (time[3] === 'pm') hour += 12;
          startHour = hour + Number(time[2] ?? 0) / 60;
        }
        const mins = clause.match(/\b(\d+)\s*(?:min|mins|minutes)\b/) ?? (!sharedTotal ? rawMinutes : null);
        const hrs = clause.match(/\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours)\b/) ?? (!sharedTotal ? rawHours : null);
        const inferredMinutes = inferredById.get(String(row.id)) ?? 60;
        const plannedMinutes = sharedTotal
          ? rowIndex === placementRows.length - 1
            ? remainingSharedMinutes
            : Math.max(15, Math.round((totalRequestedMinutes! * inferredMinutes / Math.max(1, inferredTotal)) / 15) * 15)
          : mins ? Number(mins[1]) : hrs ? Math.round(Number(hrs[1]) * 60) : Math.min(120, inferredMinutes);
        if (sharedTotal) {
          remainingSharedMinutes -= plannedMinutes;
          sequentialStart += plannedMinutes / 60;
        }
        return [{
          task_id: String(row.id), title, date: targetDate, start_hour: startHour,
          duration_hours: Math.max(0.25, plannedMinutes / 60), planned_minutes: plannedMinutes,
          due_date: (row.hard_deadline as string | null) ?? (row.target_date as string | null) ?? (row.due_date as string | null) ?? null,
          planning_role: 'before_deadline' as const,
        }];
      });
      if (explicitBlocks.length >= 1) {
        const busy = await loadBusyWindow(targetDate, targetDate);
        const earliest = Math.min(...explicitBlocks.map(block => block.start_hour));
        const latest = Math.max(...explicitBlocks.map(block => block.start_hour + block.duration_hours));
        const exceedsWorkWindow = latest > Number(exactPrefs.work_end ?? 18);
        const overlapsBusy = explicitBlocks.some(block => busy.some(item =>
          item.date === block.date
          && block.start_hour < item.start_hour + item.duration_hours
          && item.start_hour < block.start_hour + block.duration_hours
        ));
        return {
          kind: 'plan_options' as const,
          title: `Exact placement for ${targetDate}`,
          advisory: null,
          summary: `${explicitBlocks.length} named block${explicitBlocks.length === 1 ? '' : 's'} placed using your requested date and duration. Nothing else was added.`,
          options: [{
            kind: 'plan' as const, option_id: 'exact', name: 'Your exact times',
            description: 'Uses your task names and durations without shortening them. When no start time is given, placement begins at your workday start.',
            from: targetDate, to: targetDate,
            work_start: Math.floor(earliest), work_end: Math.ceil(latest),
            needs_estimate: [], days: [{ date: targetDate, available_minutes: Math.max(0, Math.round((latest - earliest) * 60)) }],
            busy, blocks: explicitBlocks, unplaced: [],
            scheduler: { status: exceedsWorkWindow || overlapsBusy ? 'tight' : 'feasible', gap_minutes: 0, unestimated_count: 0, overflow_count: 0 },
            status: 'pending' as const, adjustments: {},
          }],
        };
      }
    }
  }
  const sourceTaskIds = inferred.sourceDate ? await loadTaskIdsScheduledOnDate(inferred.sourceDate) : new Set<string>();
  const moveMode = Boolean(inferred.sourceDate && sourceTaskIds.size);
  const normalizedMessage = (message ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const allTaskRows = [...inp.taskById.values()];
  const inferredAnyTask = allTaskRows
    .filter(task => {
      const title = String(task.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return title.length >= 4 && normalizedMessage.includes(title);
    })
    .sort((a, b) => String(b.title).length - String(a.title).length)[0];
  const inferredTaskId = inp.tasks
    .filter(task => task.title.length >= 4 && normalizedMessage.includes(task.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()))
    .sort((a, b) => b.title.length - a.title.length)[0]?.id;
  const inferredGoalId = inp.tasks
    .filter(task => task.goal_id && task.goal_title && normalizedMessage.includes(task.goal_title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()))
    .sort((a, b) => (b.goal_title?.length ?? 0) - (a.goal_title?.length ?? 0))[0]?.goal_id;
  const scopedTaskId = mergedParams.task_id ?? inferredTaskId;
  const descendantScopeIds = inferredAnyTask && !inp.tasks.some(task => task.id === inferredAnyTask.id)
    ? new Set(inp.tasks.filter(task => {
      let parentId = (inp.taskById.get(task.id)?.parent_task_id as string | null) ?? null;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        if (parentId === inferredAnyTask.id) return true;
        seen.add(parentId);
        parentId = (inp.taskById.get(parentId)?.parent_task_id as string | null) ?? null;
      }
      return false;
    }).map(task => task.id))
    : new Set<string>();
  const sourceTasks = scopedTaskId
    ? inp.tasks.filter(task => task.id === scopedTaskId)
    : descendantScopeIds.size
      ? inp.tasks.filter(task => descendantScopeIds.has(task.id))
    : inferredGoalId
      ? inp.tasks.filter(task => task.goal_id === inferredGoalId)
    : inferred.sourceDate
      ? inp.tasks.filter(task => sourceTaskIds.has(task.id) || task.due_date === inferred.sourceDate)
      : inp.tasks;
  const hasSourceScope = Boolean(inferred.sourceDate && sourceTasks.length);
  const hasEntityScope = Boolean(scopedTaskId || descendantScopeIds.size || inferredGoalId);
  const scopedSourceTaskIds = new Set(sourceTasks.map(task => task.id));
  const baseTasks = sourceTasks.map(task => ({
    ...task,
    // An explicitly scoped request means "place this work in the target
    // window", even when its previous deadline is already overdue.
    due_date: hasSourceScope || hasEntityScope ? window.to : task.due_date,
    ...(mergedParams.max_daily_minutes
      ? { max_daily_minutes: mergedParams.max_daily_minutes }
      : {}),
  }));
  if (!baseTasks.length) return null;
  // Saved workdays remain authoritative. An explicit daily cadence may justify
  // a weekend alternative, but it must not silently rewrite the user's week.
  const planningPrefs = inp.prefs;

  const { rows: prefsRows } = await query("SELECT work_start, work_end FROM user_schedule_prefs WHERE id='default'");
  const prefRow = (prefsRows[0] ?? {}) as Record<string, unknown>;
  const workStart = window.startHour ?? Number(prefRow.work_start ?? 9);
  const workEnd = window.endHour ?? Number(prefRow.work_end ?? 18);
  const busy = await loadBusyWindow(window.from, window.to);
  const totalRequired = baseTasks.reduce((sum, task) => sum + task.estimated_minutes, 0);
  const workdayCount = Math.max(1, horizonDays);
  const averageDay = Math.max(60, Math.ceil(totalRequired / workdayCount / Math.max(0.2, 1 - planningPrefs.buffer_ratio)));
  const targetDates = Array.from({ length: horizonDays }, (_, index) => addDaysStr(window.from, index));
  const firstTarget = targetDates[0];
  const sourceDate = inferred.sourceDate;
  const scopedEstimateTriage = inferredGoalId
    ? await loadEstimateTriage(inp.notSchedulable.filter(task => task.goal_id === inferredGoalId))
    : [];

  const pacingTask = requestedDailyCap && baseTasks.length === 1 ? baseTasks[0] : null;
  const capacityForPrefs = (prefs: typeof inp.prefs) => computeSchedule({
    start_date: window.from,
    tasks: [],
    meetings: inp.meetings,
    prefs,
    overrides: inp.overrides,
    horizon_days: horizonDays,
  }).capacity_days.filter(day => day.available_minutes > 0);
  const workCapacityDays = pacingTask ? capacityForPrefs(planningPrefs) : [];
  const cappedCapacity = (days: typeof workCapacityDays, cap: number) =>
    days.reduce((sum, day) => sum + Math.min(cap, day.available_minutes), 0);
  const strictPacingCapacity = pacingTask && requestedDailyCap
    ? cappedCapacity(workCapacityDays, requestedDailyCap)
    : 0;
  const pacingShortfall = pacingTask
    ? Math.max(0, pacingTask.estimated_minutes - strictPacingCapacity)
    : 0;
  const requiredWorkdayCap = pacingTask && pacingShortfall > 0
    ? Array.from({ length: Math.floor((960 - requestedDailyCap!) / 15) + 1 }, (_, index) => requestedDailyCap! + index * 15)
      .find(cap => cappedCapacity(workCapacityDays, cap) >= pacingTask.estimated_minutes) ?? 960
    : requestedDailyCap ?? 0;
  const weekendPrefs = { ...planningPrefs, work_days: [0, 1, 2, 3, 4, 5, 6] };
  const weekendCapacityDays = pacingTask && requestsCalendarDailyCadence(message)
    ? capacityForPrefs(weekendPrefs)
    : [];
  const weekendPacingFits = Boolean(
    pacingTask
    && requestedDailyCap
    && cappedCapacity(weekendCapacityDays, requestedDailyCap) >= pacingTask.estimated_minutes,
  );
  const fmtPacingMinutes = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return hours ? `${hours}h${remainder ? ` ${remainder}m` : ''}` : `${remainder}m`;
  };

  const strategies: Array<{
    id: string;
    name: string;
    description: string;
    tasks: typeof baseTasks;
    prefs: typeof inp.prefs;
    overrides: typeof inp.overrides;
    reportedUnplacedMinutes?: number;
    reportedGapMinutes?: number;
    reportedStatus?: 'feasible' | 'tight' | 'risky' | 'impossible';
  }> = pacingTask && requestedDailyCap && pacingShortfall > 0 ? [
    {
      id: 'keep-cap',
      name: `Keep ${fmtPacingMinutes(requestedDailyCap)} on workdays`,
      description: `${workCapacityDays.length} available workdays provide ${fmtPacingMinutes(strictPacingCapacity)} at this pace, leaving ${fmtPacingMinutes(pacingShortfall)} for later or overtime.`,
      tasks: [{ ...pacingTask, estimated_minutes: strictPacingCapacity }],
      prefs: planningPrefs,
      overrides: inp.overrides,
      reportedUnplacedMinutes: pacingShortfall,
      reportedGapMinutes: -pacingShortfall,
      reportedStatus: 'risky',
    },
    {
      id: 'increase-workdays',
      name: `Finish on workdays at about ${fmtPacingMinutes(requiredWorkdayCap)}/day`,
      description: `Raises the average ceiling enough to finish by ${window.to}. You can spread it evenly, or keep ${fmtPacingMinutes(requestedDailyCap)} on most days and concentrate the extra ${fmtPacingMinutes(pacingShortfall)} into selected overtime days.`,
      tasks: [{ ...pacingTask, max_daily_minutes: requiredWorkdayCap }],
      prefs: planningPrefs,
      overrides: inp.overrides,
    },
    ...(weekendPacingFits ? [{
      id: 'include-weekends',
      name: `Keep ${fmtPacingMinutes(requestedDailyCap)}/day and include weekends`,
      description: `Keeps your requested daily limit but uses calendar days in this window. This is an explicit alternative; it does not change your saved workweek.`,
      tasks: [{ ...pacingTask, max_daily_minutes: requestedDailyCap }],
      prefs: weekendPrefs,
      overrides: inp.overrides,
    }] : []),
  ] : [
    {
      id: 'balanced',
      name: 'Balanced split',
      description: 'Spreads the moved work across the target days so neither day takes the whole hit.',
      tasks: baseTasks,
      prefs: { ...planningPrefs, daily_capacity_minutes: Math.min(planningPrefs.daily_capacity_minutes, averageDay + 60) },
      overrides: inp.overrides,
    },
    {
      id: 'deadline',
      name: 'Deadline first',
      description: 'Keeps the most urgent and highest-priority work earliest in the target window.',
      tasks: baseTasks,
      prefs: planningPrefs,
      overrides: inp.overrides,
    },
    {
      id: 'early',
      name: 'Early catch-up',
      description: 'Front-loads the work as much as possible so the later day stays cleaner.',
      tasks: baseTasks.map(task => ({ ...task, priority: 'high' })),
      prefs: planningPrefs,
      overrides: inp.overrides,
    },
    {
      id: 'later',
      name: targetDates.length > 1 ? 'Later-heavy' : 'Compact fallback',
      description: targetDates.length > 1
        ? 'Keeps the first target day lighter and pushes more catch-up work later.'
        : 'Shows the tightest version inside the requested day.',
      tasks: baseTasks,
      prefs: planningPrefs,
      overrides: targetDates.length > 1
        ? [
          ...inp.overrides,
          { date: firstTarget, available_minutes: Math.max(60, Math.round(inp.prefs.daily_capacity_minutes * 0.35)) },
        ]
        : inp.overrides,
    },
  ];

  const originalDeadline = new Map(sourceTasks.map(task => [task.id, task.due_date]));
  const generatedOptions = strategies.map(strategy => {
      const result = computeSchedule({
      start_date: window.from,
      tasks: strategy.tasks,
      meetings: inp.meetings,
      prefs: strategy.prefs,
      overrides: strategy.overrides,
      horizon_days: horizonDays,
    });
      const layout = layoutPlan({
      dayAssignments: result.day_assignments,
      tasks: strategy.tasks.map(task => ({ id: task.id, title: task.title, remaining_minutes: task.estimated_minutes })),
      workStart,
      workEnd,
        busy: busy.map(block => ({ date: block.date, start_hour: block.start_hour, end_hour: block.start_hour + block.duration_hours })),
      });
    const reportedUnplaced = strategy.reportedUnplacedMinutes
      ? [
        ...layout.unplaced,
        { task_id: pacingTask!.id, title: pacingTask!.title, minutes: strategy.reportedUnplacedMinutes },
      ]
      : layout.unplaced;
    return {
      kind: 'plan' as const,
      option_id: strategy.id,
      name: strategy.name,
      description: strategy.description,
      from: window.from,
      to: window.to,
      work_start: workStart,
      work_end: workEnd,
      needs_estimate: scopedEstimateTriage,
      days: result.day_assignments.map(day => ({ date: day.date, available_minutes: day.available_minutes })),
      busy,
      blocks: layout.blocks.map(block => {
        const dueDate = originalDeadline.get(block.task_id) ?? null;
        return {
          ...block,
          due_date: dueDate,
          planning_role: dueDate && dueDate < block.date
            ? 'overdue' as const
            : dueDate === block.date
              ? 'due_on_block_day' as const
              : dueDate && dueDate <= window.to
                ? 'due_in_window' as const
                : 'before_deadline' as const,
        };
      }),
      unplaced: reportedUnplaced,
      scheduler: {
        status: strategy.reportedStatus ?? result.status,
        gap_minutes: strategy.reportedGapMinutes ?? result.gap_minutes,
        unestimated_count: result.unestimated_task_ids.length,
        overflow_count: result.tasks_overflow.length,
      },
      status: 'pending' as const,
      adjustments: {} as Record<string, { date: string; start_hour: number }>,
      ...(sourceDate ? { clear_task_dates: [sourceDate] } : {}),
    };
  });

  const optionSignature = (option: typeof generatedOptions[number]) =>
    option.blocks
      .map(block => [
        block.task_id,
        block.date,
        Math.round(block.start_hour * 4) / 4,
        Math.round(block.duration_hours * 4) / 4,
      ].join(':'))
      .sort()
      .join('|') || `empty:${option.scheduler.status}:${option.unplaced.length}`;
  const statusRank: Record<string, number> = { feasible: 0, tight: 8, risky: 16, impossible: 40 };
  const optionScore = (option: typeof generatedOptions[number]) => {
    const unplacedMinutes = option.unplaced.reduce((sum, item) => sum + item.minutes, 0);
    const byDate = new Map<string, number>();
    for (const block of option.blocks) {
      byDate.set(block.date, (byDate.get(block.date) ?? 0) + Math.round(block.duration_hours * 60));
    }
    const loads = [...byDate.values()];
    const busiestDay = Math.max(0, ...loads);
    const spreadPenalty = loads.length > 1 ? Math.max(...loads) - Math.min(...loads) : busiestDay * 0.15;
    return (statusRank[option.scheduler.status] ?? 20)
      + option.scheduler.overflow_count * 12
      + unplacedMinutes / 30
      + Math.max(0, -option.scheduler.gap_minutes) / 120
      + spreadPenalty / 240;
  };
  const seenSignatures = new Set<string>();
  const distinctOptions = generatedOptions
    .filter(option => option.blocks.length > 0 || generatedOptions.every(candidate => candidate.blocks.length === 0))
    .sort((a, b) => pacingShortfall > 0 ? 0 : optionScore(a) - optionScore(b))
    .filter(option => {
      const signature = optionSignature(option);
      if (seenSignatures.has(signature)) return false;
      seenSignatures.add(signature);
      return true;
    });
  const nonImpossible = distinctOptions.filter(option => option.scheduler.status !== 'impossible');
  const candidateOptions = nonImpossible.length ? nonImpossible : distinctOptions;
  const optionLimit = pacingShortfall > 0
    ? strategies.length
    : horizonDays <= 1 || baseTasks.length <= 2 ? 2
      : baseTasks.length <= 5 ? 3
        : 4;
  const options = candidateOptions.slice(0, Math.max(1, Math.min(optionLimit, candidateOptions.length)));

  const title = hasSourceScope && sourceDate
    ? `Move ${sourceDate} work into ${window.from === window.to ? window.from : `${window.from} - ${window.to}`}`
    : `Schedule options for ${window.from === window.to ? window.from : `${window.from} - ${window.to}`}`;
  return {
    kind: 'plan_options' as const,
    title,
    advisory: pacingTask && requestedDailyCap && pacingShortfall > 0
      ? `At ${fmtPacingMinutes(requestedDailyCap)} across your ${workCapacityDays.length} available workdays, you can schedule about ${fmtPacingMinutes(strictPacingCapacity)} by ${window.to}, not the full ${fmtPacingMinutes(pacingTask.estimated_minutes)}. You are short by about ${fmtPacingMinutes(pacingShortfall)}. I prepared alternatives: keep the limit and accept remaining work; average about ${fmtPacingMinutes(requiredWorkdayCap)} per workday; keep ${fmtPacingMinutes(requestedDailyCap)} on most days and place the extra ${fmtPacingMinutes(pacingShortfall)} on selected overtime days;${weekendPacingFits ? ' or keep the limit and explicitly use weekends.' : ' or extend the deadline.'}`
      : null,
    summary: hasSourceScope
      ? `${scopedSourceTaskIds.size} task${scopedSourceTaskIds.size !== 1 ? 's' : ''} from ${sourceDate} are shown as ${options.length} distinct calendar layout${options.length !== 1 ? 's' : ''}. Nothing changes until you apply one.`
      : `Here ${options.length === 1 ? 'is the strongest calendar layout' : `are the ${options.length} strongest distinct calendar layouts`}. Nothing changes until you apply one.`,
    options,
  };
}

/** "Every day 6–9am for a month" → the same widget payload shape as a plan,
 *  but the blocks are a fixed series (no scheduler run — routines aren't
 *  solved for, they're declared). */
async function buildSeriesPayload(p: SeriesParams) {
  const todayStr = fmtYMD(new Date());
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
          `SELECT id, start_date FROM tasks WHERE id = ANY($1) AND completed = false`,
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
      SELECT id, action_type, action_payload, explanation, confidence, created_at
      FROM ai_action_proposals WHERE status='pending'
      ORDER BY confidence DESC, created_at ASC LIMIT 20`),
    query(`
      SELECT id, entry_date, ingestion_status, ingestion_attempts
      FROM journal_entries WHERE ingestion_status IN ('failed','needs_review')
      ORDER BY entry_date DESC LIMIT 20`),
    query(`
      SELECT ef.id, ef.fact_type, ef.fact_text, ef.confidence, ef.source_type, ef.source_id, ef.target_type, ef.target_id
      FROM extracted_facts ef
      WHERE ef.needs_review = true AND ef.status = 'active'
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
      WHERE t.completed = false
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
      WHERE t.completed = false
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
      WHERE t.completed = false
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
      WHERE t.completed = false
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
      WHERE t.completed = false
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
    { bucket: 'pending_proposals',         items: pendingProposals,         label: 'AI proposals awaiting review' },
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
  const { message, model }: { message: string; model?: string } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });
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

  // Load history (excluding system messages)
  const { rows: historyRows } = await query(
    `SELECT role, content FROM chat_messages WHERE session_id=$1 AND role != 'system' ORDER BY created_at ASC`,
    [req.params.id],
  );
  const history = historyRows as { role: 'user' | 'assistant'; content: string }[];
  const messages: ChatMessage[] = [...history, { role: 'user', content: message }];
  const planningMessage = resolvePlanningRequestMessage(message, messages);
  const agentRunId = await startAgentRun({
    source: 'copilot_chat',
    agentKind: 'semantic_planner',
    sessionId: req.params.id,
    userMessage: message,
    model: selectedModel,
    metadata: { history_messages: history.length },
  });

  try {
    const greetingReply = COPILOT_DETERMINISTIC_FAST_PATHS
      ? simpleConversationReply(message)
      : null;
    if (greetingReply) {
      const now = new Date().toISOString();
      const msgId1 = crypto.randomUUID();
      const msgId2 = crypto.randomUUID();
      const runtime = runtimeInfo();
      const metadata = JSON.stringify({
        agent_run_id: agentRunId,
        actions: [],
        citations: [],
        intent: 'conversation_greeting',
        model_used: false,
        runtime,
      });
      await query(
        `INSERT INTO chat_messages (id, session_id, role, content, metadata_json, created_at)
         VALUES ($1,$2,'user',$3,NULL,$4),($5,$2,'assistant',$6,$7,$4)`,
        [msgId1, req.params.id, message, now, msgId2, greetingReply, metadata],
      );
      await query(`UPDATE chat_sessions SET updated_at=$1 WHERE id=$2`, [now, req.params.id]);
      await setAgentIntent(agentRunId, 'conversation_greeting', 1, { model_used: false });
      await finishAgentRun(agentRunId, 'completed', greetingReply, {
        metadata: { action_count: 0, citation_count: 0, model_used: false, runtime },
      });
      return res.json({
        reply: greetingReply,
        actions: [],
        citations: [],
        runtime,
        session_id: req.params.id,
        message_id: msgId2,
        agent_run_id: agentRunId,
      });
    }

    const dueDateUpdate = COPILOT_DETERMINISTIC_FAST_PATHS
      ? await applyExplicitBatchDueDate(message)
      : null;
    if (dueDateUpdate) {
      const replyText = `Moved ${dueDateUpdate.tasks.length} task due date${dueDateUpdate.tasks.length !== 1 ? 's' : ''} to ${dueDateUpdate.date}: ${dueDateUpdate.tasks.join(', ')}.`;
      const now = new Date().toISOString();
      const msgId1 = crypto.randomUUID();
      const msgId2 = crypto.randomUUID();
      const runtime = runtimeInfo();
      const metadata = JSON.stringify({ agent_run_id: agentRunId, actions: [], citations: [], intent: 'update_due_dates', model_used: false, runtime, due_date_update: dueDateUpdate });
      await query(
        `INSERT INTO chat_messages (id, session_id, role, content, metadata_json, created_at)
         VALUES ($1,$2,'user',$3,NULL,$4),($5,$2,'assistant',$6,$7,$4)`,
        [msgId1, req.params.id, message, now, msgId2, replyText, metadata],
      );
      await query(`UPDATE chat_sessions SET updated_at=$1 WHERE id=$2`, [now, req.params.id]);
      await setAgentIntent(agentRunId, 'update_due_dates', 0.99, { action_count: 0, model_used: false, updated_tasks: dueDateUpdate.tasks.length });
      await finishAgentRun(agentRunId, 'completed', replyText, { metadata: { action_count: 0, citation_count: 0, model_used: false } });
      return res.json({ reply: replyText, actions: [], citations: [], runtime, due_date_update: dueDateUpdate, session_id: req.params.id, message_id: msgId2, agent_run_id: agentRunId });
    }
    const recentUserMessages = history
      .filter(historyMessage => historyMessage.role === 'user')
      .map(historyMessage => historyMessage.content);
    const scheduleDecision = await classifyScheduleIntent(message, recentUserMessages, {
      onModelTrace: trace => modelCalls.push({ phase: 'intent', ...trace }),
      currentDate: fmtYMD(new Date()),
      model: selectedModel,
    });
    const semanticFrame = applyScheduleIntentDecision(
      interpretObjective(message),
      scheduleDecision,
    );
    const toolPlan = buildToolPlan(semanticFrame);
    const schedulePlanRequested = scheduleDecision.mode === 'propose_change';
    const taskConfigurationRequested = hasTaskConfigurationIntent(message);
    if (COPILOT_DETERMINISTIC_FAST_PATHS && schedulePlanRequested && !taskConfigurationRequested) {
      const directPlanOptions = await buildPlanOptionsPayload(planningMessage);
      if (directPlanOptions) {
        const replyText = directPlanOptions.advisory ?? 'I prepared the actual calendar placement below. Nothing changes until you apply a layout.';
        const now = new Date().toISOString();
        const msgId1 = crypto.randomUUID();
        const msgId2 = crypto.randomUUID();
        const runtime = runtimeInfo();
        const metadata = JSON.stringify({
          agent_run_id: agentRunId,
          actions: [],
          citations: [],
          intent: 'plan_schedule',
          model_used: true,
          runtime,
          semantic: { frame: semanticFrame, schedule_decision: scheduleDecision, tool_plan: toolPlan },
          plan_options: directPlanOptions,
        });
        await query(
          `INSERT INTO chat_messages (id, session_id, role, content, metadata_json, created_at)
           VALUES ($1,$2,'user',$3,NULL,$4),($5,$2,'assistant',$6,$7,$4)`,
          [msgId1, req.params.id, message, now, msgId2, replyText, metadata],
        );
        await query(`UPDATE chat_sessions SET updated_at=$1 WHERE id=$2`, [now, req.params.id]);
        await setAgentIntent(agentRunId, 'plan_schedule', 0.99, { action_count: 0, model_used: true, has_visual_schedule: true });
        await finishAgentRun(agentRunId, 'completed', replyText, { metadata: { action_count: 0, citation_count: 0, model_used: true, runtime } });
        return res.json({
          reply: replyText,
          actions: [],
          citations: [],
          plan_options: directPlanOptions,
          session_id: req.params.id,
          message_id: msgId2,
          agent_run_id: agentRunId,
          runtime,
          semantic: { frame: semanticFrame, schedule_decision: scheduleDecision, tool_plan: toolPlan },
        });
      }
    }
    const { ctx: context, citations } = await getScheduleContext(message);
    const semanticScheduleScope = await loadModelSelectedScheduleScope(scheduleDecision);
    if (COPILOT_DETERMINISTIC_FAST_PATHS && scheduleDecision.mode === 'inspect' && scheduleDecision.view === 'deadline_overview') {
      const replyText = formatDeadlineOverviewReply(context, message);
      const now = new Date().toISOString();
      const msgId1 = crypto.randomUUID();
      const msgId2 = crypto.randomUUID();
      const runtime = runtimeInfo();
      const metadata = JSON.stringify({
        agent_run_id: agentRunId,
        actions: [],
        citations,
        intent: 'inspect_deadlines',
        model_used: modelCalls.length > 0,
        runtime,
        semantic: { frame: semanticFrame, schedule_decision: scheduleDecision, tool_plan: toolPlan },
      });
      await query(
        `INSERT INTO chat_messages (id, session_id, role, content, metadata_json, created_at)
         VALUES ($1,$2,'user',$3,NULL,$4),($5,$2,'assistant',$6,$7,$4)`,
        [msgId1, req.params.id, message, now, msgId2, replyText, metadata],
      );
      await query(`UPDATE chat_sessions SET updated_at=$1 WHERE id=$2`, [now, req.params.id]);
      await setAgentIntent(agentRunId, 'inspect_deadlines', scheduleDecision.confidence, {
        action_count: 0,
        model_used: modelCalls.length > 0,
      });
      await finishAgentRun(agentRunId, 'completed', replyText, {
        metadata: { action_count: 0, citation_count: citations.length, model_used: modelCalls.length > 0, runtime },
      });
      return res.json({
        reply: replyText,
        actions: [],
        citations,
        runtime,
        semantic: { frame: semanticFrame, schedule_decision: scheduleDecision, tool_plan: toolPlan },
        session_id: req.params.id,
        message_id: msgId2,
        agent_run_id: agentRunId,
      });
    }
    const overdueReply = COPILOT_DETERMINISTIC_FAST_PATHS && wantsOverdueTaskList(message)
      ? formatOverdueTaskReply(context)
      : null;
    if (overdueReply) {
      const now = new Date().toISOString();
      const msgId1 = crypto.randomUUID();
      const msgId2 = crypto.randomUUID();
      const runtime = runtimeInfo();
      const metadata = JSON.stringify({ agent_run_id: agentRunId, actions: [], citations: [], intent: 'inspect_overdue_tasks', model_used: true, runtime, semantic: { frame: semanticFrame, schedule_decision: scheduleDecision, tool_plan: toolPlan }, overdue_tasks_view: { tasks: context.overdue_tasks } });
      await query(
        `INSERT INTO chat_messages (id, session_id, role, content, metadata_json, created_at)
         VALUES ($1,$2,'user',$3,NULL,$4),($5,$2,'assistant',$6,$7,$4)`,
        [msgId1, req.params.id, message, now, msgId2, overdueReply, metadata],
      );
      await query(`UPDATE chat_sessions SET updated_at=$1 WHERE id=$2`, [now, req.params.id]);
      await setAgentIntent(agentRunId, 'inspect_overdue_tasks', 0.99, { action_count: 0, model_used: true });
      await finishAgentRun(agentRunId, 'completed', overdueReply, { metadata: { action_count: 0, citation_count: citations.length, model_used: true, runtime } });
      return res.json({
        reply: overdueReply,
        actions: [],
        citations: [],
        session_id: req.params.id,
        message_id: msgId2,
        agent_run_id: agentRunId,
        runtime,
        semantic: { frame: semanticFrame, schedule_decision: scheduleDecision, tool_plan: toolPlan },
        overdue_tasks_view: { tasks: context.overdue_tasks },
      });
    }
    const directDayView = COPILOT_DETERMINISTIC_FAST_PATHS && wantsScheduleDayView(message)
      ? buildScheduleDayView(context, message)
      : null;
    if (directDayView) {
      const replyText = formatChatScheduleDayReply(directDayView);
      const now = new Date().toISOString();
      const msgId1 = crypto.randomUUID();
      const msgId2 = crypto.randomUUID();
      const runtime = runtimeInfo();
      const metadata = JSON.stringify({ agent_run_id: agentRunId, actions: [], citations: [], intent: 'inspect_schedule', model_used: true, runtime, semantic: { frame: semanticFrame, schedule_decision: scheduleDecision, tool_plan: toolPlan }, schedule_day_view: directDayView });
      await query(
        `INSERT INTO chat_messages (id, session_id, role, content, metadata_json, created_at)
         VALUES ($1,$2,'user',$3,NULL,$4),($5,$2,'assistant',$6,$7,$4)`,
        [msgId1, req.params.id, message, now, msgId2, replyText, metadata],
      );
      await query(`UPDATE chat_sessions SET updated_at=$1 WHERE id=$2`, [now, req.params.id]);
      await setAgentIntent(agentRunId, 'inspect_schedule', 0.99, { action_count: 0, model_used: true, has_visual_schedule: true });
      await finishAgentRun(agentRunId, 'completed', replyText, { metadata: { action_count: 0, citation_count: 0, model_used: true, runtime } });
      return res.json({ reply: replyText, actions: [], citations: [], schedule_day_view: directDayView, runtime, semantic: { frame: semanticFrame, schedule_decision: scheduleDecision, tool_plan: toolPlan }, session_id: req.params.id, message_id: msgId2, agent_run_id: agentRunId });
    }
    const modelContext = compactContextForModel(context, message);
    const answerContext = scheduleDecision.operation === 'move_existing'
      ? { today: context.today }
      : modelContext;
    const answerSystemPrompt = scheduleDecision.operation === 'move_existing'
      ? MOVE_EXISTING_SYSTEM_PROMPT
      : SYSTEM_PROMPT;
    console.log(
      `[ai] model context: ${JSON.stringify(answerContext).length} chars, targeted tasks: ${context.targeted_task_context.length}`,
    );
    assertSafeAIContext(answerContext);
    await appendAgentEvent(agentRunId, 'context_prepared', 'Planning context prepared', null, {
      goals: context.active_goals.length,
      citations: citations.length,
      incomplete_tasks: context.planning_coverage.total_incomplete,
      context_tasks: context.planning_coverage.tasks_in_context,
    });
    // Compact JSON — see /chat handler note on prompt-size cost of pretty-printing.
    const systemWithContext = `${answerSystemPrompt}

## Semantic request contract
${JSON.stringify({ frame: semanticFrame, schedule_decision: scheduleDecision, tool_plan: toolPlan })}
Treat this contract as the selected operation boundary. Never emit plan_schedule unless schedule_decision.mode is "propose_change". Never perform scheduling arithmetic yourself; only explain server-computed schedule results. Any mutating operation must remain a proposal until confirmed.

## Semantic schedule scope selected by the model
${JSON.stringify(semanticScheduleScope)}
When this is non-null, it is the authoritative source/target slice for this request. Describe and act on these records only; target records are context and must not be moved as if they came from the source.

## Current data (as of ${context.today}):
${JSON.stringify(answerContext)}`;

    const ollamaMessages = [
      { role: 'system' as const, content: systemWithContext },
      ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    const raw = await chat(ollamaMessages, {
      model: selectedModel,
      temperature: 0.3,
      max_tokens: 8192,
      jsonMode: true,
      onTrace: trace => modelCalls.push({ phase: 'answer', ...trace }),
      // The local 8B model cannot answer the full planning prompt within an
      // interactive latency budget. Fail clearly instead of hanging for minutes.
      fallbackPromptCharLimit: 30_000,
    });
    await appendAgentEvent(agentRunId, 'model_completed', 'Semantic model responded', null, { model: selectedModel });

    const parsed = parseChatEnvelope(raw);

    // The model can omit "reply" (valid JSON, actions only) — chat_messages.content
    // is NOT NULL, and losing the whole exchange over a missing field is wrong.
    const scheduleDayView = directDayView;
    let replyText = scheduleDayView ? formatChatScheduleDayReply(scheduleDayView) : typeof parsed.reply === 'string' && parsed.reply.trim()
      ? parsed.reply
      : '(The model proposed actions without commentary — see the action cards.)';

    if (overdueReply) replyText = overdueReply;

    // Validate model actions and persist them as durable proposals FIRST so
    // the assistant message can be stored with proposal ids attached — a
    // reloaded conversation then restores its action cards and their state.
    // plan_schedule is intercepted: it is not a proposal — the server runs the
    // deterministic scheduler and the message carries an interactive calendar.
    const schedulePlanAllowed = schedulePlanRequested;
    const validatedAll = ensurePacedPlanAction(
      normalizeTaskScopedActions(
        coalesceNewGoalStarterTasks(Array.isArray(parsed.actions) ? validateModelActions(parsed.actions) : []),
        context,
        message,
      ),
      context,
      planningMessage,
      schedulePlanAllowed,
    );
    const seriesAction = scheduleDayView || overdueReply
      ? undefined
      : validatedAll.find(a => a.type === 'create_block_series' && !a.rejected_reason);
    const planAction = scheduleDayView || seriesAction
      ? undefined
      : schedulePlanAllowed
        ? validatedAll.find(a => a.type === 'plan_schedule' && !a.rejected_reason)
        : undefined;
    const planOptions = !scheduleDayView && !overdueReply && planAction
      ? await buildPlanOptionsPayload(planningMessage, planAction.params as PlanWindowParams)
      : null;
    if (planOptions) {
      replyText = planOptions.advisory ?? 'I made a few visual calendar options. Pick the layout that looks right; nothing changes until you apply one.';
    }
    const validated = await persistActionsAsProposals(
      (scheduleDayView || overdueReply ? [] : validatedAll)
        .filter(a => a.type !== 'plan_schedule' && a.type !== 'create_block_series'),
      'chat_session',
      req.params.id,
    );
    const resolvedIntent = scheduleDayView
      ? 'inspect_schedule'
      : overdueReply
        ? 'inspect_overdue_tasks'
        : planOptions || planAction
        ? 'plan_schedule'
        : seriesAction
          ? 'create_routine'
          : validated[0]?.type ?? 'conversation';
    await setAgentIntent(agentRunId, resolvedIntent, scheduleDayView || overdueReply || planOptions || planAction ? 0.99 : 0.75, {
      action_count: validated.length,
      has_visual_schedule: Boolean(scheduleDayView || planOptions || seriesAction),
    });

    let plan:
      | Awaited<ReturnType<typeof buildPlanPayload>>
      | Awaited<ReturnType<typeof buildSeriesPayload>>
      | null = null;
    if (planOptions) {
      plan = null;
    } else if (planAction) {
      // Params are already strict-Zod validated; the resolver handles clamping.
      plan = await buildPlanPayload(planAction.params as PlanWindowParams);
    } else if (seriesAction) {
      plan = await buildSeriesPayload(seriesAction.params as unknown as SeriesParams);
    }

    const runtime = runtimeInfo();
    const metadata = JSON.stringify({
      agent_run_id: agentRunId,
      actions: validated,
      feasibility: overdueReply || scheduleDecision.operation === 'move_existing' ? null : parsed.feasibility ?? null,
      citations,
      model: CHAT_MODEL,
      runtime,
      semantic: { frame: semanticFrame, schedule_decision: scheduleDecision, tool_plan: toolPlan },
      ...(plan ? { plan } : {}),
      ...(planOptions ? { plan_options: planOptions } : {}),
      ...(scheduleDayView ? { schedule_day_view: scheduleDayView } : {}),
    });

    // Persist user message + assistant reply (with metadata)
    const now = new Date().toISOString();
    const msgId1 = crypto.randomUUID();
    const msgId2 = crypto.randomUUID();
    await query(
      `INSERT INTO chat_messages (id, session_id, role, content, metadata_json, created_at)
       VALUES ($1,$2,'user',$3,NULL,$4),($5,$2,'assistant',$6,$7,$4)`,
      [msgId1, req.params.id, message, now, msgId2, replyText, metadata],
    );
    await query(`UPDATE chat_sessions SET updated_at=$1 WHERE id=$2`, [now, req.params.id]);
    await finishAgentRun(agentRunId, 'completed', replyText, {
      metadata: { action_count: validated.length, citation_count: citations.length },
    });

    res.json({
      ...parsed,
      reply: replyText,
      feasibility: overdueReply || scheduleDecision.operation === 'move_existing' ? undefined : parsed.feasibility,
      actions: validated,
      plan,
      ...(planOptions ? { plan_options: planOptions } : {}),
      ...(scheduleDayView ? { schedule_day_view: scheduleDayView } : {}),
      citations,
      session_id: req.params.id,
      message_id: msgId2,
      agent_run_id: agentRunId,
      runtime,
      semantic: {
        frame: semanticFrame,
        schedule_decision: scheduleDecision,
        tool_plan: toolPlan,
      },
    });
  } catch (err) {
    const msg = String(err);
    await finishAgentRun(agentRunId, 'failed', null, { error: msg }).catch(() => {});
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch')) {
      return res.status(503).json({ error: `Cannot reach Ollama at ${process.env.OLLAMA_HOST ?? 'http://localhost:11434'}. Model: ${CHAT_MODEL}` });
    }
    res.status(500).json({ error: msg });
  }
});

// DELETE /api/ai/sessions/:id — archive (soft delete) a session
router.delete('/sessions/:id', async (req, res) => {
  const { rowCount } = await query(`UPDATE chat_sessions SET archived=true WHERE id=$1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true });
});

export { router as aiRouter };
