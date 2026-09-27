import { describe, expect, it } from 'vitest';
import { buildTaskTimelineResolver } from '../../../server/services/taskTimeline.js';

describe('buildTaskTimelineResolver', () => {
  it('inherits goal start and target dates for an otherwise undated leaf task', () => {
    const resolve = buildTaskTimelineResolver(
      [{ id: 'leaf', parent_task_id: null, goal_id: 'goal-1' }],
      [{ id: 'goal-1', start_date: '2026-08-15', target_date: '2026-09-01' }],
    );

    expect(resolve({ id: 'leaf' })).toEqual({
      start_date: '2026-08-15', due_date: '2026-09-01',
      start_source: { scope: 'goal', field: 'start_date', entity_id: 'goal-1' },
      due_source: { scope: 'goal', field: 'target_date', entity_id: 'goal-1' },
    });
  });

  it('uses a task hard deadline before its target and inherited goal date', () => {
    const resolve = buildTaskTimelineResolver(
      [{
        id: 'leaf', parent_task_id: null, goal_id: 'goal-1',
        target_date: '2026-08-28', hard_deadline: '2026-08-25',
      }],
      [{ id: 'goal-1', target_date: '2026-09-01' }],
    );

    expect(resolve({ id: 'leaf' }).due_date).toBe('2026-08-25');
    expect(resolve({ id: 'leaf' }).due_source).toEqual({
      scope: 'task', field: 'hard_deadline', entity_id: 'leaf',
    });
  });

  it('inherits the nearest parent timeline before milestone and goal timelines', () => {
    const resolve = buildTaskTimelineResolver(
      [
        { id: 'parent', parent_task_id: null, goal_id: 'goal-1', target_date: '2026-08-22' },
        { id: 'leaf', parent_task_id: 'parent', goal_id: 'goal-1', milestone_id: 'mile-1' },
      ],
      [{ id: 'goal-1', target_date: '2026-09-01' }],
      [{ id: 'mile-1', due_date: '2026-08-27' }],
    );

    expect(resolve({ id: 'leaf' }).due_date).toBe('2026-08-22');
    expect(resolve({ id: 'leaf' }).due_source?.scope).toBe('parent_task');
  });

  it('caps a dated task at an earlier goal cutoff and honors the later enclosing start', () => {
    const resolve = buildTaskTimelineResolver(
      [{
        id: 'leaf', parent_task_id: null, goal_id: 'goal-1',
        start_date: '2026-08-10', target_date: '2026-09-10',
      }],
      [{ id: 'goal-1', start_date: '2026-08-15', target_date: '2026-09-01' }],
    );

    expect(resolve({ id: 'leaf' })).toMatchObject({
      start_date: '2026-08-15',
      due_date: '2026-09-01',
      start_source: { scope: 'goal', field: 'start_date' },
      due_source: { scope: 'goal', field: 'target_date' },
    });
  });

  it('ignores a vague legacy goal deadline', () => {
    const resolve = buildTaskTimelineResolver(
      [{ id: 'leaf', parent_task_id: null, goal_id: 'goal-1' }],
      [{ id: 'goal-1', deadline: 'Q4 someday' }],
    );

    expect(resolve({ id: 'leaf' }).due_date).toBeNull();
  });
});
