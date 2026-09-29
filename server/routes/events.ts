import { Router } from 'express';
import { activeEventSql } from '../utils/archiveVisibility.js';
import { query, buildUpdate, transaction } from '../db.js';
import { z } from 'zod';
import type { PoolClient } from 'pg';

const router = Router();

const linkChangesSchema = z.object({
  add: z.array(z.object({ task_id: z.string().min(1), planned_minutes: z.number().int().min(0).max(1440).nullable().optional() })).max(200).default([]),
  remove: z.array(z.string().min(1)).max(200).default([]),
});
async function saveLinks(client: PoolClient, eventId: string, changes: z.infer<typeof linkChangesSchema> | undefined) {
  if (!changes) return;
  for (const id of changes.remove) await client.query('DELETE FROM event_task_links WHERE id=$1 AND event_id=$2', [id, eventId]);
  for (const link of changes.add) await client.query(
    `INSERT INTO event_task_links (id,event_id,task_id,planned_minutes,created_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (event_id,task_id) DO UPDATE SET planned_minutes=EXCLUDED.planned_minutes`,
    [crypto.randomUUID(), eventId, link.task_id, link.planned_minutes ?? null, new Date().toISOString()],
  );
}

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
  const links = linkChangesSchema.optional().safeParse(b.task_link_changes);
  if (!links.success) return res.status(400).json({ error: 'Invalid task links' });
  if (!b.title?.trim()) return res.status(400).json({ error: 'title required' });
  const dayIdx = Number(b.day_index ?? 0);
  if (!Number.isInteger(dayIdx) || dayIdx < 0 || dayIdx > 6) return res.status(400).json({ error: 'day_index must be 0–6' });
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await transaction(async client => {
    await client.query(
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
    await saveLinks(client, id, links.data);
  });
  res.json({ id });
});

router.patch('/:id', async (req, res) => {
  const links = linkChangesSchema.optional().safeParse(req.body.task_link_changes);
  if (!links.success) return res.status(400).json({ error: 'Invalid task links' });
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of EVENT_UPDATE_FIELDS) {
    if (key in req.body) updates[key] = (req.body as Record<string, unknown>)[key];
  }
  const { sets, vals } = buildUpdate(updates);
  const found = await transaction(async client => {
    const result = await client.query(`UPDATE events SET ${sets} WHERE id=$${vals.length + 1}`, [...vals, req.params.id]);
    if (!result.rowCount) return false;
    await saveLinks(client, req.params.id, links.data);
    return true;
  });
  if (!found) return res.status(404).json({ error: 'Calendar block not found' });
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  await query('DELETE FROM events WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

export { router as eventsRouter };
