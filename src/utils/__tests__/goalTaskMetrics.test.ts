import { describe, it, expect } from 'vitest';
import type { DBGoal, DBTask } from '../../db/schema';
import {
  getCountableGoalTasks,
  calculateGoalTaskMetrics,
  computeGoalStatus,
  getClosestDueTask,
  normalizeTaskWeight,
} from '../goalTaskMetrics';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _seq = 0;
function makeTask(overrides: Partial<DBTask> = {}): DBTask {
  return {
    id: `task-${++_seq}`,
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
    weight_percent: null,
    completed: false,
    position: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── normalizeTaskWeight ───────────────────────────────────────────────────────

describe('normalizeTaskWeight', () => {
  it('returns null for null/undefined', () => {
    expect(normalizeTaskWeight(null)).toBeNull();
    expect(normalizeTaskWeight(undefined)).toBeNull();
  });

  it('clamps to 0 for negatives', () => {
    expect(normalizeTaskWeight(-5)).toBe(0);
  });

  it('clamps to 100 for > 100', () => {
    expect(normalizeTaskWeight(150)).toBe(100);
  });

  it('rounds to nearest integer', () => {
    expect(normalizeTaskWeight(50.6)).toBe(51);
  });

  it('accepts 0 and 100 as valid edge values', () => {
    expect(normalizeTaskWeight(0)).toBe(0);
    expect(normalizeTaskWeight(100)).toBe(100);
  });
});

// ─── getCountableGoalTasks ────────────────────────────────────────────────────

describe('getCountableGoalTasks', () => {
  it('returns all tasks when none have children', () => {
    const tasks = [makeTask(), makeTask(), makeTask()];
    expect(getCountableGoalTasks(tasks)).toHaveLength(3);
  });

  it('excludes parent tasks — only counts leaf tasks', () => {
    const parent = makeTask({ id: 'parent' });
    const child1 = makeTask({ parent_task_id: 'parent' });
    const child2 = makeTask({ parent_task_id: 'parent' });
    const result = getCountableGoalTasks([parent, child1, child2]);
    // parent has children so it is excluded; only child1 and child2 count
    expect(result).toHaveLength(2);
    expect(result.every(t => t.parent_task_id === 'parent')).toBe(true);
  });

  it('handles multi-level hierarchy — only deepest leaves counted', () => {
    const grandparent = makeTask({ id: 'gp' });
    const parent      = makeTask({ id: 'p', parent_task_id: 'gp' });
    const leaf        = makeTask({ parent_task_id: 'p' });
    const result      = getCountableGoalTasks([grandparent, parent, leaf]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(leaf.id);
  });
});

// ─── calculateGoalTaskMetrics ─────────────────────────────────────────────────

describe('calculateGoalTaskMetrics — progress', () => {
  it('returns 0 progress with no tasks', () => {
    const { progress, totalTasks } = calculateGoalTaskMetrics([]);
    expect(totalTasks).toBe(0);
    expect(progress).toBe(0);
  });

  it('returns 0 progress when no tasks are done', () => {
    const tasks = [makeTask(), makeTask()];
    expect(calculateGoalTaskMetrics(tasks).progress).toBe(0);
  });

  it('returns 100 progress when all tasks are completed', () => {
    const tasks = [makeTask({ completed: true }), makeTask({ completed: true })];
    expect(calculateGoalTaskMetrics(tasks).progress).toBe(100);
  });

  it('returns 50 progress when half the tasks are done (equal weight)', () => {
    const tasks = [makeTask({ completed: true }), makeTask()];
    expect(calculateGoalTaskMetrics(tasks).progress).toBe(50);
  });

  it('respects explicit weight_percent — 75/25 split, complete the 75 task', () => {
    const heavy = makeTask({ weight_percent: 75, completed: true });
    const light = makeTask({ weight_percent: 25, completed: false });
    const { progress } = calculateGoalTaskMetrics([heavy, light]);
    expect(progress).toBe(75);
  });

  it('distributes remaining weight to tasks without explicit weight', () => {
    // explicit = 60; remaining 40 split across 2 "auto" tasks
    const t1 = makeTask({ weight_percent: 60, completed: true });
    const t2 = makeTask({ completed: true });   // auto = 20
    const t3 = makeTask({ completed: false });  // auto = 20
    const { progress } = calculateGoalTaskMetrics([t1, t2, t3]);
    expect(progress).toBe(80); // 60 + 20 = 80
  });

  it('considers "done" status as completed even if completed flag is false', () => {
    const tasks = [makeTask({ status: 'done' }), makeTask()];
    expect(calculateGoalTaskMetrics(tasks).progress).toBe(50);
  });

  it('never reaches 100 while a zero-weight task is not started', () => {
    const tasks = [
      makeTask({ weight_percent: 100, completed: true }),
      makeTask({ weight_percent: 0, status: 'not_started' }),
    ];
    expect(calculateGoalTaskMetrics(tasks).progress).toBe(99);
  });

  it('never reaches 100 while an untimed task is in progress', () => {
    const tasks = [
      makeTask({ estimated_minutes: 60, completed: true }),
      makeTask({ estimated_minutes: null, status: 'in_progress' }),
    ];
    expect(calculateGoalTaskMetrics(tasks).progress).toBe(99);
  });

  it('never reaches 100 while any milestone task is unfinished', () => {
    const tasks = [
      makeTask({ completed: true }),
      makeTask({ kind: 'critical_path', status: 'not_started' }),
    ];
    expect(calculateGoalTaskMetrics(tasks).progress).toBe(99);
  });

  it('reaches 100 when a milestone is completed by all of its child tasks', () => {
    const milestone = makeTask({ id: 'milestone', kind: 'critical_path', due_date: '2026-07-10' });
    const child = makeTask({ parent_task_id: 'milestone', completed: true, status: 'done' });

    expect(calculateGoalTaskMetrics([milestone, child]).progress).toBe(100);
  });
});

describe('calculateGoalTaskMetrics — counts', () => {
  it('counts ALL non-milestone tasks; only explicitly-done ones increment completedTasks', () => {
    const parent = makeTask({ id: 'p' });
    const child1 = makeTask({ parent_task_id: 'p', completed: true });
    const child2 = makeTask({ parent_task_id: 'p' });
    const { totalTasks, completedTasks, remainingTasks } = calculateGoalTaskMetrics([parent, child1, child2]);
    // parent + child1 + child2 = 3 non-milestone tasks
    expect(totalTasks).toBe(3);
    // only child1 is explicitly done — parent is NOT counted via child completion
    expect(completedTasks).toBe(1);
    expect(remainingTasks).toBe(2);
  });
});

describe('calculateGoalTaskMetrics — activityLevel', () => {
  it('returns activityLevel 5 when all tasks complete', () => {
    const tasks = [makeTask({ completed: true }), makeTask({ completed: true })];
    expect(calculateGoalTaskMetrics(tasks).activityLevel).toBe(5);
  });

  it('returns activityLevel 1 for empty task list', () => {
    expect(calculateGoalTaskMetrics([]).activityLevel).toBe(1);
  });

  it('boosts activityLevel for in-progress tasks', () => {
    const now = new Date();
    const tasks = [
      makeTask({ status: 'in_progress', updated_at: now.toISOString() }),
      makeTask({ status: 'in_progress', updated_at: now.toISOString() }),
      makeTask({ status: 'in_progress', updated_at: now.toISOString() }),
    ];
    const { activityLevel } = calculateGoalTaskMetrics(tasks, now);
    expect(activityLevel).toBeGreaterThanOrEqual(3);
  });
});

describe('computeGoalStatus task deadlines', () => {
  const goal = {
    id: 'g1', title: 'Goal', description: '', category: 'Work', status: 'Safe',
    progress: 0, deadline: null, overdue: false, activity_level: 1, archived_at: null,
    created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
  } satisfies DBGoal;
  const now = new Date('2026-07-14T12:00:00.000Z');

  it('returns Watch when an unfinished task has any deadline within a week', () => {
    expect(computeGoalStatus(goal, [makeTask({ hard_deadline: '2026-07-20' })], now)).toBe('Watch');
  });

  it('ignores approaching deadlines on completed tasks', () => {
    const task = makeTask({ due_date: '2026-07-15', completed: true, status: 'done' });
    expect(computeGoalStatus(goal, [task], now)).toBe('Safe');
  });

  it('ignores an overdue milestone when all of its child tasks are completed', () => {
    const milestone = makeTask({ id: 'milestone', kind: 'critical_path', due_date: '2026-07-10' });
    const child = makeTask({ parent_task_id: 'milestone', completed: true, status: 'done' });
    const tasks = [milestone, child];

    expect(getClosestDueTask(tasks, now)).toBeNull();
    expect(computeGoalStatus(goal, tasks, now)).toBe('Safe');
  });
});
