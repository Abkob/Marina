import type { buildWorkHierarchy } from './workHierarchy.js';

/** Parent prerequisites apply to their work items; dependents wait for the whole subtree. */
export function hierarchyDependencies(
  hierarchy: ReturnType<typeof buildWorkHierarchy>,
  edges: Array<{ blocker_id: string; task_id: string }>,
  limit = 100_000,
): Map<string, string[]> {
  const result = new Map<string, Set<string>>();
  const seenEdges = new Set<string>();
  let expanded = 0;
  const subtree = (id: string) => {
    const queue = [id]; const seen = new Set<string>();
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      if (seen.has(current)) continue;
      seen.add(current);
      for (const child of hierarchy.children.get(current) ?? []) queue.push(child);
    }
    return [...seen];
  };
  for (const edge of edges) {
    const edgeKey = JSON.stringify([edge.blocker_id, edge.task_id]);
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    const blockers = subtree(edge.blocker_id).filter(id => {
      const row = hierarchy.summaries.get(id);
      return !row || row.issues.length > 0 || row.executable;
    });
    // Zero forecast is not evidence of completion. Keep an unresolved blocker
    // when no executable item exists but the prerequisite remains unfinished.
    const root = hierarchy.tasks.get(edge.blocker_id);
    if (!blockers.length && root && root.completed !== true && root.status !== 'done') blockers.push(root.id);
    for (const id of subtree(edge.task_id)) {
      const set = result.get(id) ?? new Set<string>(); result.set(id, set);
      for (const blocker of blockers) {
        if (set.has(blocker)) continue;
        if (++expanded > limit) {
          // Bounded failure: never silently drop a prerequisite to make work fit.
          return new Map([...hierarchy.tasks.keys()].map(taskId => [taskId, ['unresolved:hierarchy-dependency-limit']]));
        }
        set.add(blocker);
      }
    }
  }
  return new Map([...result].map(([id, set]) => [id, [...set].sort()]));
}
