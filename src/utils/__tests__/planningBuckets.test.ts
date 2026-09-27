import { describe, expect, it } from 'vitest';
import { buildPlanningBuckets, type PlanningTaskInput } from '../../../server/services/planningBuckets.js';

const TODAY = '2026-07-06'; // Monday

function task(overrides: Partial<PlanningTaskInput>): PlanningTaskInput {
  return {
    id: overrides.id ?? 'task',
    title: overrides.title ?? 'Task',
    goal_id: overrides.goal_id ?? 'goal',
    goal_title: overrides.goal_title ?? 'Goal',
    parent_task_id: overrides.parent_task_id ?? null,
    status: overrides.status ?? 'todo',
    priority: overrides.priority ?? 'medium',
    feel_score: overrides.feel_score ?? null,
    kind: overrides.kind ?? 'manual',
    due_date: overrides.due_date ?? null,
    target_date: overrides.target_date ?? null,
    hard_deadline: overrides.hard_deadline ?? null,
    scheduling_enabled: overrides.scheduling_enabled ?? true,
    estimated_minutes: 'estimated_minutes' in overrides ? overrides.estimated_minutes : 60,
    logged_minutes: 'logged_minutes' in overrides ? overrides.logged_minutes : 0,
    child_count: overrides.child_count ?? 0,
  };
}

function buckets(tasks: PlanningTaskInput[]) {
  return buildPlanningBuckets(tasks, {
    today: TODAY,
    effectiveCapacityMinutes: 360,
    horizonDays: 14,
    nearDeadlineDays: 14,
    largeTaskMinutes: 180,
  });
}

describe('buildPlanningBuckets', () => {
  it('separates tasks due on Tuesday from large future-deadline slices', () => {
    const result = buckets([
      task({ id: 'quiz', title: 'Tuesday quiz', due_date: '2026-07-07', estimated_minutes: 90 }),
      task({ id: 'nih', title: 'NIH paper', due_date: '2026-07-10', estimated_minutes: 600 }),
    ]);

    const tuesday = result.must_finish_by_date.find(d => d.date === '2026-07-07');
    expect(tuesday?.tasks.map(t => t.id)).toEqual(['quiz']);

    const friday = result.must_finish_by_date.find(d => d.date === '2026-07-10');
    expect(friday?.tasks.map(t => t.id)).toEqual(['nih']);

    expect(result.large_tasks_needing_slices.map(t => t.id)).toContain('nih');
    expect(result.large_tasks_needing_slices.find(t => t.id === 'nih')?.suggested_daily_minutes).toBe(138);
  });

  it('keeps parent tasks as rollup context while subtasks remain schedulable', () => {
    const result = buckets([
      task({ id: 'parent', title: 'Course project', due_date: '2026-07-12', estimated_minutes: 900, child_count: 2 }),
      task({ id: 'child', title: 'Draft abstract', parent_task_id: 'parent', due_date: '2026-07-07', estimated_minutes: 120 }),
      task({ id: 'subchild', title: 'Find citations', parent_task_id: 'child', due_date: '2026-07-07', estimated_minutes: 60 }),
    ]);

    expect(result.parent_rollups.map(t => t.id)).toEqual(['parent']);
    expect(result.parent_rollups[0]).toMatchObject({
      earliest_child_deadline: '2026-07-07',
      latest_child_deadline: '2026-07-07',
      dated_descendant_count: 2,
    });
    expect(result.large_tasks_needing_slices.map(t => t.id)).not.toContain('parent');
    expect(result.must_finish_by_date.find(d => d.date === '2026-07-07')?.tasks.map(t => t.id)).toEqual(['child', 'subchild']);
  });

  it('carries a child deadline range on an undated parent rollup', () => {
    const result = buckets([
      task({ id: 'parent', title: 'Open-ended course', due_date: null, estimated_minutes: null, child_count: 2 }),
      task({ id: 'exam', parent_task_id: 'parent', due_date: '2026-08-20', estimated_minutes: 1200 }),
      task({ id: 'admin', parent_task_id: 'parent', due_date: '2026-07-30', estimated_minutes: 30 }),
    ]);

    expect(result.parent_rollups[0]).toMatchObject({
      id: 'parent',
      deadline: null,
      earliest_child_deadline: '2026-07-30',
      latest_child_deadline: '2026-08-20',
      dated_descendant_count: 2,
    });
  });

  it('does not list a parent rollup as due work on the same day as its subtasks', () => {
    const result = buckets([
      task({ id: 'parent', title: 'Fix Errors', due_date: '2026-07-07', estimated_minutes: 300, child_count: 2 }),
      task({ id: 'child-a', title: 'Missing items stock feature', parent_task_id: 'parent', due_date: '2026-07-07', estimated_minutes: 90 }),
      task({ id: 'child-b', title: 'Database refresh from legacy', parent_task_id: 'parent', due_date: '2026-07-07', estimated_minutes: 60 }),
    ]);

    expect(result.parent_rollups.map(t => t.id)).toEqual(['parent']);
    expect(result.must_finish_by_date.find(d => d.date === '2026-07-07')?.tasks.map(t => t.id)).toEqual(['child-a', 'child-b']);
  });

  it('uses hard_deadline before target_date and target_date before legacy due_date', () => {
    const result = buckets([
      task({
        id: 'priority-date',
        title: 'Conflicting dates',
        due_date: '2026-07-20',
        target_date: '2026-07-09',
        hard_deadline: '2026-07-08',
        estimated_minutes: 240,
      }),
    ]);

    expect(result.must_finish_by_date.find(d => d.date === '2026-07-08')?.tasks[0]?.deadline_kind).toBe('hard_deadline');
    expect(result.must_finish_by_date.some(d => d.date === '2026-07-09')).toBe(false);
    expect(result.must_finish_by_date.some(d => d.date === '2026-07-20')).toBe(false);
  });

  it('classifies far-deadline and undated large work as background fillers', () => {
    const result = buckets([
      task({ id: 'exam', title: 'Exam prep', due_date: '2026-08-20', estimated_minutes: 1200 }),
      task({ id: 'portfolio', title: 'Portfolio cleanup', due_date: null, estimated_minutes: 300 }),
    ]);

    expect(result.background_fillers.map(t => t.id)).toEqual(['exam', 'portfolio']);
    expect(result.background_fillers.find(t => t.id === 'exam')?.reason).toBe('far_deadline');
    expect(result.background_fillers.find(t => t.id === 'portfolio')?.reason).toBe('no_deadline');
  });

  it('flags unestimated due-soon leaf work without treating parents as missing estimates', () => {
    const result = buckets([
      task({ id: 'parent', title: 'Parent without own estimate', due_date: '2026-07-09', estimated_minutes: null, child_count: 3 }),
      task({ id: 'leaf', title: 'Leaf without estimate', due_date: '2026-07-09', estimated_minutes: null }),
    ]);

    expect(result.parent_rollups.map(t => t.id)).toEqual(['parent']);
    expect(result.unestimated_due_soon.map(t => t.id)).toEqual(['leaf']);
  });

  it('uses the higher feel score first when deadlines are equal', () => {
    const result = buckets([
      task({ id: 'low-feel', due_date: '2026-07-08', feel_score: 20 }),
      task({ id: 'high-feel', due_date: '2026-07-08', feel_score: 90 }),
    ]);

    expect(result.must_finish_by_date.find(d => d.date === '2026-07-08')?.tasks.map(t => t.id))
      .toEqual(['high-feel', 'low-feel']);
  });
});
