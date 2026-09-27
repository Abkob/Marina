import type { PlanWindowParams } from './planLayout.js';

/** Scope calendar calculations to the exact requested tasks and descendants. */
export function resolvePlanTaskScope(
  params: Pick<PlanWindowParams, 'task_id' | 'task_ids'>,
  tasks: Map<string, { parent_task_id?: unknown }>,
): Set<string> | null {
  const requested = [...new Set([...(params.task_ids ?? []), ...(params.task_id ? [params.task_id] : [])])];
  if (!requested.length) return null;
  for (const id of requested) if (!tasks.has(id)) {
    throw new Error(`Task ${id} is unavailable. Read the current task details; no substitute was selected.`);
  }
  const scope = new Set(requested);
  let added = true;
  while (added) {
    added = false;
    for (const [id, task] of tasks) {
      if (!scope.has(id) && typeof task.parent_task_id === 'string' && scope.has(task.parent_task_id)) {
        scope.add(id); added = true;
      }
    }
  }
  return scope;
}
