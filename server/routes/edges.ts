import { Router } from 'express';
import { activeEntitySql } from '../utils/archiveVisibility.js';
import { query } from '../db.js';

const router = Router();

const VALID_NODE_TYPES = new Set([
  'goal', 'task', 'note', 'resource', 'event', 'milestone', 'meeting', 'journal_entry', 'daily_score',
]);
const VALID_RELATIONSHIPS = new Set([
  'contains', 'subtask_of', 'mentioned_in', 'extracted_to', 'attached_to',
  'schedules', 'references', 'linked_to', 'blocks',
]);

router.get('/', async (req, res) => {
  const { source_id, target_id, goal_id, relationship } = req.query;
  const visible = `${activeEntitySql('source_type', 'source_id')} AND ${activeEntitySql('target_type', 'target_id')}`;
  if (goal_id) {
    const params: unknown[] = [goal_id];
    const relationshipClause = relationship ? `AND e.relationship=$2` : '';
    if (relationship) params.push(relationship);
    const { rows } = await query(
      `SELECT e.* FROM edges e
       JOIN tasks source_task ON source_task.id=e.source_id AND e.source_type='task'
       JOIN tasks target_task ON target_task.id=e.target_id AND e.target_type='task'
       WHERE source_task.goal_id=$1 AND target_task.goal_id=$1 ${relationshipClause}
       ORDER BY e.created_at ASC LIMIT 1000`,
      params,
    );
    return res.json(rows);
  }
  if (source_id) {
    const { rows } = await query(
      `SELECT * FROM edges WHERE source_id=$1 AND ${visible} ORDER BY created_at DESC LIMIT 500`,
      [source_id],
    );
    return res.json(rows);
  }
  if (target_id) {
    const { rows } = await query(
      `SELECT * FROM edges WHERE target_id=$1 AND ${visible} ORDER BY created_at DESC LIMIT 500`,
      [target_id],
    );
    return res.json(rows);
  }
  // Without filter: cap at 500 to prevent unbounded result sets
  const { rows } = await query(`SELECT * FROM edges WHERE ${visible} ORDER BY created_at DESC LIMIT 500`);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  if (!b.source_id || !b.source_type || !b.target_id || !b.target_type || !b.relationship) {
    return res.status(400).json({ error: 'source_id, source_type, target_id, target_type, relationship are required' });
  }
  if (!VALID_NODE_TYPES.has(b.source_type as string)) {
    return res.status(400).json({ error: `Invalid source_type: ${b.source_type}` });
  }
  if (!VALID_NODE_TYPES.has(b.target_type as string)) {
    return res.status(400).json({ error: `Invalid target_type: ${b.target_type}` });
  }
  if (!VALID_RELATIONSHIPS.has(b.relationship as string)) {
    return res.status(400).json({ error: `Invalid relationship: ${b.relationship}` });
  }
  if (b.source_id === b.target_id && b.source_type === b.target_type) {
    return res.status(400).json({ error: 'Self-referential edges are not allowed' });
  }

  if (b.relationship === 'blocks' && b.source_type === 'task' && b.target_type === 'task') {
    const { rows } = await query<{ cycle: boolean }>(
      `WITH RECURSIVE downstream(id) AS (
         SELECT target_id FROM edges
         WHERE source_id=$1 AND source_type='task' AND target_type='task' AND relationship='blocks'
         UNION
         SELECT e.target_id FROM edges e JOIN downstream d ON e.source_id=d.id
         WHERE e.source_type='task' AND e.target_type='task' AND e.relationship='blocks'
       ) SELECT EXISTS(SELECT 1 FROM downstream WHERE id=$2) AS cycle`,
      [b.target_id, b.source_id],
    );
    if (rows[0]?.cycle) return res.status(409).json({ error: 'This dependency would create a cycle' });
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [id, b.source_id, b.source_type, b.target_id, b.target_type, b.relationship, b.metadata ?? null, now],
  );
  res.json({ id });
});

router.delete('/:id', async (req, res) => {
  await query('DELETE FROM edges WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

export { router as edgesRouter };
