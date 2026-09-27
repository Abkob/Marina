import type { DBGoal, DBTask } from '../db/schema';

const ACTIVITY_WINDOW_DAYS = 7;

export interface GoalTaskMetrics {
  totalTasks: number;
  completedTasks: number;
  remainingTasks: number;
  progress: number;
  activityLevel: number;
  totalWeight: number;
  completedWeight: number;
  usesExplicitWeights: boolean;
}

function isDone(task: DBTask) {
  return task.completed || task.status === 'done';
}

/** Mirrors the milestone card: a milestone is complete when all direct child tasks are done. */
export function isEffectivelyDone(task: DBTask, tasks: DBTask[]) {
  if (isDone(task)) return true;
  if (task.kind !== 'critical_path') return false;
  const children = tasks.filter(candidate => candidate.parent_task_id === task.id);
  return children.length > 0 && children.every(isDone);
}

function parseTime(value: string | null | undefined) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function getCountableGoalTasks(tasks: DBTask[]) {
  const parentIds = new Set(tasks.map(task => task.parent_task_id).filter(Boolean));
  return tasks.filter(task => !parentIds.has(task.id));
}

// ─── Closest upcoming due date across all incomplete tasks ────────────────────

export type DueUrgency = 'overdue' | 'today' | 'tomorrow' | 'soon' | null;

export interface ClosestDue {
  task: DBTask;
  urgency: DueUrgency;
  daysUntil: number; // negative = overdue
}

function parseDueDate(due: string): Date {
  return new Date(due.slice(0, 10) + 'T23:59:59');
}

export function getClosestDueTask(tasks: DBTask[], now = new Date()): ClosestDue | null {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const candidates = tasks
    .filter(t => !isEffectivelyDone(t, tasks) && t.due_date)
    .map(t => {
      const due = parseDueDate(t.due_date!);
      const daysUntil = Math.round((due.getTime() - today.getTime()) / 86_400_000);
      return { task: t, daysUntil };
    })
    .filter(({ daysUntil }) => daysUntil <= 7) // only surface within a week
    .sort((a, b) => a.daysUntil - b.daysUntil);

  if (candidates.length === 0) return null;

  const { task, daysUntil } = candidates[0];
  const urgency: DueUrgency =
    daysUntil < 0  ? 'overdue'   :
    daysUntil === 0 ? 'today'    :
    daysUntil === 1 ? 'tomorrow' :
    'soon';

  return { task, urgency, daysUntil };
}

