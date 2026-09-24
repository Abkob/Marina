import { Router } from 'express';
import { activeMeetingSql } from '../utils/archiveVisibility.js';
import { query, transaction } from '../db.js';

const router = Router();

// GET /api/meetings?goal_id=xxx
router.get('/', async (req, res) => {
  const { goal_id } = req.query;
  const { rows } = goal_id
    ? await query('SELECT * FROM meetings WHERE goal_id=$1 ORDER BY scheduled_at ASC', [goal_id])
    : await query(`SELECT * FROM meetings WHERE ${activeMeetingSql()} ORDER BY scheduled_at ASC LIMIT 500`);
  res.json(rows);
});

// POST /api/meetings
router.post('/', async (req, res) => {
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  const { goal_id = null, milestone_id = null, title, scheduled_at, duration_minutes = 60, location = '', notes = '' } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  if (!scheduled_at || isNaN(Date.parse(scheduled_at))) return res.status(400).json({ error: 'scheduled_at must be a valid date/time string' });
  const durationNum = Number(duration_minutes);
  if (!Number.isFinite(durationNum) || durationNum < 0) return res.status(400).json({ error: 'duration_minutes must be a non-negative number' });
  await query(
    `INSERT INTO meetings (id,goal_id,milestone_id,title,scheduled_at,duration_minutes,location,notes,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, goal_id ?? null, milestone_id ?? null, title.trim(), scheduled_at, durationNum, location ?? '', notes ?? '', now, now],
  );
  res.json({ id });
});

// PUT /api/meetings/:id
router.put('/:id', async (req, res) => {
  const { title, scheduled_at, duration_minutes, location, notes, summary } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  if (!scheduled_at || isNaN(Date.parse(scheduled_at))) return res.status(400).json({ error: 'scheduled_at must be a valid date/time string' });
  const dur = Number(duration_minutes ?? 60);
  if (!Number.isFinite(dur) || dur < 0) return res.status(400).json({ error: 'duration_minutes must be a non-negative number' });
  await query(
    `UPDATE meetings SET title=$1, scheduled_at=$2, duration_minutes=$3, location=$4, notes=$5, summary=$6, updated_at=$7 WHERE id=$8`,
    [title.trim(), scheduled_at, dur, location ?? '', notes ?? '', summary ?? null, new Date().toISOString(), req.params.id],
  );
  res.json({ ok: true });
});

// DELETE /api/meetings/:id
router.delete('/:id', async (req, res) => {
  const meetingId = req.params.id;
  await transaction(async (client) => {
    await client.query('DELETE FROM entity_summaries WHERE entity_type=$1 AND entity_id=$2', ['meeting', meetingId]);
    await client.query("DELETE FROM embedding_jobs WHERE entity_type='meeting' AND entity_id=$1 AND status IN ('pending','failed')", [meetingId]);
    await client.query(`DELETE FROM edges WHERE (source_id=$1 AND source_type='meeting') OR (target_id=$1 AND target_type='meeting')`, [meetingId]);
    await client.query("DELETE FROM journal_links WHERE target_type='meeting' AND target_id=$1", [meetingId]);
    await client.query("DELETE FROM extracted_facts WHERE target_type='meeting' AND target_id=$1", [meetingId]);
    await client.query("DELETE FROM entity_aliases WHERE entity_type='meeting' AND entity_id=$1", [meetingId]);
    await client.query("DELETE FROM ai_action_proposals WHERE source_type='meeting' AND source_id=$1 AND status='pending'", [meetingId]);
    await client.query('DELETE FROM meetings WHERE id=$1', [meetingId]);
  });
  await query("DELETE FROM embeddings WHERE entity_type='meeting' AND entity_id=$1", [meetingId]);
  res.json({ ok: true });
});

export { router as meetingsRouter };
