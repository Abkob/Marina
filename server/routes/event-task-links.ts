import { Router } from 'express';
import { activeTaskSql } from '../utils/archiveVisibility.js';
import { query } from '../db.js';

const router = Router();

// GET /api/event-task-links?event_id=xxx  OR  ?task_id=xxx  OR no params (all links)
router.get('/', async (req, res) => {
  const { event_id, task_id } = req.query;
  if (event_id) {
    const { rows } = await query(
      `SELECT etl.id, etl.event_id, etl.task_id, etl.planned_minutes, etl.created_at,
              t.title as task_title, t.status as task_status, t.goal_id, t.completed
       FROM event_task_links etl
       JOIN tasks t ON t.id = etl.task_id
       WHERE etl.event_id=$1 AND ${activeTaskSql('etl.task_id')}`,
      [event_id],
    );
    return res.json(rows);
  }
  if (task_id) {
    const { rows } = await query(
      `SELECT etl.id, etl.event_id, etl.task_id, etl.planned_minutes, etl.created_at,
              e.title as event_title, e.type as event_type,
              e.day_index, e.start_hour, e.duration_hours, e.week_start
       FROM event_task_links etl
       JOIN events e ON e.id = etl.event_id
       WHERE etl.task_id=$1 AND ${activeTaskSql('etl.task_id')}`,
      [task_id],
    );
    return res.json(rows);
  }
  // No filter: every link with its task's live state — one query drives the
  // completion badges for a whole calendar week.
  const { rows } = await query(
    `SELECT etl.id, etl.event_id, etl.task_id, etl.planned_minutes, etl.created_at,
            t.title as task_title, t.status as task_status, t.goal_id, t.completed
     FROM event_task_links etl
     JOIN tasks t ON t.id = etl.task_id
     WHERE ${activeTaskSql('etl.task_id')}
     LIMIT 2000`,
  );
  return res.json(rows);
});

// POST /api/event-task-links
router.post('/', async (req, res) => {
  const { event_id, task_id, planned_minutes } = req.body as { event_id: string; task_id: string; planned_minutes?: number };
  if (!event_id || !task_id) return res.status(400).json({ error: 'event_id and task_id required' });

  if (planned_minutes !== undefined && planned_minutes !== null) {
    const pm = Number(planned_minutes);
    if (!Number.isInteger(pm) || pm < 0 || pm > 1440) {
      return res.status(400).json({ error: 'planned_minutes must be an integer 0–1440' });
    }
  }

  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  const { rows } = await query(
    `INSERT INTO event_task_links (id,event_id,task_id,planned_minutes,created_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (event_id,task_id) DO UPDATE SET planned_minutes=EXCLUDED.planned_minutes
     RETURNING id`,
    [id, event_id, task_id, planned_minutes ?? null, now],
  );
  res.json({ id: (rows[0] as Record<string, unknown>).id });
});

// PATCH /api/event-task-links/:id — update planned_minutes
router.patch('/:id', async (req, res) => {
  const { planned_minutes } = req.body as { planned_minutes?: number | null };

  if (planned_minutes !== undefined && planned_minutes !== null) {
    const pm = Number(planned_minutes);
    if (!Number.isInteger(pm) || pm < 0 || pm > 1440) {
      return res.status(400).json({ error: 'planned_minutes must be an integer 0–1440' });
    }
  }

  const { rowCount } = await query(
    'UPDATE event_task_links SET planned_minutes=$1 WHERE id=$2',
    [planned_minutes ?? null, req.params.id],
  );
  if (!rowCount) return res.status(404).json({ error: 'Link not found' });
  res.json({ ok: true });
});

// DELETE /api/event-task-links/:id
router.delete('/:id', async (req, res) => {
  await query('DELETE FROM event_task_links WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

export { router as eventTaskLinksRouter };
