export interface PlanningTaskInput {
  id: string;
  title: string;
  goal_id?: string | null;
  goal_title?: string | null;
  parent_task_id?: string | null;
  milestone_id?: string | null;
  status?: string | null;
  priority?: string | null;
  feel_score?: number | null;
  kind?: string | null;
  due_date?: string | null;
  start_date?: string | null;
  target_date?: string | null;
  hard_deadline?: string | null;
  scheduling_enabled?: boolean | null;
  estimated_minutes?: number | null;
  logged_minutes?: number | null;
  child_count?: number | null;
  last_activity_at?: string | null;
  updated_at?: string | null;
}

export interface PlanningBucketTask {
  id: string;
  title: string;
  goal_id: string | null;
  goal_title: string | null;
  parent_task_id: string | null;
  deadline: string | null;
  deadline_kind: 'hard_deadline' | 'target_date' | 'due_date' | null;
  priority: string;
  feel_score: number | null;
  status: string;
  remaining_minutes: number | null;
  child_count: number;
  days_until_deadline: number | null;
}

export interface LargeSliceTask extends PlanningBucketTask {
  buffer_minutes: number;
  minutes_with_buffer: number;
  suggested_daily_minutes: number;
}

export interface BackgroundTask extends PlanningBucketTask {
  suggested_slice_minutes: number;
  reason: 'far_deadline' | 'no_deadline';
}

export interface ParentRollupTask extends PlanningBucketTask {
  earliest_child_deadline: string | null;
  latest_child_deadline: string | null;
  dated_descendant_count: number;
}

export interface PlanningBuckets {
  must_finish_by_date: Array<{ date: string; tasks: PlanningBucketTask[] }>;
  large_tasks_needing_slices: LargeSliceTask[];
  parent_rollups: ParentRollupTask[];
  background_fillers: BackgroundTask[];
  unestimated_due_soon: PlanningBucketTask[];
  rules_summary: string[];
}

interface BuildPlanningBucketsOptions {
  today: string;
  effectiveCapacityMinutes: number;
  horizonDays?: number;
  nearDeadlineDays?: number;
  largeTaskMinutes?: number;
  bufferRatio?: number;
  maxPerBucket?: number;
}

const MS_PER_DAY = 86_400_000;

function parseDate(date: string): Date {
  return new Date(date + 'T00:00:00');
}

function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / MS_PER_DAY);
}

