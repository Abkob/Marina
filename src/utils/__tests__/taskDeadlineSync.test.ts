import { describe, expect, it } from 'vitest';
import { synchronizedTaskDeadlineUpdates } from '../../../server/utils/taskDeadline.js';

describe('visible task deadline synchronization', () => {
  it('synchronizes the hidden target date', () => {
    expect(synchronizedTaskDeadlineUpdates(
      { due_date: '2026-08-20' },
      { target_date: '2026-07-01', hard_deadline: null },
    )).toEqual({ target_date: '2026-08-20' });
  });

  it('moves or clears an existing hidden hard deadline', () => {
    expect(synchronizedTaskDeadlineUpdates(
      { due_date: '2026-08-20' },
      { target_date: '2026-07-01', hard_deadline: '2026-07-02' },
    )).toEqual({ target_date: '2026-08-20', hard_deadline: '2026-08-20' });
    expect(synchronizedTaskDeadlineUpdates(
      { due_date: null },
      { target_date: '2026-07-01', hard_deadline: '2026-07-02' },
    )).toEqual({ target_date: null, hard_deadline: null });
  });

  it('respects explicit advanced values from the same request', () => {
    expect(synchronizedTaskDeadlineUpdates(
      { due_date: '2026-08-20', target_date: '2026-08-18', hard_deadline: '2026-08-25' },
      { target_date: '2026-07-01', hard_deadline: '2026-07-02' },
    )).toEqual({});
  });
});
