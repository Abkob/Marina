export const WORKSPACE_SECTIONS = ['tasks', 'capacity', 'attention', 'details', 'journal', 'resources'] as const;
export type WorkspaceSection = typeof WORKSPACE_SECTIONS[number];

interface HierarchyTask extends Record<string, unknown> {
  id: string;
  children: HierarchyTask[];
}
interface HierarchyGoal extends Record<string, unknown> {
  id: string;
  tasks: HierarchyTask[];
  milestones: Record<string, unknown>[];
}

/** Adjacency graph: each task once, real database IDs join all other views.
 * Do not infer parent links from sort order or assign a synthetic importance score.
 */
export function workspaceGraph(hierarchy: HierarchyGoal[]) {
  const tasks: Record<string, unknown>[] = [];
  const milestones: Record<string, unknown>[] = [];
  const visit = (node: HierarchyTask, goalId: string | null, parentId: string | null) => {
    const { children, ...facts } = node;
    tasks.push({ ...facts, goal_id: goalId, parent_task_id: parentId, ...('parent_task_id' in facts ? { parent_task_id: facts.parent_task_id } : {}) });
    children.forEach(child => visit(child, goalId, node.id));
  };
  const goals = hierarchy.map(({ tasks: roots, milestones: goalMilestones, ...goal }) => {
    const goalId = goal.id === 'unassigned' ? null : goal.id;
    roots.forEach(task => visit(task, goalId, null));
    goalMilestones.forEach(milestone => milestones.push({ ...milestone, goal_id: goalId }));
    return goal;
  });
  return { goals, milestones, tasks };
}

const fields: Record<WorkspaceSection, string[]> = {
  tasks: ['graph'],
  capacity: ['schedule_prefs', 'scheduler_result', 'schedule_horizon_next_14_days', 'meetings_next_14_days', 'schedule_overrides'],
  attention: ['attention_queue', 'planning_focus'],
  details: ['targeted_task_context'],
  journal: ['recent_journal'],
  resources: ['resources'],
};

export function selectWorkspaceSections(context: Record<string, unknown>, sections: WorkspaceSection[] = ['tasks', 'capacity', 'attention']) {
  return {
    today: context.today,
    planning_coverage: context.planning_coverage,
    retrieval_meta: context.retrieval_meta,
    included_sections: sections,
    available_sections: WORKSPACE_SECTIONS,
    ...Object.fromEntries([...new Set(sections.flatMap(section => fields[section]))].map(key => [key, context[key]])),
  };
}
