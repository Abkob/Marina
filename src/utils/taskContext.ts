import type { DBGoal, DBTask } from '../db/schema';

/** Compact context for tasks displayed outside their tree. Never substitute IDs for names. */
export function taskContextMap(tasks: readonly DBTask[], goals: readonly DBGoal[] = []): Map<string, string> {
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const goalById = new Map(goals.map(goal => [goal.id, goal.title]));
  return new Map(tasks.map(task => {
    const parent = task.parent_task_id && task.parent_task_id !== task.id ? taskById.get(task.parent_task_id) : undefined;
    const goal = goalById.get(task.goal_id ?? parent?.goal_id ?? '');
    // Put the immediate parent first so a long goal cannot truncate the distinguishing name.
    const parts = [parent?.title, goal].filter((part): part is string => Boolean(part));
    return [task.id, parts.filter((part, index) => index === 0 || part !== parts[index - 1]).join(' · ')];
  }));
}
