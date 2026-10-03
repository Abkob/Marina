import { accountWork } from '../../shared/workAccounting';
import { buildWorkHierarchy } from '../../shared/workHierarchy';
import type { DBTask } from '../db/schema';
import { formatTaskTime } from './taskTime';

export interface GoalTimeStats {
  spentMinutes: number;
  estimatedRemainingMinutes: number | null;
  adjustedRemainingMinutes: number | null;
  totalEstimatedMinutes: number | null;
  velocityRatio: number | null;
  velocityConfidence: 'none' | 'low' | 'medium' | 'high';
  taskCount: number;
  completedCount: number;
  tasksWithEstimate: number;
  completedWithActual: number;
  unknownRemainingCount: number;
  knownRemainingMinutes: number;
}

/**
 * Computes goal-level time intelligence from ALL tasks (any depth).
 * velocityRatio = actual/estimated for completed tasks with both values.
 * Historical pace is descriptive; it does not automatically rewrite the current forecast.
 */
export function computeGoalTimeStats(tasks: DBTask[]): GoalTimeStats {
  const hierarchy=buildWorkHierarchy(tasks);
  tasks=[...hierarchy.tasks.values()] as DBTask[];
  const completed  = tasks.filter(t => t.completed || t.status === 'done');
  const incomplete = tasks.filter(t => !t.completed && t.status !== 'done');

  // Measured/reported time only: completing an estimate does not log work.
  const spentMinutes = hierarchy.total.logged_minutes;

  // Velocity: only from tasks where we have BOTH actual AND estimated
  const pairedTasks = completed.filter(t => (t.logged_minutes != null || t.actual_minutes != null) && (hierarchy.summaries.get(t.id)?.residual_estimated_minutes ?? 0) > 0);
  const velocityRatio = pairedTasks.length > 0
    ? pairedTasks.reduce((s, t) => s + accountWork(t).logged_minutes, 0) /
      pairedTasks.reduce((s, t) => s + hierarchy.summaries.get(t.id)!.residual_estimated_minutes!, 0)
    : null;

  const velocityConfidence: GoalTimeStats['velocityConfidence'] =
    pairedTasks.length === 0 ? 'none' :
    pairedTasks.length < 3  ? 'low'  :
    pairedTasks.length < 8  ? 'medium' : 'high';

  const unknownRemainingCount = hierarchy.total.unknown_count;
  const knownRemainingMinutes = hierarchy.total.known_remaining_minutes;
  const estimatedRemainingMinutes = hierarchy.total.remaining_minutes;
  // Historical ratios are descriptive, not a calibrated forecast.
  const adjustedRemainingMinutes = estimatedRemainingMinutes;

  // Total estimated across all tasks
  const allWithEst = tasks.filter(t => (t.estimated_minutes ?? 0) > 0);
  const totalEstimatedMinutes = allWithEst.length > 0 ? hierarchy.total.estimated_minutes : null;

  return {
    spentMinutes,
    unknownRemainingCount,
    knownRemainingMinutes,
    estimatedRemainingMinutes,
    adjustedRemainingMinutes,
    totalEstimatedMinutes,
    velocityRatio,
    velocityConfidence,
    taskCount: tasks.length,
    completedCount: completed.length,
    tasksWithEstimate: allWithEst.length,
    completedWithActual: completed.filter(t => t.actual_minutes != null).length,
  };
}

/**
 * Projects the finish date based on remaining adjusted minutes and daily working hours.
 * Returns null if there is no remaining estimate or if the goal is already done.
 */
export function projectedFinishDate(stats: GoalTimeStats, dailyHours = 4): Date | null {
  const remaining = stats.adjustedRemainingMinutes;
  if (remaining == null || remaining <= 0) return null;
  if (stats.completedCount === stats.taskCount && stats.taskCount > 0) return null;

  const daysNeeded = remaining / 60 / dailyHours;
  const result = new Date();
  result.setDate(result.getDate() + Math.ceil(daysNeeded));
  result.setHours(0, 0, 0, 0);
  return result;
}

export function formatProjectedDate(date: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays <= 6) return date.toLocaleDateString('en-US', { weekday: 'long' });
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatVelocity(ratio: number): string {
  if (ratio < 0.85) return `${(ratio * 100).toFixed(0)}% of estimate (ahead)`;
  if (ratio <= 1.15) return 'On pace';
  return `${ratio.toFixed(1)}× estimate (running over)`;
}

export function velocityColor(ratio: number): string {
  if (ratio < 0.85) return 'text-emerald-600';
  if (ratio <= 1.15) return 'text-[#4648d4]';
  if (ratio <= 1.5) return 'text-amber-600';
  return 'text-red-500';
}

export { formatTaskTime };
