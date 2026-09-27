import { describe, expect, it } from 'vitest';
import type { DBTask } from '../../db/schema';
import {
  getEffectiveTaskDueDate,
  getDescendantTaskDeadlineSummary,
  getInheritedTaskDueDate,
  getTaskDeadlineViolation,
  taskUsesInheritedDueDate,
} from '../taskDates';

function task(overrides: Partial<DBTask>): DBTask {
  return {
    id: 'task',
    goal_id: 'goal',
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

describe('task due date inheritance', () => {
  it('keeps top-level tasks undated when they have no task deadline', () => {
    const parent = task({ id: 'parent', due_date: null });
    expect(getEffectiveTaskDueDate(parent, [parent])).toBeNull();
    expect(taskUsesInheritedDueDate(parent, [parent])).toBe(false);
  });

  it('inherits the nearest parent task due date for an undated child', () => {
    const parent = task({ id: 'parent', due_date: '2026-07-20' });
    const child = task({ id: 'child', parent_task_id: 'parent', due_date: null });

    expect(getEffectiveTaskDueDate(child, [parent, child])).toBe('2026-07-20');
    expect(getInheritedTaskDueDate(child, [parent, child])).toBe('2026-07-20');
  });

  it('lets a child explicit due date override the parent', () => {
    const parent = task({ id: 'parent', due_date: '2026-07-20' });
    const child = task({ id: 'child', parent_task_id: 'parent', due_date: '2026-07-12' });

    expect(getEffectiveTaskDueDate(child, [parent, child])).toBe('2026-07-12');
    expect(getInheritedTaskDueDate(child, [parent, child])).toBeNull();
  });

  it('walks ancestor tasks but never looks at goal dates', () => {
    const grandparent = task({ id: 'grandparent', due_date: '2026-08-01' });
    const parent = task({ id: 'parent', parent_task_id: 'grandparent', due_date: null });
    const child = task({ id: 'child', parent_task_id: 'parent', due_date: null });

    expect(getEffectiveTaskDueDate(child, [grandparent, parent, child])).toBe('2026-08-01');
  });

  it('summarizes child deadlines without inventing a parent deadline', () => {
    const parent = task({ id: 'parent', due_date: null });
    const early = task({ id: 'early', parent_task_id: 'parent', due_date: '2026-07-12' });
    const branch = task({ id: 'branch', parent_task_id: 'parent', due_date: null });
    const late = task({ id: 'late', parent_task_id: 'branch', due_date: '2026-08-20' });
    const done = task({ id: 'done', parent_task_id: 'parent', due_date: '2026-07-01', completed: true });
    const all = [parent, early, branch, late, done];

    expect(getEffectiveTaskDueDate(parent, all)).toBeNull();
    expect(getDescendantTaskDeadlineSummary(parent.id, all)).toEqual({
      earliest: '2026-07-12',
      latest: '2026-08-20',
      taskCount: 2,
    });
  });
});

describe('task deadline hierarchy validation', () => {
  it('rejects a child deadline after its parent deadline', () => {
    const parent = task({ id: 'parent', title: 'Parent', due_date: '2026-07-20' });
    const child = task({ id: 'child', parent_task_id: 'parent' });

    expect(getTaskDeadlineViolation('child', '2026-07-21', [parent, child])).toBe(
      'Child task deadline must be on or before parent task "Parent" deadline (2026-07-20).',
    );
  });

  it('allows a child deadline on the same day as its parent', () => {
    const parent = task({ id: 'parent', due_date: '2026-07-20' });
    const child = task({ id: 'child', parent_task_id: 'parent' });

    expect(getTaskDeadlineViolation('child', '2026-07-20', [parent, child])).toBeNull();
  });

  it('rejects moving a parent deadline before an existing descendant', () => {
    const parent = task({ id: 'parent', title: 'Parent', due_date: '2026-07-20' });
    const child = task({ id: 'child', title: 'Child', parent_task_id: 'parent', due_date: '2026-07-19' });

    expect(getTaskDeadlineViolation('parent', '2026-07-18', [parent, child])).toBe(
      'Parent task deadline cannot be 2026-07-18: child task "Child" is due 2026-07-19. Move the child deadline first.',
    );
  });

  it('uses the nearest dated ancestor when the immediate parent inherits its deadline', () => {
    const grandparent = task({ id: 'grandparent', title: 'Grandparent', due_date: '2026-07-20' });
    const parent = task({ id: 'parent', parent_task_id: 'grandparent', due_date: null });
    const child = task({ id: 'child', parent_task_id: 'parent' });

    expect(getTaskDeadlineViolation('child', '2026-07-21', [grandparent, parent, child])).toBe(
      'Child task deadline must be on or before parent task "Grandparent" deadline (2026-07-20).',
    );
  });
});
