import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DBTask } from '../../db/schema';
import {
  computeGoalTimeStats,
  projectedFinishDate,
  formatProjectedDate,
  formatVelocity,
  velocityColor,
} from '../goalTimeAnalytics';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let taskId = 0;
function makeTask(overrides: Partial<DBTask> = {}): DBTask {
  return {
    id: `task-${++taskId}`,
    goal_id: 'g1',
    parent_task_id: null,
    title: 'Task',
    description: '',
    status: 'todo',
    priority: 'medium',
    kind: 'manual',
    critical_path_status: null,
    tags_json: '[]',
    due_date: null,
    estimated_duration: null,
    estimated_minutes: null,
    actual_minutes: null,
    weight_percent: null,
    completed: false,
    position: 0,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  };
}

// ─── computeGoalTimeStats ─────────────────────────────────────────────────────

describe('computeGoalTimeStats', () => {
  it('has zero remaining work for an empty task list', () => {
    const s = computeGoalTimeStats([]);
    expect(s.spentMinutes).toBe(0);
    expect(s.velocityRatio).toBeNull();
    expect(s.estimatedRemainingMinutes).toBe(0);
    expect(s.adjustedRemainingMinutes).toBe(0);
    expect(s.velocityConfidence).toBe('none');
    expect(s.taskCount).toBe(0);
  });

  it('sums actual_minutes of completed tasks as spentMinutes', () => {
    const tasks = [
      makeTask({ completed: true, actual_minutes: 60 }),
      makeTask({ completed: true, actual_minutes: 30 }),
      makeTask({ completed: false }),
    ];
    expect(computeGoalTimeStats(tasks).spentMinutes).toBe(90);
  });

  it('ignores null actual_minutes in spentMinutes', () => {
    const tasks = [
      makeTask({ completed: true, actual_minutes: 45 }),
      makeTask({ completed: true, actual_minutes: null }),
    ];
    expect(computeGoalTimeStats(tasks).spentMinutes).toBe(45);
  });

  it('computes velocity from completed tasks with both values', () => {
    const tasks = [
      makeTask({ completed: true, estimated_minutes: 60, actual_minutes: 90 }),
    ];
    const s = computeGoalTimeStats(tasks);
    expect(s.velocityRatio).toBeCloseTo(1.5);
    expect(s.velocityConfidence).toBe('low');
  });

  it('returns null velocityRatio when no completed tasks have both values', () => {
    const tasks = [
      makeTask({ completed: true, estimated_minutes: 60, actual_minutes: null }),
      makeTask({ completed: false, estimated_minutes: 30 }),
    ];
    expect(computeGoalTimeStats(tasks).velocityRatio).toBeNull();
  });

  it('confidence: low for 1-2 pairs, medium for 3-7, high for 8+', () => {
    const pair = () => makeTask({ completed: true, estimated_minutes: 60, actual_minutes: 60 });
    expect(computeGoalTimeStats([pair()]).velocityConfidence).toBe('low');
    expect(computeGoalTimeStats([pair(), pair(), pair()]).velocityConfidence).toBe('medium');
    expect(computeGoalTimeStats(Array.from({ length: 8 }, pair)).velocityConfidence).toBe('high');
  });

  it('shows historical velocity without silently changing a current forecast', () => {
    const tasks = [
      makeTask({ completed: true, estimated_minutes: 60, actual_minutes: 90 }),
      makeTask({ completed: false, estimated_minutes: 60 }),
    ];
    const s = computeGoalTimeStats(tasks);
    expect(s.estimatedRemainingMinutes).toBe(60);
    expect(s.adjustedRemainingMinutes).toBe(60);
  });

  it('remaining equals estimated when no velocity data', () => {
    const tasks = [makeTask({ completed: false, estimated_minutes: 120 })];
    const s = computeGoalTimeStats(tasks);
    expect(s.adjustedRemainingMinutes).toBe(120);
    expect(s.estimatedRemainingMinutes).toBe(120);
  });

  it('estimatedRemainingMinutes null when no incomplete tasks have estimates', () => {
    const tasks = [makeTask({ completed: false, estimated_minutes: null })];
    expect(computeGoalTimeStats(tasks).estimatedRemainingMinutes).toBeNull();
  });
});

// ─── projectedFinishDate ──────────────────────────────────────────────────────

