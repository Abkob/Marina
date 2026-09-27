import { beforeEach, expect, it, vi } from 'vitest';
import { workSessionsRouter } from '../../../server/routes/work-sessions';
import { query } from '../../../server/db';
import { getTimeHeatmap } from '../../../server/services/timeHeatmap';

vi.mock('../../../server/db', () => ({ query: vi.fn() }));
beforeEach(() => vi.mocked(query).mockReset());
it('reads a complete year without truncating to the old stats endpoint’s 90 days', async () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({ id: `s-${index}`, started_at: new Date(Date.UTC(2026, 0, index + 1, 12)).toISOString(), ended_at: null, minutes: 30 }));
  vi.mocked(query).mockResolvedValueOnce({ rows: [{ timezone: 'Asia/Beirut' }] } as never).mockResolvedValueOnce({ rows } as never);
  const result = await getTimeHeatmap(2026);
  expect(result.days).toHaveLength(120);
  expect(result.days.reduce((sum, day) => sum + day.minutes, 0)).toBe(3600);
  expect(result.loggedSessionIds).toHaveLength(120);
  expect(vi.mocked(query).mock.calls.every(([sql]) => sql.trim().startsWith('SELECT'))).toBe(true);
  expect(vi.mocked(query).mock.calls[1][0]).not.toContain('LIMIT');
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