function addDays(date: string, days: number): string {
  const d = parseDate(date);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function resolvePlanningDeadline(task: PlanningTaskInput): {
  deadline: string | null;
  deadline_kind: PlanningBucketTask['deadline_kind'];
} {
  if (task.hard_deadline) return { deadline: task.hard_deadline, deadline_kind: 'hard_deadline' };
  if (task.target_date) return { deadline: task.target_date, deadline_kind: 'target_date' };
  if (task.due_date) return { deadline: task.due_date, deadline_kind: 'due_date' };
  return { deadline: null, deadline_kind: null };
}

function normalizeTask(task: PlanningTaskInput, today: string): PlanningBucketTask {
  const { deadline, deadline_kind } = resolvePlanningDeadline(task);
  const estimate = Number(task.estimated_minutes ?? 0);
  const logged = Number(task.logged_minutes ?? 0);
  const remaining = estimate > 0 ? Math.max(0, Math.round(estimate - logged)) : null;

  return {
    id: task.id,
    title: task.title,
    goal_id: task.goal_id ?? null,
    goal_title: task.goal_title ?? null,
    parent_task_id: task.parent_task_id ?? null,
    deadline,
    deadline_kind,
    priority: task.priority ?? 'medium',
    feel_score: task.feel_score == null ? null : Math.max(0, Math.min(100, Math.round(Number(task.feel_score)))),
    status: task.status ?? 'todo',
    remaining_minutes: remaining,
    child_count: Number(task.child_count ?? 0),
    days_until_deadline: deadline ? daysBetween(today, deadline) : null,
  };
}

function sortByDeadlineAndPriority(a: PlanningBucketTask, b: PlanningBucketTask): number {
  const ad = a.deadline ?? '9999-12-31';
  const bd = b.deadline ?? '9999-12-31';
  if (ad !== bd) return ad.localeCompare(bd);
  if ((a.feel_score ?? -1) !== (b.feel_score ?? -1)) return (b.feel_score ?? -1) - (a.feel_score ?? -1);
  const rank = (p: string) => p === 'high' || p === 'urgent' ? 0 : p === 'medium' ? 1 : 2;
  return rank(a.priority) - rank(b.priority);
}

function compact<T>(items: T[], max: number): T[] {
  return items.slice(0, max);
}

export function buildPlanningBuckets(
  tasks: PlanningTaskInput[],
  options: BuildPlanningBucketsOptions,
): PlanningBuckets {
  const horizonDays = options.horizonDays ?? 14;
  const nearDeadlineDays = options.nearDeadlineDays ?? horizonDays;
  const maxPerBucket = options.maxPerBucket ?? 12;
  const largeTaskMinutes = options.largeTaskMinutes ?? Math.max(180, Math.round(options.effectiveCapacityMinutes * 0.75));
  const bufferRatio = options.bufferRatio ?? 0.15;
  const horizonEnd = addDays(options.today, horizonDays);

  const normalized = tasks
    .map(t => normalizeTask(t, options.today))
    .filter(t => t.remaining_minutes !== 0)
    .sort(sortByDeadlineAndPriority);

  const byId = new Map(tasks.map(t => [t.id, t]));
  const isParent = (t: PlanningBucketTask) => t.child_count > 0;
  const isSchedulableLeaf = (t: PlanningBucketTask) => {
    const raw = byId.get(t.id);
    return !isParent(t) && raw?.scheduling_enabled !== false && raw?.kind !== 'critical_path';
  };

  const dueMap = new Map<string, PlanningBucketTask[]>();
  for (const t of normalized) {
    if (!t.deadline || t.deadline < options.today || t.deadline > horizonEnd) continue;
    if (isParent(t)) continue;
    if (!dueMap.has(t.deadline)) dueMap.set(t.deadline, []);
    dueMap.get(t.deadline)!.push(t);
  }

  const largeTasks = normalized
    .filter(t =>
      isSchedulableLeaf(t)
      && t.remaining_minutes !== null
      && t.remaining_minutes >= largeTaskMinutes
      && t.deadline !== null
      && t.days_until_deadline !== null
      && t.days_until_deadline >= 1
      && t.days_until_deadline <= nearDeadlineDays)
    .map(t => {
      const bufferMinutes = Math.ceil(t.remaining_minutes! * bufferRatio);
      const minutesWithBuffer = t.remaining_minutes! + bufferMinutes;
      const workDays = Math.max(1, t.days_until_deadline! + 1);
      return {
        ...t,
        buffer_minutes: bufferMinutes,
        minutes_with_buffer: minutesWithBuffer,
        suggested_daily_minutes: Math.min(options.effectiveCapacityMinutes, Math.ceil(minutesWithBuffer / workDays)),
      };
    });

  const childrenByParent = new Map<string, PlanningTaskInput[]>();
  for (const task of tasks) {
    if (!task.parent_task_id) continue;
    if (!childrenByParent.has(task.parent_task_id)) childrenByParent.set(task.parent_task_id, []);
    childrenByParent.get(task.parent_task_id)!.push(task);
  }
  const descendantDeadlines = (taskId: string) => {
    const dates: string[] = [];
    const queue = [...(childrenByParent.get(taskId) ?? [])];
    const seen = new Set<string>([taskId]);
    while (queue.length) {
      const descendant = queue.shift()!;
      if (seen.has(descendant.id)) continue;
      seen.add(descendant.id);
      const { deadline } = resolvePlanningDeadline(descendant);
      if (deadline) dates.push(deadline);
      queue.push(...(childrenByParent.get(descendant.id) ?? []));
    }
    return dates.sort();
  };
  const parentRollups = normalized.filter(t => isParent(t)).map(parent => {
    const dates = descendantDeadlines(parent.id);
    return {
      ...parent,
      earliest_child_deadline: dates[0] ?? null,
      latest_child_deadline: dates.at(-1) ?? null,
      dated_descendant_count: dates.length,
    };
  });

  const backgroundFillers = normalized
    .filter(t =>
      isSchedulableLeaf(t)
      && t.remaining_minutes !== null
      && t.remaining_minutes >= largeTaskMinutes
      && (!t.deadline || (t.days_until_deadline ?? 0) > nearDeadlineDays))
    .map(t => ({
      ...t,
      suggested_slice_minutes: Math.min(60, Math.max(30, Math.ceil(t.remaining_minutes! / 20))),
      reason: t.deadline ? 'far_deadline' as const : 'no_deadline' as const,
    }));

  const unestimatedDueSoon = normalized.filter(t =>
    isSchedulableLeaf(t)
    && t.remaining_minutes === null
    && t.deadline !== null
    && t.days_until_deadline !== null
    && t.days_until_deadline <= nearDeadlineDays);

  return {
    must_finish_by_date: [...dueMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, dueTasks]) => ({ date, tasks: compact(dueTasks.sort(sortByDeadlineAndPriority), 8) })),
    large_tasks_needing_slices: compact(largeTasks, maxPerBucket),
    parent_rollups: compact(parentRollups, maxPerBucket),
    background_fillers: compact(backgroundFillers, maxPerBucket),
    unestimated_due_soon: compact(unestimatedDueSoon, maxPerBucket),
    rules_summary: [
      'A task is due on a date only when its own hard_deadline, target_date, or due_date is that date.',
      'Large future-deadline tasks should be described as slices to start/continue before the deadline, not as due today.',
      'Parent tasks are rollups when they have incomplete children; schedule leaf subtasks when possible.',
      'An undated parent can still be time-sensitive: use its earliest child deadline for urgency and its latest child deadline as the last known rollup cutoff.',
      'Far-deadline or undated large tasks are background fillers: use small slices only after urgent work fits.',
    ],
  };
}
