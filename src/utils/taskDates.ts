import type { DBTask } from '../db/schema';

export function getEffectiveTaskDueDate(task: DBTask, allTasks: DBTask[]): string | null {
  if (task.due_date) return task.due_date;
  if (!task.parent_task_id) return null;

  const byId = new Map(allTasks.map(t => [t.id, t]));
  const seen = new Set<string>();
  let parentId: string | null = task.parent_task_id;

  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return null;
    if (parent.due_date) return parent.due_date;
    parentId = parent.parent_task_id;
  }

  return null;
}

export function getInheritedTaskDueDate(task: DBTask, allTasks: DBTask[]): string | null {
  if (task.due_date || !task.parent_task_id) return null;
  return getEffectiveTaskDueDate(task, allTasks);
}

export function taskUsesInheritedDueDate(task: DBTask, allTasks: DBTask[]): boolean {
  return getInheritedTaskDueDate(task, allTasks) !== null;
}

function dateOnly(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}

function getDeadlineOwner(task: DBTask, allTasks: DBTask[]): DBTask | null {
  const byId = new Map(allTasks.map(candidate => [candidate.id, candidate]));
  const seen = new Set<string>();
  let current: DBTask | undefined = task;

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.due_date) return current;
    current = current.parent_task_id ? byId.get(current.parent_task_id) : undefined;
  }

  return null;
}

function getDescendants(taskId: string, allTasks: DBTask[]): DBTask[] {
  const result: DBTask[] = [];
  const queue = [taskId];
  const seen = new Set(queue);
  while (queue.length) {
    const parentId = queue.shift()!;
    for (const task of allTasks) {
      if (task.parent_task_id !== parentId || seen.has(task.id)) continue;
      seen.add(task.id);
      result.push(task);
      queue.push(task.id);
    }
  }
  return result;
}

export interface DescendantTaskDeadlineSummary {
  earliest: string;
  latest: string;
  taskCount: number;
}

/**
 * Summarizes unfinished descendant deadlines without assigning one to the
 * parent. The earliest cutoff drives urgency; the latest is the last known
 * child cutoff for rollup displays.
 */
export function getDescendantTaskDeadlineSummary(
  taskId: string,
  allTasks: DBTask[],
): DescendantTaskDeadlineSummary | null {
  const dated = getDescendants(taskId, allTasks)
    .filter(descendant => !descendant.completed && descendant.status !== 'done')
    .map(descendant => ({
      id: descendant.id,
      date: getEffectiveTaskDueDate(descendant, allTasks),
    }))
    .filter((item): item is { id: string; date: string } => Boolean(item.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!dated.length) return null;
  return {
    earliest: dated[0].date,
    latest: dated[dated.length - 1].date,
    taskCount: new Set(dated.map(item => item.id)).size,
  };
}

/** Returns notification-ready copy when a proposed task deadline breaks its hierarchy. */
export function getTaskDeadlineViolation(taskId: string, proposedDate: string | null, allTasks: DBTask[]): string | null {
  const task = allTasks.find(candidate => candidate.id === taskId);
  if (!task) return null;

  const parent = task.parent_task_id ? allTasks.find(candidate => candidate.id === task.parent_task_id) : null;
  const deadlineOwner = parent ? getDeadlineOwner(parent, allTasks) : null;
  const parentDeadline = dateOnly(deadlineOwner?.due_date);
  const candidateDeadline = dateOnly(proposedDate);

  if (candidateDeadline && parentDeadline && candidateDeadline > parentDeadline) {
    return `Child task deadline must be on or before parent task "${deadlineOwner?.title}" deadline (${parentDeadline}).`;
  }

  const effectiveDeadline = candidateDeadline ?? parentDeadline;
  if (!effectiveDeadline) return null;
  const lateChild = getDescendants(taskId, allTasks)
    .filter(child => dateOnly(child.due_date) && dateOnly(child.due_date)! > effectiveDeadline)
    .sort((a, b) => dateOnly(b.due_date)!.localeCompare(dateOnly(a.due_date)!))[0];

  return lateChild
    ? `Parent task deadline cannot be ${effectiveDeadline}: child task "${lateChild.title}" is due ${dateOnly(lateChild.due_date)}. Move the child deadline first.`
    : null;
}
