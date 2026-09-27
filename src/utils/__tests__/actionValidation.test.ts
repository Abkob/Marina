import { describe, it, expect } from 'vitest';
import { validateModelActions } from '../../../server/services/actionValidation';

describe('validateModelActions — strict model output validation', () => {
  it('accepts a well-formed create_task action', () => {
    const [a] = validateModelActions([
      { id: 'a1', type: 'create_task', description: 'Add task', params: { title: 'Write spec', estimated_minutes: 60, priority: 'high' } },
    ]);
    expect(a.rejected_reason).toBeUndefined();
    expect(a.type).toBe('create_task');
    expect(a.params.title).toBe('Write spec');
  });

  it('accepts a daily cap for plan_schedule actions', () => {
    const [action] = validateModelActions([{
      id: 'a1',
      type: 'plan_schedule',
      description: 'Spread the task across days',
      params: {
        task_id: 'task-1',
        from_date: '2026-07-26',
        to_date: '2026-08-30',
        max_daily_minutes: 120,
      },
    }]);

    expect(action.rejected_reason).toBeUndefined();
    expect(action.params.max_daily_minutes).toBe(120);
  });

  it('accepts a model-selected move of existing schedule records', () => {
    const [action] = validateModelActions([{
      id: 'a1',
      type: 'move_schedule_items',
      description: 'Move everything currently on Sunday to Monday',
      params: {
        source_date: '2026-07-26',
        target_date: '2026-07-27',
        entity_types: ['tasks', 'deadlines', 'events'],
        preserve_event_times: true,
      },
    }]);

    expect(action.rejected_reason).toBeUndefined();
    expect(action.params.source_date).toBe('2026-07-26');
    expect(action.params.target_date).toBe('2026-07-27');
  });

  it('rejects a semantic move whose source and target are the same day', () => {
    const [action] = validateModelActions([{
      type: 'move_schedule_items',
      params: {
        source_date: '2026-07-27',
        target_date: '2026-07-27',
        entity_types: ['events'],
        preserve_event_times: true,
      },
    }]);
    expect(action.rejected_reason).toContain('must differ');
  });

  it('rejects unknown action types', () => {
    const [a] = validateModelActions([
      { id: 'a1', type: 'delete_all_data', params: {} },
    ]);
    expect(a.rejected_reason).toContain('unknown action type');
  });

  it('rejects unknown fields (strict mode) — model cannot smuggle extra mutations', () => {
    const [a] = validateModelActions([
      { id: 'a1', type: 'update_task', params: { task_id: 't1', completed: true } },
    ]);
    expect(a.rejected_reason).toBeTruthy();
    expect(a.rejected_reason).toContain('completed');
  });

  it('rejects malformed dates', () => {
    const [a] = validateModelActions([
      { id: 'a1', type: 'create_task', params: { title: 'x', due_date: 'next tuesday' } },
    ]);
    expect(a.rejected_reason).toContain('YYYY-MM-DD');
  });

  it('rejects out-of-range estimated_minutes', () => {
    const [a] = validateModelActions([
      { id: 'a1', type: 'create_task', params: { title: 'x', estimated_minutes: 999999 } },
    ]);
    expect(a.rejected_reason).toBeTruthy();
  });

  it('accepts estimates longer than 24 hours for multi-session tasks', () => {
    const [action] = validateModelActions([
      { id: 'a1', type: 'update_task', params: { task_id: 'task-1', estimated_minutes: 60 * 60 } },
    ]);
    expect(action.rejected_reason).toBeUndefined();
    expect(action.params.estimated_minutes).toBe(3600);
  });

  it('normalizes safe update_task aliases emitted from planning context', () => {
    const [action] = validateModelActions([{
      id: 'a1',
      type: 'update_task',
      params: {
        task_id: 'task-1',
        deadline: '2026-08-30',
        estimated_minutes: 3600,
        remaining_minutes: 3600,
      },
    }]);
    expect(action.rejected_reason).toBeUndefined();
    expect(action.params).toEqual({
      task_id: 'task-1',
      due_date: '2026-08-30',
      estimated_minutes: 3600,
    });
  });

  it('rejects invalid enum values for priority/status', () => {
    const [a] = validateModelActions([
      { id: 'a1', type: 'update_task', params: { task_id: 't1', priority: 'extreme' } },
    ]);
    expect(a.rejected_reason).toBeTruthy();
  });

  it('rejects actions missing a type entirely', () => {
    const [a] = validateModelActions([{ params: { title: 'x' } }]);
    expect(a.rejected_reason).toBe('missing action type');
  });

  it('handles a mixed batch — valid pass, invalid carry reasons, order preserved', () => {
    const out = validateModelActions([
      { id: 'a1', type: 'create_goal', params: { title: 'Goal', deadline: '2026-09-01' } },
      { id: 'a2', type: 'drop_table', params: {} },
      { id: 'a3', type: 'update_goal', params: { goal_id: 'g1', status: 'Watch' } },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].rejected_reason).toBeUndefined();
    expect(out[1].rejected_reason).toContain('unknown action type');
    expect(out[2].rejected_reason).toBeUndefined();
  });

  it('assigns fallback ids when the model omits them', () => {
    const out = validateModelActions([
      { type: 'create_goal', params: { title: 'A' } },
      { type: 'create_goal', params: { title: 'B' } },
    ]);
    expect(out[0].id).toBe('a1');
    expect(out[1].id).toBe('a2');
  });

  it('accepts a compound goal creation with starter tasks', () => {
    const [a] = validateModelActions([
      {
        id: 'a1',
        type: 'create_goal_with_tasks',
        description: 'Create Research Goals with first task',
        params: {
          title: 'Research Goals',
          start_date: '2026-07-09',
          tasks: [
            {
              title: 'Talk to Professor Joseph Constantine',
              due_date: '2026-07-13',
              priority: 'medium',
            },
          ],
        },
      },
    ]);
    expect(a.rejected_reason).toBeUndefined();
    expect(a.type).toBe('create_goal_with_tasks');
    expect(a.params.title).toBe('Research Goals');
    expect(Array.isArray(a.params.tasks)).toBe(true);
  });

  it('accepts a bounded task breakdown with concrete child tasks', () => {
    const [a] = validateModelActions([{
      id: 'a1',
      type: 'break_down_task',
      description: 'Break the report into next steps',
      params: {
        parent_task_id: 'task-1',
        tasks: [
          { title: 'Collect source material', estimated_minutes: 45 },
          { title: 'Draft the outline', estimated_minutes: 30, due_date: '2026-08-01' },
        ],
      },
    }]);
    expect(a.rejected_reason).toBeUndefined();
    expect(a.type).toBe('break_down_task');
    expect(a.params.parent_task_id).toBe('task-1');
    expect(a.params.tasks).toHaveLength(2);
  });

  it('rejects a breakdown with fewer than two child tasks', () => {
    const [a] = validateModelActions([{
      id: 'a1',
      type: 'break_down_task',
      params: {
        parent_task_id: 'task-1',
        tasks: [{ title: 'Only one step' }],
      },
    }]);
    expect(a.rejected_reason).toBeTruthy();
  });

  it('rejects empty titles', () => {
    const [a] = validateModelActions([
      { id: 'a1', type: 'create_goal', params: { title: '' } },
    ]);
    expect(a.rejected_reason).toBeTruthy();
  });

  it('allows nullable date clearing on update_task', () => {
    const [a] = validateModelActions([
      { id: 'a1', type: 'update_task', params: { task_id: 't1', due_date: null } },
    ]);
    expect(a.rejected_reason).toBeUndefined();
    expect(a.params.due_date).toBeNull();
  });

  it('strips null optional fields on create actions (real models ignore "omit nulls")', () => {
    const [a] = validateModelActions([
      { id: 'a1', type: 'create_task', params: { goal_id: 'goal-1', parent_task_id: null, milestone_id: null, title: 'Verify Pipeline Test', due_date: '2026-07-10', estimated_minutes: 60 } },
    ]);
    expect(a.rejected_reason).toBeUndefined();
    expect(a.params.title).toBe('Verify Pipeline Test');
    expect('parent_task_id' in a.params).toBe(false);
    expect('milestone_id' in a.params).toBe(false);
  });

  it('keeps meaningful nulls on update actions (clearing a due date)', () => {
    const [a] = validateModelActions([
      { id: 'a1', type: 'update_task', params: { task_id: 't1', due_date: null, priority: null } },
    ]);
    expect(a.rejected_reason).toBeUndefined();
    expect(a.params.due_date).toBeNull();       // meaningful clear — preserved
    expect('priority' in a.params).toBe(false); // null "no change" — stripped
  });

  it('validates create_milestone color format', () => {
    const [bad] = validateModelActions([
      { id: 'a1', type: 'create_milestone', params: { goal_id: 'g1', title: 'M', color: 'red' } },
    ]);
    expect(bad.rejected_reason).toBeTruthy();
    const [good] = validateModelActions([
      { id: 'a1', type: 'create_milestone', params: { goal_id: 'g1', title: 'M', color: '#6366f1' } },
    ]);
    expect(good.rejected_reason).toBeUndefined();
  });
});
