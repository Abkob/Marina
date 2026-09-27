import { Router } from 'express';
import { query } from '../db.js';
import { calculateGoalTaskMetrics } from '../../src/utils/goalTaskMetrics.js';
import { createGoal, updateGoal, deleteGoal } from '../services/goalService.js';

const router = Router();

export async function syncGoalMetrics(goalId: string) {
  const { rows: tasks } = await query('SELECT * FROM tasks WHERE goal_id = $1', [goalId]);
  const metrics = calculateGoalTaskMetrics(tasks as unknown as Parameters<typeof calculateGoalTaskMetrics>[0]);
  await query(
    'UPDATE goals SET progress = $1, activity_level = $2, updated_at = $3 WHERE id = $4',
    [metrics.progress, metrics.activityLevel, new Date().toISOString(), goalId],
  );
  return metrics;
}

// GET /api/goals?limit=N&offset=N&archived=true
router.get('/', async (req, res) => {
  const limit  = Math.min(Math.max(1, Number(req.query.limit)  || 200), 200);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const archived = req.query.archived === 'true';
  const where = archived ? '' : 'WHERE archived_at IS NULL';
  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(`SELECT * FROM goals ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]),
    query<{ total: string }>(`SELECT COUNT(*)::int AS total FROM goals ${where}`),
  ]);
  res.setHeader('X-Total-Count', String(Number(countRows[0]?.total ?? 0)));
  res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');
  res.json(rows);
});

// GET /api/goals/health — aggregate task health for all goals in one query (eliminates N+1)
// Registered BEFORE '/:id' — otherwise Express matches 'health' as a goal id and 404s.
router.get('/health', async (_req, res) => {
  const { rows } = await query<{
    goal_id: string;
    total: string;
    completed: string;
    overdue: string;
    in_progress: string;
    estimated_minutes_total: string;
    actual_minutes_total: string;
    earliest_due: string | null;
    latest_due: string | null;
  }>(`
    SELECT
      goal_id,
      COUNT(*)::int                                          AS total,
      SUM(CASE WHEN completed THEN 1 ELSE 0 END)::int       AS completed,
      SUM(CASE WHEN NOT completed AND status <> 'done' AND due_date < CURRENT_DATE::text THEN 1 ELSE 0 END)::int AS overdue,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END)::int AS in_progress,
      COALESCE(SUM(CASE WHEN NOT completed THEN estimated_minutes ELSE 0 END), 0)::int AS estimated_minutes_total,
      COALESCE(SUM(actual_minutes), 0)::int                 AS actual_minutes_total,
      MIN(CASE WHEN NOT completed THEN due_date END)        AS earliest_due,
      MAX(CASE WHEN NOT completed THEN due_date END)        AS latest_due
    FROM tasks
    WHERE goal_id IS NOT NULL
    GROUP BY goal_id
  `);
  res.json(rows);
});

// GET /api/goals/:id
router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM goals WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// POST /api/goals
router.post('/', async (req, res) => {
  const b = req.body;
  const id = await createGoal({
    title: b.title,
    description: b.description,
    category: b.category,
    status: b.status,
    deadline: b.deadline ?? null,
  });
  res.json({ id });
});

// PATCH /api/goals/:id
router.patch('/:id', async (req, res) => {
  await updateGoal(req.params.id, req.body);
  res.json({ ok: true });
});

// DELETE /api/goals/:id
router.delete('/:id', async (req, res) => {
  await deleteGoal(req.params.id);
  res.json({ ok: true });
});

// POST /api/goals/:id/sync-metrics
router.post('/:id/sync-metrics', async (req, res) => {
  const metrics = await syncGoalMetrics(req.params.id);
  res.json(metrics);
});

export { router as goalsRouter };
