import { Router } from 'express';
import { query, transaction } from '../db.js';
import { generateEntitySummary, deleteEntitySummaries } from '../services/summaryGenerator.js';
import { queueEmbeddingDelete } from '../services/embeddingLifecycle.js';
import { requireISODate } from '../utils/localDate.js';
import { runInBackground } from '../utils/background.js';

const router = Router();

// GET /api/milestones?goal_id=xxx
router.get('/', async (req, res) => {
  const { goal_id } = req.query;
  if (!goal_id) return res.status(400).json({ error: 'goal_id required' });
  const { rows } = await query(
    'SELECT * FROM goal_milestones WHERE goal_id=$1 ORDER BY position ASC, created_at ASC',
    [goal_id],
  );
  res.json(rows);
});

// POST /api/milestones
router.post('/', async (req, res) => {
  const { goal_id, title, description, due_date, color, position } = req.body as Record<string, unknown>;
  if (!goal_id) return res.status(400).json({ error: 'goal_id required' });
  try { requireISODate(due_date, 'due_date'); } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  const { rows: countRows } = await query(
    'SELECT COUNT(*) as c FROM goal_milestones WHERE goal_id=$1',
    [goal_id],
  );
  const pos = position ?? Number((countRows[0] as Record<string, unknown>).c ?? 0);
  await query(
    `INSERT INTO goal_milestones (id,goal_id,title,description,due_date,color,position,completed,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, goal_id, title ?? '', description ?? '', due_date ?? null, color ?? '#6366f1', pos, false, now, now],
  );
  res.json({ id });
  runInBackground(generateEntitySummary('milestone', id), 'milestone create summary');
});

// PUT /api/milestones/:id
router.put('/:id', async (req, res) => {
  const { rows: existing } = await query('SELECT id FROM goal_milestones WHERE id=$1', [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: 'Not found' });
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { updated_at: now };
  const { title, description, due_date, color, position, completed } = req.body as Record<string, unknown>;
  try { if (due_date !== undefined) requireISODate(due_date, 'due_date'); } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
  if (title       !== undefined) updates.title       = title;
  if (description !== undefined) updates.description = description;
  if (due_date    !== undefined) updates.due_date    = due_date;
  if (color       !== undefined) updates.color       = color;
  if (position    !== undefined) updates.position    = Number(position);
  if (completed   !== undefined) {
    if (typeof completed !== 'boolean') return res.status(400).json({ error: 'completed must be a boolean' });
    updates.completed = completed;
  }

  const entries = Object.entries(updates);
  const sets = entries.map(([col], i) => `${col}=$${i + 1}`).join(',');
  const vals = entries.map(([, v]) => v);
  const { rows: updated } = await query(
    `UPDATE goal_milestones SET ${sets} WHERE id=$${vals.length + 1} RETURNING *`,
    [...vals, req.params.id],
  );
  res.json(updated[0]);
  runInBackground(generateEntitySummary('milestone', req.params.id), 'milestone update summary');
});

// DELETE /api/milestones/:id
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  await transaction(async (client) => {
    // Unassign tasks first, then delete canonical row atomically
    await client.query('UPDATE tasks SET milestone_id=NULL, updated_at=$1 WHERE milestone_id=$2', [new Date().toISOString(), id]);
    await client.query('DELETE FROM goal_milestones WHERE id=$1', [id]);
  });
  res.json({ ok: true });
  // Async cleanup of derived/graph data (fire-and-forget, non-blocking)
  runInBackground(Promise.all([
    deleteEntitySummaries('milestone', id),
    query('DELETE FROM embedding_jobs WHERE entity_type=$1 AND entity_id=$2', ['milestone', id]),
    query('DELETE FROM embeddings WHERE entity_type=$1 AND entity_id=$2', ['milestone', id]),
    query(
      `DELETE FROM edges WHERE (source_id=$1 AND source_type='milestone') OR (target_id=$1 AND target_type='milestone')`,
      [id],
    ),
    query("DELETE FROM journal_links WHERE target_type='milestone' AND target_id=$1", [id]),
    query("DELETE FROM extracted_facts WHERE target_type='milestone' AND target_id=$1", [id]),
    query("DELETE FROM entity_aliases WHERE entity_type='milestone' AND entity_id=$1", [id]),
    query("DELETE FROM ai_action_proposals WHERE source_type='milestone' AND source_id=$1 AND status='pending'", [id]),
    queueEmbeddingDelete('milestone', id, null),
  ]), 'milestone delete cleanup');
});

// PATCH /api/milestones/assign-task
router.patch('/assign-task', async (req, res) => {
  const { task_id, milestone_id } = req.body as { task_id: string; milestone_id: string | null };
  if (!task_id) return res.status(400).json({ error: 'task_id required' });

  if (milestone_id) {
    // Validate that task and milestone both exist and share the same goal
    const [{ rows: taskRows }, { rows: msRows }] = await Promise.all([
      query('SELECT id, goal_id FROM tasks WHERE id=$1', [task_id]),
      query('SELECT id, goal_id FROM goal_milestones WHERE id=$1', [milestone_id]),
    ]);
    if (!taskRows.length) return res.status(404).json({ error: 'Task not found' });
    if (!msRows.length)   return res.status(404).json({ error: 'Milestone not found' });
    const task = taskRows[0] as Record<string, unknown>;
    const ms   = msRows[0]   as Record<string, unknown>;
    if (task.goal_id !== ms.goal_id) {
      return res.status(400).json({ error: 'Milestone must belong to the same goal as the task' });
    }
  }

  await query('UPDATE tasks SET milestone_id=$1, updated_at=$2 WHERE id=$3', [milestone_id ?? null, new Date().toISOString(), task_id]);
  res.json({ ok: true });
});

export { router as milestonesRouter };