export function normalizeTaskWeight(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function calculateGoalTaskMetrics(tasks: DBTask[], now = new Date()): GoalTaskMetrics {
  // X/Y done: ALL non-milestone tasks, only explicitly-checked ones count as done.
  // A task is NEVER counted as done through its children — the user must check it themselves.
  const nonMilestoneTasks = tasks.filter(t => t.kind !== 'critical_path');
  const totalTasks        = nonMilestoneTasks.length;
  const completedTasks    = nonMilestoneTasks.filter(isDone).length;
  const remainingTasks    = Math.max(0, totalTasks - completedTasks);

  // Weight priority for ring %: explicit weight_percent → all-tasks time → equal count
  // (Explicit weights still check leaf tasks so the same tasks as before drive weighting)
  const countableTasks = getCountableGoalTasks(tasks);
  const explicitWeights = countableTasks.map(task => normalizeTaskWeight(task.weight_percent));
  const usesExplicitWeights = explicitWeights.some(weight => weight !== null);

  let progress: number;
  let totalWeight: number;
  let completedWeight: number;

  if (usesExplicitWeights) {
    const explicitTotal = explicitWeights.reduce((sum, w) => sum + (w ?? 0), 0);
    const unsetCount    = explicitWeights.filter(w => w === null).length;
    const fallback      = unsetCount > 0 ? Math.max(0, 100 - explicitTotal) / unsetCount : 0;
    const taskWeights   = countableTasks.map((_, i) => explicitWeights[i] ?? fallback);
    totalWeight     = taskWeights.reduce((sum, w) => sum + w, 0);
    completedWeight = countableTasks.reduce(
      (sum, task, index) => sum + (isDone(task) ? taskWeights[index] : 0), 0,
    );
    progress = totalWeight === 0 ? 0 : Math.round((completedWeight / totalWeight) * 100);
  } else {
    // Time-accurate ring: each task's estimated_minutes is its own work at that level
    // (additive overhead model — no double-counting across the hierarchy).
    // Using ALL non-milestone timed tasks gives the true total without double-counting.
    const allTimed    = tasks.filter(t => t.kind !== 'critical_path' && (t.estimated_minutes ?? 0) > 0);
    const totalMinutes = allTimed.reduce((s, t) => s + t.estimated_minutes!, 0);
    const doneMinutes  = allTimed.filter(isDone).reduce((s, t) => s + t.estimated_minutes!, 0);

    if (totalMinutes > 0) {
      const raw = (doneMinutes / totalMinutes) * 100;
      // Show at least 1% when work has been done so the ring isn't stuck at zero
      progress = doneMinutes > 0 && raw < 1 ? 1 : Math.round(raw);
      totalWeight     = 100;
      completedWeight = progress;
    } else {
      const equal = 100 / Math.max(1, totalTasks);
      totalWeight     = 100;
      completedWeight = completedTasks * equal;
      progress = Math.round((completedTasks / Math.max(1, totalTasks)) * 100);
    }
  }

  // A goal may only be 100% when every task is complete. Milestone cards derive
  // completion from their direct children, so use that same rule here instead
  // of leaving an otherwise-finished goal stuck at 99%.
  if (tasks.some(task => !isEffectivelyDone(task, tasks))) {
    progress = Math.min(progress, 99);
  }

  const recentCutoff = now.getTime() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentlyTouched = tasks.filter(task => parseTime(task.updated_at) >= recentCutoff).length;
  const recentlyCompleted = tasks.filter(task => isDone(task) && parseTime(task.updated_at) >= recentCutoff).length;
  const activeTasks = tasks.filter(task => task.status === 'in_progress' && !isDone(task)).length;
  const activityScore = recentlyTouched + recentlyCompleted + activeTasks * 2;

  const activityLevel =
    totalTasks === 0 ? 1 :
    progress === 100 ? 5 :
    activityScore >= 8 ? 5 :
    activityScore >= 5 ? 4 :
    activityScore >= 3 ? 3 :
    activityScore >= 1 ? 2 :
    1;

  return {
    totalTasks,
    completedTasks,
    remainingTasks,
    progress,
    activityLevel,
    totalWeight,
    completedWeight,
    usesExplicitWeights,
  };
}

// ─── Dynamic health status ───────────────────────────────────────────────────
// Derives Safe/Watch/Risky from deadline proximity and hours remaining.
// Never use goal.status from the DB for display — call this instead.
export function computeGoalStatus(
  goal: DBGoal,
  tasks: DBTask[],
  now = new Date()
): 'Safe' | 'Watch' | 'Risky' {
  const metrics = calculateGoalTaskMetrics(tasks, now);
  const progress = metrics.progress; // 0–100

  if (progress === 100) return 'Safe';

  // Remaining estimated minutes across incomplete tasks
  const remainingMinutes = tasks
    .filter(t => !isEffectivelyDone(t, tasks))
    .reduce((sum, t) => sum + (t.estimated_minutes ?? 0), 0);

  // Parse deadline — handle ISO date strings; ignore quarter strings like "Q3 2024"
  const deadlineDate = goal.deadline
    ? (() => { const d = new Date(goal.deadline.slice(0, 10) + 'T23:59:59'); return isNaN(d.getTime()) ? null : d; })()
    : null;

  const taskDeadlineDays = tasks
    .filter(task => !isEffectivelyDone(task, tasks))
    .flatMap(task => [task.hard_deadline, task.due_date, task.target_date])
    .filter((value): value is string => Boolean(value))
    .map(value => new Date(value.slice(0, 10) + 'T23:59:59'))
    .filter(date => !Number.isNaN(date.getTime()))
    .map(date => (date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  // An unfinished task with any overdue deadline makes the goal risky. Any
  // deadline due within the next week puts it on Watch, even if the goal itself
  // has no deadline or would otherwise look Safe.
  if (taskDeadlineDays.some(days => days < 0)) return 'Risky';
  if (taskDeadlineDays.some(days => days <= 7)) return 'Watch';

  if (!deadlineDate) {
    // No parseable deadline — base purely on progress
    if (progress >= 60) return 'Safe';
    if (progress >= 20) return 'Watch';
    return 'Watch';
  }

  const daysLeft = (deadlineDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  if (daysLeft < 0) return 'Risky'; // overdue

  // How much time has elapsed as a fraction of total goal lifespan
  const created = new Date(goal.created_at);
  const totalDays = Math.max(1, (deadlineDate.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));
  const elapsedFraction = Math.min(1, Math.max(0, (totalDays - daysLeft) / totalDays));
  const expectedProgress = elapsedFraction * 100;
  const progressGap = expectedProgress - progress; // positive = behind schedule

  // Hours pressure: remaining work vs remaining calendar time (4 productive hrs/day)
  const hoursLeft = daysLeft * 4;
  const hoursPressure = remainingMinutes > 0 && hoursLeft > 0 ? remainingMinutes / 60 / hoursLeft : 0;

  if (progressGap > 40 || daysLeft < 3 || (daysLeft < 7 && progress < 50) || hoursPressure > 1.5) {
    return 'Risky';
  }
  if (progressGap > 20 || (daysLeft < 14 && progress < 30) || hoursPressure > 0.75) {
    return 'Watch';
  }
  return 'Safe';
}
