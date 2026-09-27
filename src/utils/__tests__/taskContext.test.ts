import { describe, expect, it } from 'vitest';
import type { DBEvent, DBEventTaskLink, DBGoal, DBTask } from '../../db/schema';
import { taskContextMap } from '../taskContext';
import { mobileScheduleItems } from '../mobileSchedule';

const task = (id: string, title: string, parent_task_id: string | null = null) => ({ id, title, parent_task_id, goal_id: 'course', status: 'todo' }) as DBTask;
const goals = [{ id: 'course', title: 'Courses' }] as DBGoal[];
describe('task context outside the tree', () => {
  it('distinguishes identical titles by their actual parent', () => {
    const tasks = [task('physics', 'Physics'), task('biology', 'Biology'), task('a', 'Review notes', 'physics'), task('b', 'Review notes', 'biology')];
    const labels = taskContextMap(tasks, goals);
    expect(labels.get('a')).toBe('Physics · Courses');
    expect(labels.get('b')).toBe('Biology · Courses');
  });
  it('uses known names when parents are missing and never exposes an ID or repeats a self-parent', () => {
    expect(taskContextMap([task('a', 'Read', 'missing')], goals).get('a')).toBe('Courses');
    expect(taskContextMap([task('a', 'Read', 'a')]).get('a')).toBe('');
    expect(taskContextMap([task('a', 'Read', 'b'), task('b', 'Write', 'a')]).get('a')).toBe('Write');
  });
  it('avoids duplicate goal and parent labels and includes completed parents', () => {
    expect(taskContextMap([{ ...task('parent', 'Courses'), completed: true }, task('a', 'Read', 'parent')], goals).get('a')).toBe('Courses');
  });
  it('carries the same context into an agenda task and its linked calendar block', () => {
    const date = '2026-09-24';
    const tasks = [task('physics', 'Physics'), { ...task('a', 'Review notes', 'physics'), due_date: date }];
    const result = mobileScheduleItems({ date, tasks, goals, events: [{ date, event: { id: 'block', title: 'Study', start_hour: 9, duration_hours: 1 } as DBEvent }],
      eventLinks: [{ event_id: 'block', task_id: 'a' }, { event_id: 'block', task_id: 'missing' }] as DBEventTaskLink[], meetings: [], blockedTaskIds: new Set() });
    expect(result.find(item => item.id === 'task:a')?.context).toBe('Physics · Courses');
    expect(result.find(item => item.id === 'event:block')?.context).toBe('Physics · Courses');
  });
});
