import { describe, expect, it } from 'vitest';
import { layoutPlan, type BusyInterval } from '../../../server/services/planLayout';

const task = (id: string, minutes: number) => ({ id, title: `Task ${id}`, remaining_minutes: minutes });

describe('layoutPlan', () => {
  it('places a single task at the start of the work window', () => {
    const { blocks, unplaced } = layoutPlan({
      dayAssignments: [{ date: '2026-07-06', task_ids: ['a'] }],
      tasks: [task('a', 90)],
      workStart: 9,
      workEnd: 18,
      busy: [],
    });
    expect(blocks).toEqual([{
      task_id: 'a', title: 'Task a', date: '2026-07-06',
      start_hour: 9, duration_hours: 1.5, planned_minutes: 90,
    }]);
    expect(unplaced).toEqual([]);
  });

  it('stacks tasks back to back in assignment order', () => {
    const { blocks } = layoutPlan({
      dayAssignments: [{ date: '2026-07-06', task_ids: ['a', 'b'] }],
      tasks: [task('a', 60), task('b', 30)],
      workStart: 9,
      workEnd: 18,
      busy: [],
    });
    expect(blocks.map(b => [b.task_id, b.start_hour, b.duration_hours])).toEqual([
      ['a', 9, 1],
      ['b', 10, 0.5],
    ]);
  });

  it('lays blocks around a meeting', () => {
    const busy: BusyInterval[] = [{ date: '2026-07-06', start_hour: 10, end_hour: 11 }];
    const { blocks } = layoutPlan({
      dayAssignments: [{ date: '2026-07-06', task_ids: ['a'] }],
      tasks: [task('a', 60)],
      workStart: 10.5, // work starts inside the meeting
      workEnd: 18,
      busy,
    });
    expect(blocks[0].start_hour).toBe(11); // pushed past the meeting
  });

  it('splits one task across a meeting into two blocks', () => {
    const busy: BusyInterval[] = [{ date: '2026-07-06', start_hour: 10, end_hour: 11 }];
    const { blocks } = layoutPlan({
      dayAssignments: [{ date: '2026-07-06', task_ids: ['a'] }],
      tasks: [task('a', 120)],
      workStart: 9,
      workEnd: 18,
      busy,
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ start_hour: 9, planned_minutes: 60 });
    expect(blocks[1]).toMatchObject({ start_hour: 11, planned_minutes: 60 });
  });

  it('carries leftover work to the next assigned day', () => {
    const { blocks } = layoutPlan({
      dayAssignments: [
        { date: '2026-07-06', task_ids: ['a'] },
        { date: '2026-07-07', task_ids: ['a'] },
      ],
      tasks: [task('a', 10 * 60)], // 10h into 8h days
      workStart: 9,
      workEnd: 17,
      busy: [],
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ date: '2026-07-06', planned_minutes: 8 * 60 });
    expect(blocks[1]).toMatchObject({ date: '2026-07-07', start_hour: 9, planned_minutes: 2 * 60 });
  });

  it('preserves the scheduler allocation for each task and day', () => {
    const { blocks, unplaced } = layoutPlan({
      dayAssignments: [
        { date: '2026-07-06', task_ids: ['a'], task_minutes: { a: 120 } },
        { date: '2026-07-07', task_ids: ['a'], task_minutes: { a: 120 } },
      ],
      tasks: [task('a', 240)],
      workStart: 9,
      workEnd: 18,
      busy: [],
    });

    expect(blocks).toHaveLength(2);
    expect(blocks.map(block => block.planned_minutes)).toEqual([120, 120]);
    expect(unplaced).toEqual([]);
  });

  it('skips slivers shorter than the minimum block', () => {
    // 10-minute gap between work start and the meeting: unusable
    const busy: BusyInterval[] = [{ date: '2026-07-06', start_hour: 9 + 10 / 60, end_hour: 12 }];
    const { blocks } = layoutPlan({
      dayAssignments: [{ date: '2026-07-06', task_ids: ['a'] }],
      tasks: [task('a', 60)],
      workStart: 9,
      workEnd: 18,
      busy,
      minBlockMinutes: 15,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].start_hour).toBe(12);
  });

  it('reports work that has no room as unplaced', () => {
    const { blocks, unplaced } = layoutPlan({
      dayAssignments: [{ date: '2026-07-06', task_ids: ['a', 'b'] }],
      tasks: [task('a', 8 * 60), task('b', 60)],
      workStart: 9,
      workEnd: 17, // exactly 8h — b has no room
      busy: [],
    });
    expect(blocks).toHaveLength(1);
    expect(unplaced).toEqual([{ task_id: 'b', title: 'Task b', minutes: 60 }]);
  });

  it('ignores busy slots outside the work window and merges overlap correctly', () => {
    const busy: BusyInterval[] = [
      { date: '2026-07-06', start_hour: 6, end_hour: 8 },   // before work — irrelevant
      { date: '2026-07-06', start_hour: 9, end_hour: 10 },
      { date: '2026-07-06', start_hour: 9.5, end_hour: 10.5 }, // overlaps previous
    ];
    const { blocks } = layoutPlan({
      dayAssignments: [{ date: '2026-07-06', task_ids: ['a'] }],
      tasks: [task('a', 30)],
      workStart: 9,
      workEnd: 18,
      busy,
    });
    expect(blocks[0].start_hour).toBe(10.5);
  });

  it('is deterministic', () => {
    const input = {
      dayAssignments: [{ date: '2026-07-06', task_ids: ['a', 'b'] }],
      tasks: [task('a', 45), task('b', 200)],
      workStart: 9,
      workEnd: 18,
      busy: [{ date: '2026-07-06', start_hour: 12, end_hour: 13 }],
    };
    expect(layoutPlan(input)).toEqual(layoutPlan(input));
  });
});
