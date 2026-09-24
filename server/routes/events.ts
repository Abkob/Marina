import { Router } from 'express';
import { activeEventSql } from '../utils/archiveVisibility.js';
import { query, buildUpdate } from '../db.js';

const router = Router();

const EVENT_UPDATE_FIELDS = new Set([
  'title', 'type', 'day_index', 'start_hour', 'duration_hours',
  'time_str', 'description', 'week_start', 'connected_resource_json', 'locked', 'source',
]);

router.get('/', async (_req, res) => {
  const { rows } = await query(`SELECT * FROM events WHERE ${activeEventSql()} ORDER BY day_index ASC, start_hour ASC LIMIT 500`);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const b = req.body;
  if (!b.title?.trim()) return res.status(400).json({ error: 'title required' });
  const dayIdx = Number(b.day_index ?? 0);
  if (!Number.isInteger(dayIdx) || dayIdx < 0 || dayIdx > 6) return res.status(400).json({ error: 'day_index must be 0–6' });
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO events (id,title,type,day_index,start_hour,duration_hours,time_str,description,week_start,connected_resource_json,locked,source,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      b.title ?? '',
      b.type ?? 'focus',
      b.day_index ?? 0,
      b.start_hour ?? 9,
      b.duration_hours ?? 1,
      b.time_str ?? '',
      b.description ?? '',
      b.week_start ?? null,
      b.connected_resource_json ?? null,
      Boolean(b.locked),
      b.source ?? 'manual',
      now,
      now,
    ],
  );
  res.json({ id });
});

router.patch('/:id', async (req, res) => {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of EVENT_UPDATE_FIELDS) {
    if (key in req.body) updates[key] = (req.body as Record<string, unknown>)[key];
  }
  const { sets, vals } = buildUpdate(updates);
  await query(`UPDATE events SET ${sets} WHERE id=$${vals.length + 1}`, [...vals, req.params.id]);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  await query('DELETE FROM events WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

export { router as eventsRouter };
