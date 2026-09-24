import { describe, expect, it } from 'vitest';
import type { DBGoal, DBTask } from '../../db/schema';
import { buildTaskForest, filterForest, getWorkTasks, isWorkSelectableTask } from '../taskTree';

function task(overrides: Partial<DBTask>): DBTask {
  return {
    id: 'task',
    goal_id: 'g1',
    parent_task_id: null,
    title: 'Task',
    description: '',
    status: 'todo',
    priority: 'medium',
    kind: 'manual',
    critical_path_status: null,
    tags_json: '[]',
    due_date: null,
    estimated_duration: null,
    estimated_minutes: null,
    actual_minutes: null,
    weight_percent: null,
    completed: false,
    position: 0,
    created_at: '2026-07-05T00:00:00.000Z',
    updated_at: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

const goals = [
  { id: 'g1', title: 'FYP' } as DBGoal,
  { id: 'g2', title: 'Physics 210' } as DBGoal,
];

describe('archived branches in Work', () => {
  it('hides archived goals and all descendants even through filtered scaffolding and missing goal links', () => {
    const tasks = [
      task({ id: 'root', kind: 'critical_path' }),
      task({ id: 'child', parent_task_id: 'root', goal_id: null }),
      task({ id: 'grandchild', parent_task_id: 'child', goal_id: 'g2' }),
      task({ id: 'visible', goal_id: 'g2' }),
      task({ id: 'standalone', goal_id: null }),
    ];
    const archived = goals.map(goal => goal.id === 'g1' ? { ...goal, archived_at: '2026-09-24' } : goal);
    expect(getWorkTasks(tasks, archived).map(task => task.id)).toEqual(['visible', 'standalone']);
    expect(getWorkTasks(tasks, goals).map(task => task.id)).toEqual(['child', 'grandchild', 'visible', 'standalone']);
  });
  it('keeps paused work and unfinished children of completed parents available', () => {
    const tasks = [task({ id: 'parent', completed: true }), task({ id: 'child', parent_task_id: 'parent' }), task({ id: 'paused', status: 'paused' })];
    expect(getWorkTasks(tasks, goals).map(task => task.id)).toEqual(['parent', 'child', 'paused']);
  });
});

describe('buildTaskForest', () => {
  it('groups tasks under their goals, alphabetically, with goalless last', () => {
    const groups = buildTaskForest([
      task({ id: 'a', goal_id: 'g2', title: 'A' }),
      task({ id: 'b', goal_id: 'g1', title: 'B' }),
      task({ id: 'c', goal_id: null, title: 'C' }),
    ], goals);
    expect(groups.map(g => g.goalTitle)).toEqual(['FYP', 'Physics 210', 'No goal']);
  });

  it('nests children under parents ordered by position', () => {
    const groups = buildTaskForest([
      task({ id: 'p', title: 'Parent' }),
      task({ id: 'c2', parent_task_id: 'p', title: 'Second', position: 2 }),
      task({ id: 'c1', parent_task_id: 'p', title: 'First', position: 1 }),
    ], goals);
    const root = groups[0].nodes[0];
    expect(root.task.id).toBe('p');
    expect(root.children.map(n => n.task.id)).toEqual(['c1', 'c2']);
    expect(groups[0].taskCount).toBe(3);
  });

  it('supports deeper nesting (subtask of a subtask)', () => {
    const groups = buildTaskForest([
      task({ id: 'p', title: 'P' }),
      task({ id: 'c', parent_task_id: 'p', title: 'C' }),
      task({ id: 'gc', parent_task_id: 'c', title: 'GC' }),
    ], goals);
    expect(groups[0].nodes[0].children[0].children[0].task.id).toBe('gc');
  });

  it('promotes children whose parent is completed so they stay findable', () => {
    const groups = buildTaskForest([
      task({ id: 'p', title: 'Done parent', completed: true }),
      task({ id: 'c', parent_task_id: 'p', title: 'Orphan child' }),
    ], goals);
    expect(groups[0].nodes.map(n => n.task.id)).toEqual(['c']);
  });

  it('excludes completed tasks by default but can include them', () => {
    const tasks = [task({ id: 'open' }), task({ id: 'done', completed: true })];
    expect(buildTaskForest(tasks, goals)[0].taskCount).toBe(1);
    expect(buildTaskForest(tasks, goals, { includeCompleted: true })[0].taskCount).toBe(2);
  });

  it('excludes critical-path scaffolding tasks', () => {
    const groups = buildTaskForest([task({ id: 'cp', kind: 'critical_path' })], goals);
    expect(groups).toHaveLength(0);
  });

  it('can include a pre-filtered started critical-path item on the Work surface', () => {
    const started = task({ id: 'started-cp', kind: 'critical_path', status: 'in_progress' });
    const future = task({ id: 'future-cp', kind: 'critical_path', status: 'planned' });
    const workTasks = [started, future].filter(isWorkSelectableTask);
    const groups = buildTaskForest(workTasks, goals, { includeCriticalPath: true });

    expect(groups[0].nodes.map(node => node.task.id)).toEqual(['started-cp']);
  });
});

describe('filterForest', () => {
  const forest = buildTaskForest([
    task({ id: 'p', title: 'Final Report' }),
    task({ id: 'c', parent_task_id: 'p', title: 'Draft intro' }),
    task({ id: 'x', title: 'Buy groceries', goal_id: 'g2' }),
  ], goals);

  it('returns everything for an empty query', () => {
    expect(filterForest(forest, '  ')).toBe(forest);
  });

  it('keeps ancestors of a matching descendant', () => {
    const filtered = filterForest(forest, 'draft');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].nodes[0].task.id).toBe('p');
    expect(filtered[0].nodes[0].children[0].task.id).toBe('c');
  });

  it('keeps whole subtree when a parent matches', () => {
    const filtered = filterForest(forest, 'final report');
    expect(filtered[0].nodes[0].children).toHaveLength(1);
  });

  it('keeps a whole group when the goal title matches', () => {
    const filtered = filterForest(forest, 'physics');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].nodes[0].task.id).toBe('x');
  });

  it('drops groups with no matches', () => {
    expect(filterForest(forest, 'zzz-nothing')).toHaveLength(0);
  });
});