describe('projectedFinishDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-24T10:00:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when no remaining minutes', () => {
    const tasks: DBTask[] = [];
    const s = computeGoalTimeStats(tasks);
    expect(projectedFinishDate(s)).toBeNull();
  });

  it('returns null when adjustedRemainingMinutes is 0', () => {
    const tasks = [makeTask({ completed: true, estimated_minutes: 60, actual_minutes: 60 })];
    const s = computeGoalTimeStats(tasks);
    // No incomplete tasks → no remaining → null
    expect(projectedFinishDate(s)).toBeNull();
  });

  it('8h remaining at 1.0× velocity, 4h/day → 2 days from today', () => {
    const tasks = [
      makeTask({ completed: true, estimated_minutes: 60, actual_minutes: 60 }),
      makeTask({ completed: false, estimated_minutes: 480 }), // 8h
    ];
    const s = computeGoalTimeStats(tasks);
    // adjustedRemainingMinutes = 480 * 1.0 = 480 min = 8h / 4h/day = 2 days
    const result = projectedFinishDate(s, 4);
    expect(result).not.toBeNull();
    const expected = new Date('2026-06-26');
    expect(result!.toDateString()).toBe(expected.toDateString());
  });

  it('8h remaining at 4h/day is a 2-day illustration regardless of historical velocity', () => {
    const tasks = [
      makeTask({ completed: true, estimated_minutes: 60, actual_minutes: 120 }), // 2× velocity
      makeTask({ completed: false, estimated_minutes: 480 }),                     // 8h estimated
    ];
    const s = computeGoalTimeStats(tasks);
    // adjustedRemainingMinutes = 480 * 2.0 = 960 min = 16h / 4h/day = 4 days
    const result = projectedFinishDate(s, 4);
    expect(result).not.toBeNull();
    const expected = new Date('2026-06-26');
    expect(result!.toDateString()).toBe(expected.toDateString());
  });

  it('fractional days round up', () => {
    const tasks = [
      makeTask({ completed: true, estimated_minutes: 60, actual_minutes: 60 }),
      makeTask({ completed: false, estimated_minutes: 61 }), // just over 1h
    ];
    const s = computeGoalTimeStats(tasks);
    // 61 min / 60 / 4 = ~0.25 days → ceil = 1 day
    const result = projectedFinishDate(s, 4);
    const expected = new Date('2026-06-25');
    expect(result!.toDateString()).toBe(expected.toDateString());
  });
});

// ─── formatProjectedDate ──────────────────────────────────────────────────────

describe('formatProjectedDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-24T10:00:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "Today" for today', () => {
    expect(formatProjectedDate(new Date('2026-06-24'))).toBe('Today');
  });

  it('returns "Tomorrow" for +1 day', () => {
    expect(formatProjectedDate(new Date('2026-06-25'))).toBe('Tomorrow');
  });

  it('returns weekday name for +2 to +6 days', () => {
    expect(formatProjectedDate(new Date('2026-06-27'))).toBe('Saturday');
  });

  it('returns "MMM D" for dates 7+ days away', () => {
    expect(formatProjectedDate(new Date('2026-07-10'))).toMatch(/Jul 10/);
  });
});

// ─── formatVelocity ───────────────────────────────────────────────────────────

describe('formatVelocity', () => {
  it('shows "ahead" when under 0.85×', () => {
    expect(formatVelocity(0.7)).toContain('ahead');
  });

  it('shows "On pace" between 0.85× and 1.15×', () => {
    expect(formatVelocity(1.0)).toBe('On pace');
    expect(formatVelocity(0.85)).toBe('On pace');
    expect(formatVelocity(1.15)).toBe('On pace');
  });

  it('shows "running over" above 1.15×', () => {
    expect(formatVelocity(1.5)).toContain('running over');
  });
});

// ─── velocityColor ────────────────────────────────────────────────────────────

describe('velocityColor', () => {
  it('emerald when ahead', () => {
    expect(velocityColor(0.7)).toContain('emerald');
  });

  it('indigo when on pace', () => {
    expect(velocityColor(1.0)).toContain('4648d4');
  });

  it('amber when moderately over', () => {
    expect(velocityColor(1.3)).toContain('amber');
  });

  it('red when very over', () => {
    expect(velocityColor(2.0)).toContain('red');
  });
});
