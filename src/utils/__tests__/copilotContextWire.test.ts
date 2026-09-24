import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContextObservations, packContext, unpackContext } from '../../../server/services/copilotContextWire.js';
import { compactSchema } from '../../../server/services/copilotContracts.js';
import { workspaceGraph, selectWorkspaceSections } from '../../../server/services/copilotWorkspaceGraph.js';

const tasks = Array.from({ length: 60 }, (_, i) => ({
  id: `task-${i}`, title: `Research item ${i}`, goal_id: 'goal-1', parent_task_id: i ? 'task-0' : null,
  remaining_minutes: i === 2 ? null : i * 15, logged_minutes: 0, priority: 'medium', status: 'todo',
  due_date: '2026-10-02', hard_deadline: null, blocker_ids: i > 1 ? [`task-${i - 1}`] : [],
  scheduled_blocks: [], description: 'Keep the original wording, العربية, punctuation and values.',
}));

describe('compact JSON facts', () => {
  it('round-trips every fact including graph links, zero, null, prose and Unicode', () => {
    const original = { tasks, capacity: [{ date: '2026-09-24', available_minutes: 0 }, { date: '2026-09-25', available_minutes: null }], flags: [false, true] };
    const packed = packContext(original);
    expect(JSON.stringify(packed)).toContain('$table');
    expect(unpackContext(packed)).toEqual(original);
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(original).length * 0.6);
  });
  it('preserves absent versus null fields in heterogeneous rows', () => {
    const original = [{ id: 'a' }, { id: 'b', estimate: null }, { id: 'c', estimate: 0 }];
    expect(unpackContext(packContext(original))).toEqual(original);
  });
  it('escapes literal objects that resemble encoding metadata', () => {
    const original = { $table: { columns: ['x'], rows: [[1]] }, nested: { $literal: 'ordinary text' } };
    expect(unpackContext(packContext(original))).toEqual(original);
  });
  it('keeps tiny responses simple and does not mutate originals', () => {
    const original = { tasks: structuredClone(tasks), sample: [1, 2, 3] };
    const before = structuredClone(original);
    packContext(original);
    expect(original).toEqual(before);
    expect(packContext({ available_minutes: 0 })).toEqual({ available_minutes: 0 });
  });
  it('references only exact earlier sections within the same request', () => {
    const observations = new ContextObservations();
    observations.encode('first', { tasks });
    const second = observations.encode('second', { tasks, capacity_minutes: 180 });
    expect(second).toHaveProperty('tasks.same_as', { call_id: 'first', field: 'tasks' });
    const changed = observations.encode('third', { tasks: tasks.map(task => ({ ...task, due_date: '2026-10-03' })) });
    expect(changed).not.toHaveProperty('tasks.same_as');
    expect(new ContextObservations().encode('fresh', { tasks })).not.toHaveProperty('tasks.same_as');
  });
  it('does not reference rejected oversized observations', () => {
    const observations = new ContextObservations();
    expect(() => observations.encode('failed', { tasks, notes: 'x'.repeat(50_001) })).toThrow('Context budget');
    expect(observations.encode('valid', { tasks })).not.toHaveProperty('tasks.same_as');
  });
  it('allows a large raw snapshot when its lossless representation fits', () => {
    const data = { tasks: Array.from({ length: 3 }, () => tasks).flat() };
    expect(JSON.stringify(data).length).toBeGreaterThan(50_000);
    expect(JSON.stringify(new ContextObservations().encode('large', data)).length).toBeLessThan(50_000);
  });
});

describe('workspace graph and sections', () => {
  it('retains parent links outside the overview and distinct goal/milestone/blocker relationships', () => {
    const child = { id: 'child', title: 'Child', milestone_id: 'm1', blocker_ids: ['prerequisite'], children: [], remaining_minutes: null };
    const hierarchy = [{ id: 'g1', title: 'Goal', tasks: [{ id: 'root', parent_task_id: 'outside-page', children: [child] }], milestones: [{ id: 'm1', due_date: '2026-10-02' }] }];
    expect(workspaceGraph(hierarchy)).toEqual({
      goals: [{ id: 'g1', title: 'Goal' }], milestones: [{ id: 'm1', due_date: '2026-10-02', goal_id: 'g1' }],
      tasks: [{ id: 'root', goal_id: 'g1', parent_task_id: 'outside-page' }, { id: 'child', title: 'Child', milestone_id: 'm1', blocker_ids: ['prerequisite'], remaining_minutes: null, goal_id: 'g1', parent_task_id: 'root' }],
    });
  });
  it('returns requested capacity without unrelated task/journal content, with coverage still visible', () => {
    const data = { today: '2026-09-24', planning_coverage: { total_incomplete: 250, tasks_in_context: 200 }, schedule_prefs: { daily_capacity_minutes: 300 }, graph: { tasks }, recent_journal: ['unrelated'] };
    const selected = selectWorkspaceSections(data, ['capacity']);
    expect(selected).toHaveProperty('schedule_prefs.daily_capacity_minutes', 300);
    expect(selected).toHaveProperty('planning_coverage.total_incomplete', 250);
    expect(selected).not.toHaveProperty('graph');
    expect(selected).not.toHaveProperty('recent_journal');
    expect(selected.available_sections).toContain('journal');
  });
});

describe('compact generated tool contracts', () => {
  it('retains required/optional, nullability, enums, dates, arrays and numeric bounds', () => {
    const schema = z.object({ date: z.iso.date().nullable(), limit: z.number().int().min(1).max(50).optional(), ids: z.array(z.string().min(1)).min(1).max(20), mode: z.enum(['brief', 'full']) }).strict();
    const signature = compactSchema(schema);
    expect(signature).toContain('date:string');
    expect(signature).toContain('format="date"');
    expect(signature).toContain('|null');
    expect(signature).toContain('limit?:integer[minimum=1,maximum=50]');
    expect(signature).toContain('Array<string[minLength=1]>[minItems=1,maxItems=20]');
    expect(signature).toContain('mode:"brief"|"full"');
  });
});
