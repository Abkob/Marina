import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { workSessionsRouter } from '../../../server/routes/work-sessions';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../../server/db.js', () => ({ query: mocks.query }));

describe('work-session goal statistics', () => {
  beforeEach(() => mocks.query.mockReset());

  it('includes directly goal-linked routine sessions and falls back to task goals for legacy logs', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ total_minutes: 30, session_count: 2, manual_minutes: 30, journal_minutes: 0 }] })
      .mockResolvedValueOnce({ rows: [{ day: '2026-09-22', minutes: 30, sessions: 2 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'goal-1', title: 'Physics', minutes: 30, tasks_worked: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', title: 'Chapter', minutes: 10, sessions: 1 }] });
    const route = workSessionsRouter.stack.find(layer => layer.route?.path === '/stats')?.route;
    const json = vi.fn();
    await route.stack[0].handle(
      { query: { from: '2026-09-21', to: '2026-09-27', goal_id: 'goal-1' } } as unknown as Request,
      { json } as unknown as Response,
      vi.fn(),
    );
    expect(mocks.query).toHaveBeenCalledTimes(4);
    for (const [sql, parameters] of mocks.query.mock.calls) {
      expect(sql).toContain('COALESCE(ws.goal_id, t.goal_id) = $3');
      expect(parameters).toEqual(['2026-09-21', '2026-09-27T23:59:59', 'goal-1']);
    }
    const byGoalQuery = mocks.query.mock.calls[2][0];
    expect(byGoalQuery).toContain('LEFT JOIN tasks t ON t.id = ws.task_id');
    expect(byGoalQuery).toContain('JOIN goals g ON g.id = COALESCE(ws.goal_id, t.goal_id)');
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      total_minutes: 30,
      by_goal: [{ id: 'goal-1', title: 'Physics', minutes: 30, tasks_worked: 1 }],
    }));
  });
});
