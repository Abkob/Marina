import { Router } from 'express';
import crypto from 'crypto';
import { query } from '../db.js';

const router = Router();

async function recalcActualMinutes(taskId: string) {
  const { rows } = await query(
    'SELECT SUM(minutes) as total FROM work_sessions WHERE task_id=$1 AND minutes IS NOT NULL',
    [taskId],
  );
  const total = Number((rows[0] as Record<string, unknown>).total ?? 0);
  await query('UPDATE tasks SET actual_minutes=$1, updated_at=$2 WHERE id=$3', [total, new Date().toISOString(), taskId]);
}

// GET /api/work-sessions/stats?from=YYYY-MM-DD&to=YYYY-MM-DD&goal_id=xxx
router.get('/stats', async (req, res) => {
  const { from, to, goal_id } = req.query as Record<string, string>;
  const params: unknown[] = [];
  let dateFilter = '';
  if (from) { params.push(from); dateFilter += ` AND ws.started_at >= $${params.length}`; }
  if (to)   { params.push(to + 'T23:59:59'); dateFilter += ` AND ws.started_at <= $${params.length}`; }

  let goalFilter = '';
  if (goal_id) { params.push(goal_id); goalFilter = ` AND COALESCE(ws.goal_id, t.goal_id) = $${params.length}`; }

  const [
    { rows: totalRows },
    { rows: byDay },
    { rows: byGoal },
    { rows: byTask },
  ] = await Promise.all([
    query(`
      SELECT
        COUNT(*)::int AS session_count,
        COALESCE(SUM(ws.minutes),0)::int AS total_minutes,
        COALESCE(SUM(ws.minutes) FILTER (WHERE ws.source='manual'),0)::int AS manual_minutes,
        COALESCE(SUM(ws.minutes) FILTER (WHERE ws.source='journal'),0)::int AS journal_minutes
      FROM work_sessions ws
      LEFT JOIN tasks t ON t.id = ws.task_id
      WHERE ws.minutes IS NOT NULL${dateFilter}${goalFilter}
    `, params),
    query(`
      SELECT LEFT(ws.started_at, 10) as day, SUM(ws.minutes)::int AS minutes, COUNT(*)::int AS sessions
      FROM work_sessions ws
      LEFT JOIN tasks t ON t.id = ws.task_id
      WHERE ws.minutes IS NOT NULL${dateFilter}${goalFilter}
      GROUP BY LEFT(ws.started_at, 10)
      ORDER BY day ASC
      LIMIT 90
    `, params),
    query(`
      SELECT g.id, g.title, SUM(ws.minutes)::int AS minutes, COUNT(DISTINCT ws.task_id)::int AS tasks_worked
      FROM work_sessions ws
      LEFT JOIN tasks t ON t.id = ws.task_id
      JOIN goals g ON g.id = COALESCE(ws.goal_id, t.goal_id)
      WHERE ws.minutes IS NOT NULL${dateFilter}${goalFilter}
      GROUP BY g.id, g.title
      ORDER BY minutes DESC
      LIMIT 20
    `, params),
    query(`
      SELECT t.id, t.title, t.goal_id, SUM(ws.minutes)::int AS minutes, COUNT(*)::int AS sessions
      FROM work_sessions ws
      JOIN tasks t ON t.id = ws.task_id
      WHERE ws.minutes IS NOT NULL${dateFilter}${goalFilter}
      GROUP BY t.id, t.title, t.goal_id
      ORDER BY minutes DESC
      LIMIT 20
    `, params),
  ]);

  const total = totalRows[0] as Record<string, unknown>;
  res.json({
    total_minutes:   Number(total.total_minutes ?? 0),
    session_count:   Number(total.session_count ?? 0),
    manual_minutes:  Number(total.manual_minutes ?? 0),
    journal_minutes: Number(total.journal_minutes ?? 0),
    by_day:  byDay,
    by_goal: byGoal,
    by_task: byTask,
    from: from ?? null,
    to:   to   ?? null,
  });
});

// GET /api/work-sessions?task_id=xxx&resource_id=xxx&journal_entry_id=xxx
router.get('/', async (req, res) => {
  const { task_id, resource_id, journal_entry_id } = req.query;
  if (!task_id && !resource_id && !journal_entry_id) {
    return res.status(400).json({ error: 'task_id, resource_id, or journal_entry_id required' });
  }
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (task_id) { conditions.push(`task_id=$${params.length + 1}`); params.push(task_id); }
  if (resource_id) { conditions.push(`resource_id=$${params.length + 1}`); params.push(resource_id); }
  if (journal_entry_id) { conditions.push(`journal_entry_id=$${params.length + 1}`); params.push(journal_entry_id); }
  const { rows } = await query(
    `SELECT * FROM work_sessions WHERE ${conditions.join(' OR ')} ORDER BY started_at DESC`,
    params,
  );
  res.json(rows);
});

