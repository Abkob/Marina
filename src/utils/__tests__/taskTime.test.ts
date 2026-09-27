import { describe, it, expect } from 'vitest';
import type { DBTask } from '../../db/schema';
import {
  parseTaskTimeInput,
  formatTaskTime,
  formatTaskTimeLong,
  normalizeTaskMinutes,
  getTaskEstimatedMinutes,
  getTaskLeafProgress,
  getRolledUpActualTime,
  getRolledUpTime,
} from '../taskTime';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<DBTask> = {}): DBTask {
  return {
    id: crypto.randomUUID(),
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
    weight_percent: null,
    completed: false,
    position: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── normalizeTaskMinutes ──────────────────────────────────────────────────────

describe('normalizeTaskMinutes', () => {
  it('returns null for null/undefined', () => {
    expect(normalizeTaskMinutes(null)).toBeNull();
    expect(normalizeTaskMinutes(undefined)).toBeNull();
  });

  it('clamps to 0 for negatives', () => {
    expect(normalizeTaskMinutes(-10)).toBe(0);
  });

  it('clamps to MAX for huge values', () => {
    expect(normalizeTaskMinutes(999_999_999)).toBe(60_000);
  });

  it('rounds to integer', () => {
    expect(normalizeTaskMinutes(1.7)).toBe(2);
  });
});

describe('getRolledUpActualTime', () => {
  it('adds direct and nested child logs without double counting', () => {
    const parent = makeTask({ id: 'P', actual_minutes: 15 });
    const child = makeTask({ id: 'C', parent_task_id: 'P', actual_minutes: 30 });
    const grandchild = makeTask({ id: 'GC', parent_task_id: 'C', actual_minutes: 45 });

    const result = getRolledUpActualTime(parent, [parent, child, grandchild]);

    expect(result).toEqual({
      minutes: 90,
      ownMinutes: 15,
      childrenMinutes: 75,
      contributingChildren: 2,
    });
  });

  it('returns zero when no task in the subtree has logged time', () => {
    const parent = makeTask({ id: 'P' });
    const child = makeTask({ id: 'C', parent_task_id: 'P' });

    expect(getRolledUpActualTime(parent, [parent, child])).toEqual({
      minutes: 0,
      ownMinutes: 0,
      childrenMinutes: 0,
      contributingChildren: 0,
    });
  });
});

// ─── parseTaskTimeInput ────────────────────────────────────────────────────────

describe('parseTaskTimeInput', () => {
  it('returns null for empty / null input', () => {
    expect(parseTaskTimeInput(null)).toBeNull();
    expect(parseTaskTimeInput('')).toBeNull();
    expect(parseTaskTimeInput('  ')).toBeNull();
  });

  it('parses plain hours (1h, 2hr, 3hrs)', () => {
    expect(parseTaskTimeInput('1h')).toBe(60);
    expect(parseTaskTimeInput('2hr')).toBe(120);
    expect(parseTaskTimeInput('3hrs')).toBe(180);
  });

  it('parses plain minutes (30m, 45min, 90minutes)', () => {
    expect(parseTaskTimeInput('30m')).toBe(30);
    expect(parseTaskTimeInput('45min')).toBe(45);
    expect(parseTaskTimeInput('90minutes')).toBe(90);
  });

  it('parses compound h+m (1h 30m, 2h 15min)', () => {
    expect(parseTaskTimeInput('1h 30m')).toBe(90);
    expect(parseTaskTimeInput('2h 15min')).toBe(135);
    expect(parseTaskTimeInput('1h30m')).toBe(90);
  });

  it('treats small plain numbers as hours (<= 12)', () => {
    expect(parseTaskTimeInput('2')).toBe(120);
    expect(parseTaskTimeInput('12')).toBe(720);
  });

  it('treats larger plain numbers as minutes (> 12)', () => {
    expect(parseTaskTimeInput('45')).toBe(45);
    expect(parseTaskTimeInput('90')).toBe(90);
  });

  it('handles decimal hours (1.5h)', () => {
    expect(parseTaskTimeInput('1.5h')).toBe(90);
    expect(parseTaskTimeInput('0.5h')).toBe(30);
  });

  it('handles "Est. 1 hr" fallback format', () => {
    expect(parseTaskTimeInput('Est. 1 hr')).toBe(60);
  });
});

// ─── formatTaskTime ────────────────────────────────────────────────────────────

describe('formatTaskTime', () => {
  it('returns "Time" for null / zero', () => {
    expect(formatTaskTime(null)).toBe('Time');
    expect(formatTaskTime(0)).toBe('Time');
  });

  it('formats minutes under an hour', () => {
    expect(formatTaskTime(30)).toBe('30m');
    expect(formatTaskTime(59)).toBe('59m');
  });

  it('formats exact hours', () => {
    expect(formatTaskTime(60)).toBe('1h');
    expect(formatTaskTime(120)).toBe('2h');
  });

  it('formats hours + minutes', () => {
    expect(formatTaskTime(90)).toBe('1h 30m');
    expect(formatTaskTime(135)).toBe('2h 15m');
  });
});

// ─── formatTaskTimeLong ───────────────────────────────────────────────────────

describe('formatTaskTimeLong', () => {
  it('formats short durations as minutes', () => {
    expect(formatTaskTimeLong(45)).toBe('45 min');
  });

  it('formats singular "hr"', () => {
    expect(formatTaskTimeLong(60)).toBe('1 hr');
  });

  it('formats plural "hrs"', () => {
    expect(formatTaskTimeLong(120)).toBe('2 hrs');
  });

  it('formats hours + minutes', () => {
    expect(formatTaskTimeLong(90)).toBe('1 hr 30 min');
  });
});

// ─── getTaskEstimatedMinutes ──────────────────────────────────────────────────

describe('getTaskEstimatedMinutes', () => {
  it('returns null when no time is set', () => {
    expect(getTaskEstimatedMinutes(makeTask())).toBeNull();
  });

  it('prefers estimated_minutes when set', () => {
    const task = makeTask({ estimated_minutes: 90, estimated_duration: '2h' });
    expect(getTaskEstimatedMinutes(task)).toBe(90);
  });

  it('falls back to estimated_duration string when estimated_minutes is null', () => {
    const task = makeTask({ estimated_duration: '1h 30m' });
    expect(getTaskEstimatedMinutes(task)).toBe(90);
  });
});

// ─── getTaskLeafProgress ─────────────────────────────────────────────────────

describe('getTaskLeafProgress', () => {
  it('completed task → 1 immediately regardless of children', () => {
    const task = makeTask({ id: 'A', completed: true });
    expect(getTaskLeafProgress(task, [task])).toBe(1);
  });

  it('status=done task → 1 immediately', () => {
    const task = makeTask({ id: 'A', status: 'done' });
    expect(getTaskLeafProgress(task, [task])).toBe(1);
  });

  it('leaf with no children and not complete → 0', () => {
    const task = makeTask({ id: 'A' });
    expect(getTaskLeafProgress(task, [task])).toBe(0);
  });

  it('50% children done → 0.5', () => {
    const parent = makeTask({ id: 'P' });
    const c1 = makeTask({ id: 'C1', parent_task_id: 'P', completed: true });
    const c2 = makeTask({ id: 'C2', parent_task_id: 'P' });
    expect(getTaskLeafProgress(parent, [parent, c1, c2])).toBe(0.5);
  });

  it('all children done → 1', () => {
    const parent = makeTask({ id: 'P' });
    const c1 = makeTask({ id: 'C1', parent_task_id: 'P', completed: true });
    const c2 = makeTask({ id: 'C2', parent_task_id: 'P', completed: true });
    expect(getTaskLeafProgress(parent, [parent, c1, c2])).toBe(1);
  });

  it('3-level hierarchy — progress rolls up from leaves', () => {
    const gp = makeTask({ id: 'GP' });
    const p  = makeTask({ id: 'P', parent_task_id: 'GP' });
    const c1 = makeTask({ id: 'C1', parent_task_id: 'P', completed: true });
    const c2 = makeTask({ id: 'C2', parent_task_id: 'P' });
    // GP has 1 intermediate child P, whose leaves are 1/2 done → 0.5
    expect(getTaskLeafProgress(gp, [gp, p, c1, c2])).toBe(0.5);
  });

  it('children with status=done count as completed', () => {
    const parent = makeTask({ id: 'P' });
    const c1 = makeTask({ id: 'C1', parent_task_id: 'P', status: 'done' });
    const c2 = makeTask({ id: 'C2', parent_task_id: 'P' });
    expect(getTaskLeafProgress(parent, [parent, c1, c2])).toBe(0.5);
  });
});

// ─── getRolledUpTime ─────────────────────────────────────────────────────────

describe('getRolledUpTime', () => {
  it('leaf with own time → returns own time, isRollup=false', () => {
    const task = makeTask({ id: 'A', estimated_minutes: 60 });
    const result = getRolledUpTime(task, [task]);
    expect(result).toEqual({ minutes: 60, isRollup: false, ownMinutes: 60, childrenSum: null });
  });

  it('leaf without time → minutes is null', () => {
    const task = makeTask({ id: 'A' });
    const result = getRolledUpTime(task, [task]);
    expect(result.minutes).toBeNull();
    expect(result.isRollup).toBe(false);
    expect(result.ownMinutes).toBeNull();
  });

  it('parent with no own time + two timed children → sums children, isRollup=true', () => {
    const parent = makeTask({ id: 'P' });
    const c1     = makeTask({ id: 'C1', parent_task_id: 'P', estimated_minutes: 30 });
    const c2     = makeTask({ id: 'C2', parent_task_id: 'P', estimated_minutes: 45 });
    const all    = [parent, c1, c2];

    const result = getRolledUpTime(parent, all);
    expect(result.minutes).toBe(75);
    expect(result.isRollup).toBe(true);
    expect(result.ownMinutes).toBeNull();
    expect(result.childrenSum).toBe(75);
  });

  it('parent own time + child time → total is own + child (additive overhead)', () => {
    const parent = makeTask({ id: 'P', estimated_minutes: 60 });
    const child  = makeTask({ id: 'C', parent_task_id: 'P', estimated_minutes: 90 });
    const all    = [parent, child];

    const result = getRolledUpTime(parent, all);
    expect(result.minutes).toBe(150);      // 60 own overhead + 90 subtask
    expect(result.isRollup).toBe(true);
    expect(result.ownMinutes).toBe(60);
    expect(result.childrenSum).toBe(90);
  });

  it('inclusive child time stays inside the parent estimate', () => {
    const parent = makeTask({ id: 'P', estimated_minutes: 240 });
    const child  = makeTask({ id: 'C', parent_task_id: 'P', estimated_minutes: 90, time_rollup_mode: 'inclusive' });
    const all    = [parent, child];

    const result = getRolledUpTime(parent, all);
    expect(result.minutes).toBe(240);
    expect(result.isRollup).toBe(true);
    expect(result.ownMinutes).toBe(240);
    expect(result.childrenSum).toBe(90);
    expect(result.includedChildrenSum).toBe(90);
    expect(result.extraChildrenSum).toBeNull();
  });

  it('inclusive child can raise the parent total when it exceeds the parent estimate', () => {
    const parent = makeTask({ id: 'P', estimated_minutes: 60 });
    const child  = makeTask({ id: 'C', parent_task_id: 'P', estimated_minutes: 90, time_rollup_mode: 'inclusive' });
    const all    = [parent, child];

    const result = getRolledUpTime(parent, all);
    expect(result.minutes).toBe(90);
    expect(result.childrenSum).toBe(90);
    expect(result.includedChildrenSum).toBe(90);
  });

  it('mixes included child time with extra child time', () => {
    const parent   = makeTask({ id: 'P', estimated_minutes: 240 });
    const included = makeTask({ id: 'C1', parent_task_id: 'P', estimated_minutes: 90, time_rollup_mode: 'inclusive' });
    const extra    = makeTask({ id: 'C2', parent_task_id: 'P', estimated_minutes: 120 });
    const all      = [parent, included, extra];

    const result = getRolledUpTime(parent, all);
    expect(result.minutes).toBe(360);
    expect(result.childrenSum).toBe(210);
    expect(result.includedChildrenSum).toBe(90);
    expect(result.extraChildrenSum).toBe(120);
  });

  it('parent own time + multiple children → own + sum of all children', () => {
    const parent = makeTask({ id: 'P', estimated_minutes: 30 });
    const c1     = makeTask({ id: 'C1', parent_task_id: 'P', estimated_minutes: 60 });
    const c2     = makeTask({ id: 'C2', parent_task_id: 'P', estimated_minutes: 45 });
    const all    = [parent, c1, c2];

    const result = getRolledUpTime(parent, all);
    expect(result.minutes).toBe(135);      // 30 + 60 + 45
    expect(result.childrenSum).toBe(105);
  });

  it('three levels deep — no own times → rolls up leaf times all the way', () => {
    const grandparent = makeTask({ id: 'GP' });
    const parent      = makeTask({ id: 'P',  parent_task_id: 'GP' });
    const child       = makeTask({ id: 'C',  parent_task_id: 'P', estimated_minutes: 30 });
    const child2      = makeTask({ id: 'C2', parent_task_id: 'P', estimated_minutes: 20 });
    const all         = [grandparent, parent, child, child2];

    const parentResult = getRolledUpTime(parent, all);
    expect(parentResult.minutes).toBe(50);

    const gpResult = getRolledUpTime(grandparent, all);
    expect(gpResult.minutes).toBe(50);
    expect(gpResult.isRollup).toBe(true);
  });

  it('three levels with own times at each level → accumulates overhead all the way up', () => {
    const grandparent = makeTask({ id: 'GP', estimated_minutes: 30 });
    const parent      = makeTask({ id: 'P',  parent_task_id: 'GP', estimated_minutes: 20 });
    const child       = makeTask({ id: 'C',  parent_task_id: 'P', estimated_minutes: 60 });
    const all         = [grandparent, parent, child];

    const parentResult = getRolledUpTime(parent, all);
    expect(parentResult.minutes).toBe(80);      // 20 own + 60 child

    const gpResult = getRolledUpTime(grandparent, all);
    expect(gpResult.minutes).toBe(110);         // 30 own + 80 (parent total)
    expect(gpResult.ownMinutes).toBe(30);
    expect(gpResult.childrenSum).toBe(80);
  });

  it('children without times → falls back to parent own time, isRollup=false', () => {
    const parent = makeTask({ id: 'P', estimated_minutes: 60 });
    const child  = makeTask({ id: 'C', parent_task_id: 'P' }); // no time
    const all    = [parent, child];

    const result = getRolledUpTime(parent, all);
    expect(result.minutes).toBe(60);
    expect(result.isRollup).toBe(false);
    expect(result.childrenSum).toBeNull();
  });

  it('mixed children — some timed, some not — sums only timed ones', () => {
    const parent  = makeTask({ id: 'P' });
    const timed   = makeTask({ id: 'C1', parent_task_id: 'P', estimated_minutes: 60 });
    const untimed = makeTask({ id: 'C2', parent_task_id: 'P' });
    const all     = [parent, timed, untimed];

    const result = getRolledUpTime(parent, all);
    expect(result.minutes).toBe(60);
    expect(result.isRollup).toBe(true);
    expect(result.ownMinutes).toBeNull();
  });
});
