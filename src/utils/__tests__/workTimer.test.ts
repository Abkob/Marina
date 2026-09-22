// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readActiveWorkTimer, writeActiveWorkTimer, WORK_TIMER_STORAGE_KEY, type ActiveWorkTimer } from '../workTimer';

const routineTimer: ActiveWorkTimer = {
  taskId: '',
  routineId: 'routine-1',
  routineTitle: 'Physics revision',
  goalId: 'physics',
  routineDate: '2026-09-22',
  sessionId: 'e16487c7-a140-4e07-9c89-18150952b659',
  startedAt: '2026-09-22T22:30:00.000Z',
  notes: 'Review chapter 3',
};

describe('shared work timer state', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    });
  });

  it('lets the calendar start a timer that the Work view can read and clear', () => {
    const timer = { taskId: 'task-1', startedAt: '2026-08-11T10:00:00.000Z', notes: '' };
    writeActiveWorkTimer(timer);
    expect(readActiveWorkTimer()).toEqual(timer);

    writeActiveWorkTimer(null);
    expect(readActiveWorkTimer()).toBeNull();
  });

  it('preserves the routine, occurrence date, notes and idempotency key across navigation', () => {
    writeActiveWorkTimer(routineTimer);
    expect(readActiveWorkTimer()).toEqual(routineTimer);
  });

  it('keeps routine dates as the original local day instead of deriving them from UTC', () => {
    writeActiveWorkTimer({ ...routineTimer, routineDate: '2026-09-23' });
    expect(readActiveWorkTimer()?.routineDate).toBe('2026-09-23');
  });

  it('still accepts old task timers without notes', () => {
    window.localStorage.setItem(WORK_TIMER_STORAGE_KEY, JSON.stringify({ taskId: 'task-1', startedAt: routineTimer.startedAt }));
    expect(readActiveWorkTimer()).toEqual({ taskId: 'task-1', startedAt: routineTimer.startedAt, notes: '' });
  });

  it.each([
    null, [], {}, { taskId: 123, startedAt: routineTimer.startedAt },
    { taskId: 'task-1', startedAt: 'not a date' },
    { ...routineTimer, routineDate: '2026-02-30' },
    { ...routineTimer, sessionId: '' },
    { ...routineTimer, taskId: 'task-1' },
    { ...routineTimer, notes: {} },
    { ...routineTimer, routineTitle: '' },
  ])('rejects malformed timer data without crashing (%j)', value => {
    window.localStorage.setItem(WORK_TIMER_STORAGE_KEY, JSON.stringify(value));
    expect(readActiveWorkTimer()).toBeNull();
  });

  it('does not overwrite a valid running timer with invalid data', () => {
    writeActiveWorkTimer(routineTimer);
    writeActiveWorkTimer({ ...routineTimer, startedAt: 'broken' });
    expect(readActiveWorkTimer()).toEqual(routineTimer);
  });
});
