import { beforeEach, expect, it, vi } from 'vitest';
import { workSessionsRouter } from '../../../server/routes/work-sessions';
import { query } from '../../../server/db';
import { getTimeHeatmap } from '../../../server/services/timeHeatmap';

vi.mock('../../../server/db', () => ({ query: vi.fn() }));
beforeEach(() => vi.mocked(query).mockReset());
it('reads a complete year without truncating to the old stats endpoint’s 90 days', async () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({ id: `s-${index}`, started_at: new Date(Date.UTC(2026, 0, index + 1, 12)).toISOString(), ended_at: null, minutes: 30 }));
  vi.mocked(query).mockResolvedValue({ rows: [] } as never).mockResolvedValueOnce({ rows: [{ timezone: 'Asia/Beirut' }] } as never).mockResolvedValueOnce({ rows } as never);
  const result = await getTimeHeatmap(2026);
  expect(result.days).toHaveLength(120);
  expect(result.days.reduce((sum, day) => sum + day.minutes, 0)).toBe(3600);
  expect(result.loggedSessionIds).toHaveLength(120);
  expect(vi.mocked(query).mock.calls.every(([sql]) => sql.trim().startsWith('SELECT'))).toBe(true);
  expect(vi.mocked(query).mock.calls[1][0]).not.toContain('LIMIT');
});
it('attributes calendar blocks through parent tasks, direct meeting goals and missing links', async () => {
  const event = { week_start: '2026-01-05', day_index: 0, start_hour: 9, duration_hours: 2 };
  vi.mocked(query).mockResolvedValueOnce({ rows: [{ timezone: 'UTC' }] } as never)
    .mockResolvedValueOnce({ rows: [] } as never)
    .mockResolvedValueOnce({ rows: [
      { ...event, id: 'linked', title: 'Study', links: [{ task_id: 'child', planned_minutes: 30 }, { task_id: 'parent', planned_minutes: null }] },
      { ...event, start_hour: 12, id: 'missing', title: 'Errand', links: [{ task_id: 'deleted', planned_minutes: 120 }] },
      { ...event, id: 'undated', week_start: null, title: 'Old demo', links: [] },
    ] } as never)
    .mockResolvedValueOnce({ rows: [{ id: 'meeting', title: 'Review', scheduled_at: '2026-01-05T15:00:00Z', duration_minutes: 30, goal_id: 'goal', links: [] }] } as never)
    .mockResolvedValueOnce({ rows: [{ id: 'child', title: 'Quiz', parent_task_id: 'parent', goal_id: null }, { id: 'parent', title: 'Course', parent_task_id: null, goal_id: 'goal' }] } as never)
    .mockResolvedValueOnce({ rows: [{ id: 'goal', title: 'Biology' }] } as never);
  const result = await getTimeHeatmap(2026);
  expect(result.days[0]).toMatchObject({ minutes: 270, calendarMinutes: 270, sessions: 0 });
  expect(result.days[0].details).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: 'Study', taskId: 'child', goalId: 'goal', minutes: 30 }),
    expect.objectContaining({ title: 'Study', taskId: 'parent', minutes: 90 }),
    expect.objectContaining({ title: 'Errand', goalId: null, minutes: 120 }),
    expect.objectContaining({ title: 'Review', goalId: 'goal', goalTitle: 'Biology', minutes: 30 }),
  ]));
  expect(result.sources?.calendar).toHaveLength(3);
});
it('rejects malformed years before reading the database', async () => {
  const route = (workSessionsRouter as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: Function }> } }> }).stack.find(layer => layer.route?.path === '/heatmap')!.route!;
  for (const year of ['bad', '2026.5', '1999', '2101']) {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await route.stack[0].handle({ query: { year } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  }
  expect(query).not.toHaveBeenCalled();
});