// POST /api/work-sessions
router.post('/', async (req, res) => {
  const { task_id, resource_id, goal_id, journal_entry_id, started_at, ended_at, minutes, notes, source } = req.body as Record<string, unknown>;
  if (!task_id && !resource_id && !journal_entry_id) {
    return res.status(400).json({ error: 'At least one of task_id, resource_id, or journal_entry_id required' });
  }
  if (minutes !== null && minutes !== undefined) {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m < 0) return res.status(400).json({ error: 'minutes must be a non-negative number' });
  }
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  await query(
    `INSERT INTO work_sessions (id,task_id,resource_id,goal_id,journal_entry_id,started_at,ended_at,minutes,notes,source,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, task_id ?? null, resource_id ?? null, goal_id ?? null, journal_entry_id ?? null, started_at ?? now, ended_at ?? null, minutes ?? null, notes ?? '', source ?? 'manual', now],
  );
  if (task_id) {
    await recalcActualMinutes(task_id as string);
    // Status truth: logging real work moves a dormant task to in_progress
    // (never touches paused — the user chose that — nor blocked/done).
    await query(
      `UPDATE tasks SET status='in_progress', updated_at=$1
       WHERE id=$2 AND status IN ('todo','not_started','planned')`,
      [now, task_id],
    );
  }
  res.json({ id });
});

// PUT /api/work-sessions/:id
router.put('/:id', async (req, res) => {
  const { rows } = await query('SELECT task_id FROM work_sessions WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const session = rows[0] as Record<string, unknown>;
  const { ended_at, minutes, notes } = req.body as Record<string, unknown>;
  if (minutes !== null && minutes !== undefined) {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m < 0) return res.status(400).json({ error: 'minutes must be a non-negative number' });
  }
  const updates: Record<string, unknown> = {};
  if (ended_at !== undefined) updates.ended_at = ended_at;
  if (minutes  !== undefined) updates.minutes  = minutes;
  if (notes    !== undefined) updates.notes    = notes;
  if (!Object.keys(updates).length) return res.json({ ok: true });
  const entries = Object.entries(updates);
  const sets = entries.map(([col], i) => `${col}=$${i + 1}`).join(',');
  const vals = entries.map(([, v]) => v);
  await query(`UPDATE work_sessions SET ${sets} WHERE id=$${vals.length + 1}`, [...vals, req.params.id]);
  const taskId = session.task_id as string | null;
  if (taskId) await recalcActualMinutes(taskId);
  res.json({ ok: true });
});

// DELETE /api/work-sessions/:id
router.delete('/:id', async (req, res) => {
  const { rows } = await query('SELECT task_id FROM work_sessions WHERE id=$1', [req.params.id]);
  await query('DELETE FROM work_sessions WHERE id=$1', [req.params.id]);
  const taskId = rows.length ? (rows[0] as Record<string, unknown>).task_id as string | null : null;
  if (taskId) await recalcActualMinutes(taskId);
  res.json({ ok: true });
});

// POST /api/work-sessions/migrate-legacy — one-time migration:
// creates a synthetic 'legacy' work session for any task that has actual_minutes > 0
// but zero existing work_sessions. This preserves historical time data when transitioning
// from direct actual_minutes writes to the canonical session-aggregate model.
router.post('/migrate-legacy', async (_req, res) => {
  const { rows: tasks } = await query<{ id: string; actual_minutes: number; goal_id: string | null }>(
    `SELECT t.id, t.actual_minutes, t.goal_id FROM tasks t
     WHERE t.actual_minutes > 0
       AND NOT EXISTS (SELECT 1 FROM work_sessions ws WHERE ws.task_id = t.id)`,
  );

  if (!tasks.length) {
    return res.json({ migrated: 0, message: 'No legacy tasks found.' });
  }

  const now = new Date().toISOString();
  let migrated = 0;
  for (const task of tasks) {
    await query(
      `INSERT INTO work_sessions (id, task_id, started_at, minutes, notes, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        crypto.randomUUID(),
        task.id,
        now,
        task.actual_minutes,
        'Migrated from legacy actual_minutes field',
        'legacy',
        now,
      ],
    );
    migrated++;
  }

  return res.json({ migrated, message: `Migrated ${migrated} task(s) with legacy actual_minutes to work sessions.` });
});

export { router as workSessionsRouter };
