import { describe, expect, it } from 'vitest';
import { mobileScheduleItems } from '../mobileSchedule';
import type { DBEvent, DBTask } from '../../db/schema';
import type { ScheduleDay } from '../../api/hooks';
import { calendarDateTime } from '../calendar';

const date = '2026-09-24';
const task = (id: string, patch: Partial<DBTask> = {}) => ({ id, title: id, status: 'todo', completed: false, start_date: null, due_date: null, estimated_minutes: 30, ...patch }) as DBTask;
const base = { date, events: [], meetings: [], tasks: [], blockedTaskIds: new Set<string>() };

describe('mobile schedule data', () => {
  it('keeps meetings and the today marker in the schedule timezone across midnight', () => {
    expect(calendarDateTime(new Date('2026-09-24T22:30:00Z'), 'Asia/Beirut')).toEqual({ date: '2026-09-25', hour: 1.5 });
    expect(calendarDateTime(new Date('2026-09-24T21:00:00Z'), 'Asia/Beirut')).toEqual({ date: '2026-09-25', hour: 0 });
  });
  it('shows assigned work, start dates and deadlines, without duplicating linked blocks or completed work', () => {
    const result = mobileScheduleItems({ ...base,
      tasks: [task('scheduled', { start_date: date }), task('suggested'), task('linked', { start_date: date }), task('due', { due_date: date }), task('done', { start_date: date, completed: true }), task('backlog')],
      assignment: { date, available_minutes: 400, used_minutes: 15, task_ids: ['suggested'], task_minutes: { suggested: 15 } },
      blockedTaskIds: new Set([`linked|${date}`]),
    });
    expect(result.map(item => item.title).sort()).toEqual(['due', 'scheduled', 'suggested']);
    expect(result.find(item => item.title === 'suggested')).toMatchObject({ detail: 'Suggested by your plan', minutes: 15 });
  });
  it('retains a due reminder even when the task already has a timed block', () => {
    expect(mobileScheduleItems({ ...base, tasks: [task('due', { due_date: date })], blockedTaskIds: new Set([`due|${date}`]) })[0].detail).toBe('Due today');
  });
  it('sorts timed items and handles midnight and flexible routines', () => {
    const day = { date, tasks: [], deadlines: [], routines: [
      { routine_id: 'midnight', title: 'Midnight', date, minutes: 5, preferred_time: '00:00' },
      { routine_id: 'flexible', title: 'Flexible', date, minutes: 20, preferred_time: null },
    ] } as ScheduleDay;
    const result = mobileScheduleItems({ ...base, day,
      events: [{ date, event: { id: 'event', title: 'Event', start_hour: 10, duration_hours: 1, type: 'Focus' } as DBEvent }, { date: '2026-09-25', event: { id: 'other' } as DBEvent }],
      meetings: [{ id: 'meeting', title: 'Meeting', date, startHour: 9, durationHours: 0.5 }],
    });
    expect(result.map(item => item.title)).toEqual(['Flexible', 'Midnight', 'Meeting', 'Event']);
    expect(result[1].start).toBe(0);
  });
});
