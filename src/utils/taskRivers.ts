import type { DBEdge, DBTask } from '../db/schema';

function byPosition(a: DBTask, b: DBTask) {
  return (a.position ?? 0) - (b.position ?? 0) || a.title.localeCompare(b.title);
}

/**
 * Groups tasks into dependency rivers and orders every river prerequisite-first.
 * Database position is only a stable tie-breaker for tasks at the same level.
 */
export function buildTaskRivers(tasks: DBTask[], dependencies: DBEdge[]): DBTask[][] {
  const sortedTasks = [...tasks].sort(byPosition);
  const taskById = new Map(sortedTasks.map(task => [task.id, task]));
  const taskIds = new Set(taskById.keys());
  const edges = dependencies.filter(edge =>
    edge.relationship === 'blocks' && taskIds.has(edge.source_id) && taskIds.has(edge.target_id)
  );

  const neighbors = new Map(sortedTasks.map(task => [task.id, new Set<string>()]));
  for (const edge of edges) {
    neighbors.get(edge.source_id)?.add(edge.target_id);
    neighbors.get(edge.target_id)?.add(edge.source_id);
  }

  const seen = new Set<string>();
  const rivers: DBTask[][] = [];
  for (const task of sortedTasks) {
    if (seen.has(task.id)) continue;
    const componentIds: string[] = [];
    const queue = [task.id];
    seen.add(task.id);
    while (queue.length) {
      const id = queue.shift()!;
      componentIds.push(id);
      for (const neighbor of neighbors.get(id) ?? []) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    const componentSet = new Set(componentIds);
    const incoming = new Map(componentIds.map(id => [id, 0]));
    const outgoing = new Map(componentIds.map(id => [id, new Set<string>()]));
    for (const edge of edges) {
      if (!componentSet.has(edge.source_id) || !componentSet.has(edge.target_id)) continue;
      if (!outgoing.get(edge.source_id)?.has(edge.target_id)) {
        outgoing.get(edge.source_id)?.add(edge.target_id);
        incoming.set(edge.target_id, (incoming.get(edge.target_id) ?? 0) + 1);
      }
    }

    const ready = componentIds.filter(id => incoming.get(id) === 0)
      .map(id => taskById.get(id)!)
      .sort(byPosition);
    const ordered: DBTask[] = [];
    while (ready.length) {
      const current = ready.shift()!;
      ordered.push(current);
      for (const nextId of outgoing.get(current.id) ?? []) {
        const nextIncoming = (incoming.get(nextId) ?? 1) - 1;
        incoming.set(nextId, nextIncoming);
        if (nextIncoming === 0) {
          ready.push(taskById.get(nextId)!);
          ready.sort(byPosition);
        }
      }
    }

    // Existing bad data may contain a cycle. Keep those tasks visible and stable.
    const orderedIds = new Set(ordered.map(item => item.id));
    ordered.push(...componentIds.filter(id => !orderedIds.has(id)).map(id => taskById.get(id)!).sort(byPosition));
    rivers.push(ordered);
  }

  return rivers;
}

/** True when adding blockerId -> taskId would close a dependency cycle. */
export function wouldCreateTaskRiverCycle(taskId: string, blockerId: string, dependencies: DBEdge[]): boolean {
  if (taskId === blockerId) return true;
  const outgoing = new Map<string, Set<string>>();
  for (const edge of dependencies) {
    if (edge.relationship !== 'blocks') continue;
    if (!outgoing.has(edge.source_id)) outgoing.set(edge.source_id, new Set());
    outgoing.get(edge.source_id)!.add(edge.target_id);
  }

  const queue = [taskId];
  const seen = new Set(queue);
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of outgoing.get(current) ?? []) {
      if (next === blockerId) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
