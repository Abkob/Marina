import { describe, expect, it } from 'vitest';
import type { DBEdge, DBTask } from '../../db/schema';
import { buildTaskRivers, wouldCreateTaskRiverCycle } from '../taskRivers';

const task = (id: string, position: number): DBTask => ({
  id, goal_id: 'g', parent_task_id: 'm', title: id, description: '', status: 'todo',
  priority: 'medium', kind: 'manual', critical_path_status: null, tags_json: '[]',
  due_date: null, estimated_duration: null, completed: false, position,
  created_at: '', updated_at: '',
});

const edge = (source: string, target: string): DBEdge => ({
  id: `${source}-${target}`, source_id: source, source_type: 'task', target_id: target,
  target_type: 'task', relationship: 'blocks', metadata: '{}', created_at: '',
});

describe('buildTaskRivers', () => {
  it('shows the prerequisite as the earlier step even when positions say otherwise', () => {
    const waiting = task('waiting', 0);
    const prerequisite = task('prerequisite', 1);

    expect(buildTaskRivers([waiting, prerequisite], [edge('prerequisite', 'waiting')])[0].map(t => t.id))
      .toEqual(['prerequisite', 'waiting']);
  });

  it('orders a multi-step chain from first prerequisite to final task', () => {
    const tasks = [task('third', 0), task('first', 2), task('second', 1)];
    const dependencies = [edge('first', 'second'), edge('second', 'third')];

    expect(buildTaskRivers(tasks, dependencies)[0].map(t => t.id)).toEqual(['first', 'second', 'third']);
  });
});

describe('wouldCreateTaskRiverCycle', () => {
  it('detects reversing an existing dependency chain', () => {
    expect(wouldCreateTaskRiverCycle('first', 'third', [edge('first', 'second'), edge('second', 'third')])).toBe(true);
  });

  it('allows a dependency that does not point back to the moved task', () => {
    expect(wouldCreateTaskRiverCycle('third', 'first', [edge('first', 'second')])).toBe(false);
  });
});
