export type TimelineField = 'start_date' | 'hard_deadline' | 'target_date' | 'due_date' | 'deadline';
export type TimelineScope = 'task' | 'parent_task' | 'milestone' | 'goal';

export interface TimelineSource {
  scope: TimelineScope;
  field: TimelineField;
  entity_id: string;
}

export interface TaskTimelineResolution {
  start_date: string | null;
  due_date: string | null;
  start_source: TimelineSource | null;
  due_source: TimelineSource | null;
}

export interface TaskTimelineRow {
  id: string;
  parent_task_id: string | null;
  goal_id?: string | null;
  milestone_id?: string | null;
  start_date?: string | null;
  due_date?: string | null;
  target_date?: string | null;
  hard_deadline?: string | null;
}

export interface GoalTimelineRow {
  id: string;
  start_date?: string | null;
  target_date?: string | null;
  hard_deadline?: string | null;
  /** Legacy goal deadline. It is used only when it is a real ISO date. */
  deadline?: string | null;
}

export interface MilestoneTimelineRow {
  id: string;
  start_date?: string | null;
  due_date?: string | null;
  hard_deadline?: string | null;
}

const isISODate = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * Resolve the timeline that actually constrains an executable task.
 *
 * Every enclosing scope constrains the task. The effective start is the latest
 * applicable start (work cannot begin before any enclosing plan starts), and
 * the effective due date is the earliest applicable cutoff (a child cannot run
 * past its parent, milestone, or goal). Within one scope, the canonical hard
 * deadline -> target -> legacy due-date precedence still applies.
 */
export function buildTaskTimelineResolver(
  tasks: TaskTimelineRow[],
  goals: GoalTimelineRow[] = [],
  milestones: MilestoneTimelineRow[] = [],
) {
  const taskById = new Map(tasks.map(row => [row.id, row]));
  const goalById = new Map(goals.map(row => [row.id, row]));
  const milestoneById = new Map(milestones.map(row => [row.id, row]));
  const memo = new Map<string, TaskTimelineResolution>();

  return function resolveTaskTimeline(taskLike: Partial<TaskTimelineRow> & { id?: unknown }): TaskTimelineResolution {
    const id = String(taskLike.id ?? '');
    if (id && memo.has(id)) return memo.get(id)!;

    const stored = id ? taskById.get(id) : undefined;
    const task: TaskTimelineRow = {
      id,
      parent_task_id: taskLike.parent_task_id ?? stored?.parent_task_id ?? null,
      goal_id: taskLike.goal_id ?? stored?.goal_id ?? null,
      milestone_id: taskLike.milestone_id ?? stored?.milestone_id ?? null,
      start_date: taskLike.start_date ?? stored?.start_date ?? null,
      due_date: taskLike.due_date ?? stored?.due_date ?? null,
      target_date: taskLike.target_date ?? stored?.target_date ?? null,
      hard_deadline: taskLike.hard_deadline ?? stored?.hard_deadline ?? null,
    };

    const chain: TaskTimelineRow[] = [task];
    const seen = new Set<string>(id ? [id] : []);
    let parentId = task.parent_task_id;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = taskById.get(parentId);
      if (!parent) break;
      chain.push(parent);
      parentId = parent.parent_task_id;
    }

    const startCandidates: Array<{ date: string; source: TimelineSource }> = [];
    const dueCandidates: Array<{ date: string; source: TimelineSource }> = [];
    for (let index = 0; index < chain.length; index += 1) {
      const row = chain[index];
      const scope: TimelineScope = index === 0 ? 'task' : 'parent_task';
      if (isISODate(row.start_date)) {
        startCandidates.push({
          date: row.start_date,
          source: { scope, field: 'start_date', entity_id: row.id },
        });
      }
      if (isISODate(row.hard_deadline)) {
        dueCandidates.push({ date: row.hard_deadline, source: { scope, field: 'hard_deadline', entity_id: row.id } });
      } else if (isISODate(row.target_date)) {
        dueCandidates.push({ date: row.target_date, source: { scope, field: 'target_date', entity_id: row.id } });
      } else if (isISODate(row.due_date)) {
        dueCandidates.push({ date: row.due_date, source: { scope, field: 'due_date', entity_id: row.id } });
      }
    }

    const inheritedMilestoneId = chain.find(row => row.milestone_id)?.milestone_id ?? null;
    const milestone = inheritedMilestoneId ? milestoneById.get(inheritedMilestoneId) : undefined;
    if (milestone && isISODate(milestone.start_date)) {
      startCandidates.push({
        date: milestone.start_date,
        source: { scope: 'milestone', field: 'start_date', entity_id: milestone.id },
      });
    }
    if (milestone) {
      if (isISODate(milestone.hard_deadline)) {
        dueCandidates.push({
          date: milestone.hard_deadline,
          source: { scope: 'milestone', field: 'hard_deadline', entity_id: milestone.id },
        });
      } else if (isISODate(milestone.due_date)) {
        dueCandidates.push({
          date: milestone.due_date,
          source: { scope: 'milestone', field: 'due_date', entity_id: milestone.id },
        });
      }
    }

    const inheritedGoalId = chain.find(row => row.goal_id)?.goal_id ?? null;
    const goal = inheritedGoalId ? goalById.get(inheritedGoalId) : undefined;
    if (goal && isISODate(goal.start_date)) {
      startCandidates.push({ date: goal.start_date, source: { scope: 'goal', field: 'start_date', entity_id: goal.id } });
    }
    if (goal) {
      if (isISODate(goal.hard_deadline)) {
        dueCandidates.push({ date: goal.hard_deadline, source: { scope: 'goal', field: 'hard_deadline', entity_id: goal.id } });
      } else if (isISODate(goal.target_date)) {
        dueCandidates.push({ date: goal.target_date, source: { scope: 'goal', field: 'target_date', entity_id: goal.id } });
      } else if (isISODate(goal.deadline)) {
        dueCandidates.push({ date: goal.deadline, source: { scope: 'goal', field: 'deadline', entity_id: goal.id } });
      }
    }

    const effectiveStart = startCandidates.sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
    const effectiveDue = dueCandidates.sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
    const result = {
      start_date: effectiveStart?.date ?? null,
      due_date: effectiveDue?.date ?? null,
      start_source: effectiveStart?.source ?? null,
      due_source: effectiveDue?.source ?? null,
    };
    if (id) memo.set(id, result);
    return result;
  };
}
