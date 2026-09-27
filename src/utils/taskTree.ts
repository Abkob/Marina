import type { DBGoal, DBTask } from '../db/schema';

/**
 * Per-goal collapsible task forest: the one structure used everywhere tasks
 * need to be found (Schedule drawer, Work navigation). Pure — no React.
 */

export interface TaskTreeNode {
  task: DBTask;
  children: TaskTreeNode[];
}

export interface GoalGroup {
  goalId: string | null;
  goalTitle: string;
  nodes: TaskTreeNode[];
  /** Open tasks in this group, all depths. */
  taskCount: number;
}

const byPositionThenTitle = (a: DBTask, b: DBTask) =>
  a.position - b.position || a.title.localeCompare(b.title);

export function isOpenTask(t: DBTask): boolean {
  return !t.completed && t.status !== 'done';
}

/**
 * Work normally hides critical-path scaffolding, but once a critical-path item
 * is explicitly started it becomes actionable work and must be selectable.
 */
export function isWorkSelectableTask(t: DBTask): boolean {
  return t.kind !== 'critical_path' || (t.status === 'in_progress' && !t.completed);
}

/** Hide archived goal branches before scaffolding is removed or children are promoted. */
export function getWorkTasks(tasks: DBTask[], goals: DBGoal[]): DBTask[] {
  const archivedGoals = new Set(goals.filter(goal => goal.archived_at).map(goal => goal.id));
  const hidden = new Set<string>();
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.goal_id && archivedGoals.has(task.goal_id)) hidden.add(task.id);
    if (task.parent_task_id) {
      children.set(task.parent_task_id, [...(children.get(task.parent_task_id) ?? []), task.id]);
    }
  }
  const queue = [...hidden];
  for (let index = 0; index < queue.length; index++) {
    for (const id of children.get(queue[index]) ?? []) {
      if (!hidden.has(id)) { hidden.add(id); queue.push(id); }
    }
  }
  return tasks.filter(task => !hidden.has(task.id) && isWorkSelectableTask(task));
}

/**
 * Group tasks by goal and nest children under their parents. Children whose
 * parent is absent (completed, filtered, or missing) are promoted to the top
 * level of their goal group so nothing silently disappears.
 */
export function buildTaskForest(
  tasks: DBTask[],
  goals: DBGoal[],
  {
    includeCompleted = false,
    includeCriticalPath = false,
  }: { includeCompleted?: boolean; includeCriticalPath?: boolean } = {},
): GoalGroup[] {
  const visible = tasks.filter(t =>
    (includeCriticalPath || t.kind !== 'critical_path') &&
    (includeCompleted || isOpenTask(t)),
  );
  const visibleIds = new Set(visible.map(t => t.id));

  const childrenOf = new Map<string, DBTask[]>();
  const roots: DBTask[] = [];
  for (const t of visible) {
    if (t.parent_task_id && visibleIds.has(t.parent_task_id)) {
      if (!childrenOf.has(t.parent_task_id)) childrenOf.set(t.parent_task_id, []);
      childrenOf.get(t.parent_task_id)!.push(t);
    } else {
      roots.push(t);
    }
  }

  const toNode = (t: DBTask): TaskTreeNode => ({
    task: t,
    children: (childrenOf.get(t.id) ?? []).sort(byPositionThenTitle).map(toNode),
  });

  const goalTitle = new Map(goals.map(g => [g.id, g.title]));
  const groupsById = new Map<string | null, GoalGroup>();
  for (const root of roots.sort(byPositionThenTitle)) {
    const gid = root.goal_id && goalTitle.has(root.goal_id) ? root.goal_id : root.goal_id ?? null;
    const key = gid ?? null;
    if (!groupsById.has(key)) {
      groupsById.set(key, {
        goalId: key,
        goalTitle: (key && goalTitle.get(key)) || 'No goal',
        nodes: [],
        taskCount: 0,
      });
    }
    groupsById.get(key)!.nodes.push(toNode(root));
  }

  const countNodes = (nodes: TaskTreeNode[]): number =>
    nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);

  const groups = [...groupsById.values()];
  for (const g of groups) g.taskCount = countNodes(g.nodes);
  groups.sort((a, b) => {
    if (a.goalId === null) return 1;
    if (b.goalId === null) return -1;
    return a.goalTitle.localeCompare(b.goalTitle);
  });
  return groups;
}

/**
 * Search filter: a node survives when its title matches or any descendant
 * does (ancestors of a match are kept so the path stays visible). A matching
 * goal title keeps its whole group.
 */
export function filterForest(groups: GoalGroup[], query: string): GoalGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;

  const filterNodes = (nodes: TaskTreeNode[]): TaskTreeNode[] =>
    nodes
      .map(n => {
        const kids = filterNodes(n.children);
        const selfMatch = n.task.title.toLowerCase().includes(needle);
        if (!selfMatch && kids.length === 0) return null;
        return { task: n.task, children: selfMatch ? n.children : kids };
      })
      .filter((n): n is TaskTreeNode => n !== null);

  return groups
    .map(g => {
      if (g.goalTitle.toLowerCase().includes(needle)) return g;
      const nodes = filterNodes(g.nodes);
      return { ...g, nodes };
    })
    .filter(g => g.nodes.length > 0);
}
