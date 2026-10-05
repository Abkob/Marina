import { describe, expect, it } from 'vitest';
import { calendarBlockPreviewSchema, calendarBlockSeries, calendarBlockOverlaps, calendarBlockOccurrences } from '../../../server/services/calendarBlockPreview';
import { expandSeries } from '../../../server/services/planLayout';

const prayer = { title: '5 am prayer', start_date: '2026-10-05', end_date: '2026-10-07', start_hour: 5, end_hour: 5.25, days_of_week: [1, 3] };
const breakfast = { title: 'Breakfast', start_date: '2026-10-05', end_date: '2026-10-07', start_hour: 6, end_hour: 7, days_of_week: [1] };
describe('named calendar block previews', () => {
  it('excludes exact saved standalone occurrences and repeated candidates while preserving real overlaps', () => {
    const busy = [{ title: 'Leetcode Practice', date: '2026-10-05', start_hour: 5, duration_hours: 2.5, kind: 'block' as const }];
    const result = calendarBlockOccurrences([
      { ...prayer, title: ' leetcode   practice ', end_hour: 7.5, end_date: prayer.start_date },
      prayer, prayer, breakfast,
    ], busy);
    expect(result.blocks).toHaveLength(3);
    expect(result.already_scheduled).toHaveLength(1);
    expect(result.blocks.filter(block => block.date === '2026-10-05').map(block => block.title)).toEqual(['5 am prayer', 'Breakfast']);
    // Title alone is not identity; a task link must not be dropped based on an unlinked busy record.
    expect(calendarBlockOccurrences([{ ...prayer, title: 'Leetcode Practice', end_hour: 7.5, end_date: prayer.start_date, task_id: 'different-task' }], busy).blocks).toHaveLength(1);
  });
  it('preserves both activities, exact times and independent Monday/Wednesday restrictions without task IDs', () => {
    const args = calendarBlockPreviewSchema.parse({ series: [prayer, breakfast] });
    const blocks = calendarBlockSeries(args).flatMap(expandSeries);
    expect(blocks).toEqual([
      { title: '5 am prayer', date: '2026-10-05', start_hour: 5, duration_hours: 0.25 },
      { title: '5 am prayer', date: '2026-10-07', start_hour: 5, duration_hours: 0.25 },
      { title: 'Breakfast', date: '2026-10-05', start_hour: 6, duration_hours: 1 },
    ]);
    const busy = ['2026-10-05', '2026-10-07'].map(date => ({ title: 'Leetcode Practice', date, start_hour: 5, duration_hours: 2.5, kind: 'block' as const }));
    expect(calendarBlockOverlaps(blocks, busy)).toEqual({ overlap_count: 3, overlaps_omitted: 0, overlaps: [
      { title: '5 am prayer', overlaps_with: 'Leetcode Practice', date: '2026-10-05', start_hour: 5, end_hour: 5.25 },
      { title: '5 am prayer', overlaps_with: 'Leetcode Practice', date: '2026-10-07', start_hour: 5, end_hour: 5.25 },
      { title: 'Breakfast', overlaps_with: 'Leetcode Practice', date: '2026-10-05', start_hour: 6, end_hour: 7 },
    ] });
    expect(blocks[0].start_hour).toBe(5);
  });
  it('keeps legacy single-series calls and supports a single occurrence', () => {
    const parsed = calendarBlockPreviewSchema.parse({ ...prayer, end_date: prayer.start_date });
    expect(calendarBlockSeries(parsed).flatMap(expandSeries)).toHaveLength(1);
  });
  it.each([
    { ...prayer, end_date: '2026-10-04' },
    { ...prayer, end_hour: 5.1 },
    { ...prayer, start_hour: 0, end_hour: 13 },
    { ...prayer, end_date: '2027-10-05' },
    { series: [] },
    { series: [prayer, { ...breakfast, start_date: '2027-10-05', end_date: '2027-10-05' }] },
    { series: Array.from({ length: 11 }, () => prayer) },
    { series: Array.from({ length: 2 }, () => ({ ...prayer, end_date: '2027-02-01', days_of_week: undefined })) },
  ])('rejects unsupported windows/counts/durations instead of producing an unapplyable or truncated card', input => {
    expect(calendarBlockPreviewSchema.safeParse(input).success).toBe(false);
  });
  it('counts proposed overlaps once and treats adjacent or different-date blocks as separate', () => {
    const blocks = [
      { title: 'A', date: '2026-10-05', start_hour: 5, duration_hours: 1 },
      { title: 'B', date: '2026-10-05', start_hour: 5.25, duration_hours: 0.25 },
      { title: 'C', date: '2026-10-05', start_hour: 6, duration_hours: 1 },
      { title: 'D', date: '2026-10-06', start_hour: 5, duration_hours: 1 },
    ];
    expect(calendarBlockOverlaps(blocks, []).overlap_count).toBe(1);
  });
});
