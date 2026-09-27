import type { DBTask } from '../db/schema';

const MAX_TASK_MINUTES = 60 * 1000;

export function normalizeTaskMinutes(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.min(MAX_TASK_MINUTES, Math.max(0, Math.round(value)));
}

export function parseTaskTimeInput(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  // (?![a-zA-Z]) prevents matching letters that are part of a longer word (e.g. "min" in "mining")
  // but allows unit letters immediately followed by digits (e.g. "1h30m")
  const unitMatches = [...normalized.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m)(?![a-zA-Z])/g)];
  if (unitMatches.length > 0) {
    const total = unitMatches.reduce((sum, match) => {
      const amount = Number(match[1]);
      const unit = match[2];
      if (Number.isNaN(amount)) return sum;
      return sum + (unit.startsWith('h') ? amount * 60 : amount);
    }, 0);
    return normalizeTaskMinutes(total);
  }

  const plainNumber = Number(normalized.replace(/[^\d.]/g, ''));
  if (Number.isNaN(plainNumber) || plainNumber <= 0) return null;

  // Plain small numbers usually mean hours; larger plain numbers usually mean minutes.
  return normalizeTaskMinutes(plainNumber <= 12 ? plainNumber * 60 : plainNumber);
}

export function formatTaskTime(minutes: number | null | undefined): string {
  const normalized = normalizeTaskMinutes(minutes);
  if (normalized === null || normalized === 0) return 'Time';
  if (normalized < 60) return `${normalized}m`;

  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

export function formatTaskTimeLong(minutes: number): string {
  const normalized = normalizeTaskMinutes(minutes) ?? 0;
  if (normalized < 60) return `${normalized} min`;

  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  if (mins === 0) return `${hours} hr${hours === 1 ? '' : 's'}`;
  return `${hours} hr${hours === 1 ? '' : 's'} ${mins} min`;
}

export function getTaskEstimatedMinutes(task: DBTask): number | null {
  const explicit = normalizeTaskMinutes(task.estimated_minutes);
  if (explicit !== null && explicit > 0) return explicit;
  return parseTaskTimeInput(task.estimated_duration);
}

export interface RolledUpTime {
  /** Total minutes after child time inclusion rules are applied. */
  minutes: number | null;
  /** True when any children contributed to the total. */
  isRollup: boolean;
  /** Own explicit time on this task. */
  ownMinutes: number | null;
  /** Raw sum of direct children's totals (null when no children have times). */
  childrenSum: number | null;
  /** Direct child totals that are included inside this task's own estimate. */
  includedChildrenSum?: number | null;
  /** Direct child totals that add extra time on top of this task's own estimate. */
  extraChildrenSum?: number | null;
}

export interface RolledUpActualTime {
  minutes: number;
  ownMinutes: number;
  childrenMinutes: number;
  contributingChildren: number;
}

/** Actual time is additive: every session belongs to one task and rolls up to its ancestors. */
export function getRolledUpActualTime(task: DBTask, allTasks: DBTask[]): RolledUpActualTime {
  const ownMinutes = normalizeTaskMinutes(task.actual_minutes) ?? 0;
  const directChildren = allTasks.filter(t => t.parent_task_id === task.id);
  let childrenMinutes = 0;
  let contributingChildren = 0;

  for (const child of directChildren) {
    const childActual = getRolledUpActualTime(child, allTasks);
    childrenMinutes += childActual.minutes;
    contributingChildren += childActual.contributingChildren;
    if ((normalizeTaskMinutes(child.actual_minutes) ?? 0) > 0) contributingChildren += 1;
  }

  return { minutes: ownMinutes + childrenMinutes, ownMinutes, childrenMinutes, contributingChildren };
}

function getLeafDescendants(taskId: string, allTasks: DBTask[]): DBTask[] {
  const direct = allTasks.filter(t => t.parent_task_id === taskId);
  if (direct.length === 0) return [];
  const result: DBTask[] = [];
  for (const child of direct) {
    const childLeaves = getLeafDescendants(child.id, allTasks);
    if (childLeaves.length === 0) result.push(child);
    else result.push(...childLeaves);
  }
  return result;
}

/**
 * Returns a 0–1 completion ratio for a task based on its leaf descendants.
 * If the task itself is marked completed/done, returns 1 immediately.
 * If it has no descendants, returns 0 (incomplete) or 1 (completed).
 */
export function getTaskLeafProgress(task: DBTask, allTasks: DBTask[]): number {
  if (task.completed || task.status === 'done') return 1;
  const leaves = getLeafDescendants(task.id, allTasks);
  if (leaves.length === 0) return 0;
  const done = leaves.filter(l => l.completed || l.status === 'done').length;
  return done / leaves.length;
}

export interface TaskTimeProgress {
  /** 0–1 completion ratio, time-weighted when leaf estimates exist, count-based otherwise. */
  ratio: number;
  /** Sum of estimated_minutes for incomplete leaves (null when no incomplete leaf has a time). */
  remainingMinutes: number | null;
  /** Sum of actual_minutes logged on completed leaves (0 when nothing logged). */
  spentMinutes: number;
  /** True when at least one leaf has time data (so ratio is time-weighted, not count-based). */
  isTimeWeighted: boolean;
}

/**
 * Returns accurate time-based progress for a task.
 *
 * Unlike getTaskLeafProgress (which counts tasks), this weights each leaf
 * by its estimated time so that completing a 3h task moves the bar more
 * than completing a 30m task. remainingMinutes is the direct sum of
 * incomplete leaves' estimates — not derived from the ratio.
 */
export function getTaskTimeProgress(task: DBTask, allTasks: DBTask[]): TaskTimeProgress {
  const isDone = task.completed || task.status === 'done';
  if (isDone) {
    const est = getTaskEstimatedMinutes(task);
    return {
      ratio: 1,
      remainingMinutes: 0,
      spentMinutes: task.actual_minutes ?? 0,
      isTimeWeighted: est !== null || (task.actual_minutes ?? 0) > 0,
    };
  }

  const leaves = getLeafDescendants(task.id, allTasks);

  // Leaf node with no children
  if (leaves.length === 0) {
    return {
      ratio: 0,
      remainingMinutes: getTaskEstimatedMinutes(task),
      spentMinutes: task.actual_minutes ?? 0,
      isTimeWeighted: getTaskEstimatedMinutes(task) !== null,
    };
  }

  const doneleaves    = leaves.filter(l => l.completed || l.status === 'done');
  const pendingLeaves = leaves.filter(l => !l.completed && l.status !== 'done');

  const doneEst    = doneleaves.reduce((s, l)    => s + (getTaskEstimatedMinutes(l) ?? 0), 0);
  const pendingEst = pendingLeaves.reduce((s, l) => s + (getTaskEstimatedMinutes(l) ?? 0), 0);
  const totalEst   = doneEst + pendingEst;

  const spentMinutes = doneleaves.reduce((s, l) => s + (l.actual_minutes ?? 0), 0);

  const isTimeWeighted = totalEst > 0;

  const ratio = isTimeWeighted
    ? doneEst / totalEst
    : leaves.length > 0 ? doneleaves.length / leaves.length : 0;

  const remainingMinutes = pendingLeaves.some(l => getTaskEstimatedMinutes(l) !== null)
    ? pendingEst
    : null;

  return { ratio, remainingMinutes, spentMinutes, isTimeWeighted };
}

/**
 * Mixed parent estimate model:
 *   - Leaf (no children): use own explicit time.
 *   - Parent with timed children but no own time: total = all children.
 *   - Parent with own time: each child can either add extra time, or sit inside
 *     the parent's rough estimate. The child's time_rollup_mode controls that
 *     relationship to its parent.
 */
export function getRolledUpTime(task: DBTask, allTasks: DBTask[]): RolledUpTime {
  const directChildren = allTasks.filter(t => t.parent_task_id === task.id);
  const ownMinutes = getTaskEstimatedMinutes(task);

  if (directChildren.length === 0) {
    return { minutes: ownMinutes, isRollup: false, ownMinutes, childrenSum: null };
  }

  let includedSum = 0;
  let extraSum = 0;
  let anyChildHasTime = false;

  for (const child of directChildren) {
    const childResult = getRolledUpTime(child, allTasks);
    if (childResult.minutes !== null) {
      if (child.time_rollup_mode === 'inclusive') {
        includedSum += childResult.minutes;
      } else {
        extraSum += childResult.minutes;
      }
      anyChildHasTime = true;
    }
  }

  if (!anyChildHasTime) {
    return { minutes: ownMinutes, isRollup: false, ownMinutes, childrenSum: null };
  }

  const childrenSum = includedSum + extraSum;
  const total = ownMinutes !== null
    ? Math.max(ownMinutes, includedSum) + extraSum
    : childrenSum;

  return {
    minutes: total,
    isRollup: true,
    ownMinutes,
    childrenSum,
    includedChildrenSum: includedSum > 0 ? includedSum : null,
    extraChildrenSum: extraSum > 0 ? extraSum : null,
  };
}
