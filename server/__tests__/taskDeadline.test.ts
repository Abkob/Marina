import { describe, expect, it } from 'vitest';
import {
  childDeadlineError,
  dateOnly,
  isDeadlineAfter,
  synchronizedTaskDeadlineUpdates,
} from '../utils/taskDeadline.js';

describe('task deadline hierarchy', () => {
  it('allows a child on or before the parent deadline', () => {
    expect(isDeadlineAfter('2026-08-09', '2026-08-10')).toBe(false);
    expect(isDeadlineAfter('2026-08-10', '2026-08-10')).toBe(false);
  });

  it('rejects a child after the parent deadline', () => {
    expect(isDeadlineAfter('2026-08-11', '2026-08-10')).toBe(true);
  });

  it('compares datetime deadlines by calendar date', () => {
    expect(isDeadlineAfter('2026-08-10T23:59:00', '2026-08-10T08:00:00')).toBe(false);
    expect(dateOnly('2026-08-10T23:59:00')).toBe('2026-08-10');
  });

  it('creates a notification-ready error with the parent title and limit', () => {
    expect(childDeadlineError({ id: 'p', title: 'Parent', due_date: '2026-08-10' }))
      .toBe('Child task deadline must be on or before parent task "Parent" deadline (2026-08-10).');
  });

  it('synchronizes the hidden target when the visible deadline changes', () => {
    expect(synchronizedTaskDeadlineUpdates(
      { due_date: '2026-08-20' },
      { target_date: '2026-07-01', hard_deadline: null },
    )).toEqual({ target_date: '2026-08-20' });
  });

  it('moves an existing hard deadline with the only visible deadline control', () => {
    expect(synchronizedTaskDeadlineUpdates(
      { due_date: '2026-08-20' },
      { target_date: '2026-07-01', hard_deadline: '2026-07-02' },
    )).toEqual({ target_date: '2026-08-20', hard_deadline: '2026-08-20' });
  });

  it('clears hidden dates and respects explicit advanced values', () => {
    expect(synchronizedTaskDeadlineUpdates(
      { due_date: null },
      { target_date: '2026-07-01', hard_deadline: '2026-07-02' },
    )).toEqual({ target_date: null, hard_deadline: null });
    expect(synchronizedTaskDeadlineUpdates(
      { due_date: '2026-08-20', target_date: '2026-08-18', hard_deadline: '2026-08-25' },
      { target_date: '2026-07-01', hard_deadline: '2026-07-02' },
    )).toEqual({});
  });
});
