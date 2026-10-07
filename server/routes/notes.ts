import { Router } from 'express';
import { query, buildUpdate, transaction } from '../db.js';
import { markEmbeddingStale, queueEmbeddingUpsert } from '../services/embeddingLifecycle.js';

const router = Router();

const NOTE_UPDATE_FIELDS = new Set([
  'title', 'content', 'type', 'date_str',
  'suggested_action_text', 'suggested_action_applied', 'suggested_action_ignored',
  'extracted_tasks_json', 'relevant_docs_json',
]);

router.get('/', async (_req, res) => {
  // Older unfinished stickies and completion-day history must remain accessible.
  const { rows } = await query('SELECT * FROM notes ORDER BY created_at DESC');
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM notes WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

router.post('/', async (req, res) => {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const b = req.body;
  await transaction(async client => {
    await client.query(
      `INSERT INTO notes (id,title,content,type,date_str,suggested_action_text,suggested_action_applied,suggested_action_ignored,extracted_tasks_json,relevant_docs_json,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        b.title ?? '',
        b.content ?? '',
        b.type ?? 'capture',
        b.date_str ?? '',
        b.suggested_action_text ?? null,
        Boolean(b.suggested_action_applied),
        Boolean(b.suggested_action_ignored),
        b.extracted_tasks_json ?? '[]',
        b.relevant_docs_json ?? '[]',
        now,
        now,
      ],
    );
    // The saved source and its searchable-work intent must commit together.
    await queueEmbeddingUpsert('note', id, null, undefined, client);
  });
  res.json({ id });
});

router.patch('/:id', async (req, res) => {
  if ('completed' in req.body && typeof req.body.completed !== 'boolean') {
    return res.status(400).json({ error: 'completed must be a boolean' });
  }
  const saved = await transaction(async client => {
    const { rows: existing } = await client.query('SELECT title,content,date_str FROM notes WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!existing.length) return false;
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updated_at: now };
    for (const key of NOTE_UPDATE_FIELDS) {
      if (key in req.body) updates[key] = (req.body as Record<string, unknown>)[key];
    }
    const contentChanged = ['title', 'content', 'date_str'].some(key => key in req.body && req.body[key] !== existing[0][key]);
    const { sets, vals } = buildUpdate(updates);
    // Keep the original finish time on retries; reopening clears it explicitly.
    let completionSet = '';
    if ('completed' in req.body) {
      if (req.body.completed) {
        vals.push(now);
        completionSet = `, completed_at = COALESCE(completed_at, $${vals.length})`;
      } else {
        completionSet = ', completed_at = NULL';
      }
    }
    await client.query(`UPDATE notes SET ${sets}${completionSet} WHERE id=$${vals.length + 1}`, [...vals, req.params.id]);
    if (contentChanged) {
      await markEmbeddingStale('note', req.params.id, client);
      await queueEmbeddingUpsert('note', req.params.id, null, undefined, client);
    }
    return true;
  });
  if (!saved) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const noteId = req.params.id;
  await transaction(async (client) => {
    await client.query('DELETE FROM entity_summaries WHERE entity_type=$1 AND entity_id=$2', ['note', noteId]);
    await client.query("DELETE FROM embedding_jobs WHERE entity_type='note' AND entity_id=$1 AND status IN ('pending','failed')", [noteId]);
    await client.query(`DELETE FROM edges WHERE (source_id=$1 AND source_type='note') OR (target_id=$1 AND target_type='note')`, [noteId]);
    await client.query("DELETE FROM journal_links WHERE target_type='note' AND target_id=$1", [noteId]);
    await client.query("DELETE FROM extracted_facts WHERE target_type='note' AND target_id=$1", [noteId]);
    await client.query("DELETE FROM entity_aliases WHERE entity_type='note' AND entity_id=$1", [noteId]);
    await client.query("DELETE FROM ai_action_proposals WHERE source_type='note' AND source_id=$1 AND status='pending'", [noteId]);
    await client.query('DELETE FROM notes WHERE id=$1', [noteId]);
  });
  await query("DELETE FROM embeddings WHERE entity_type='note' AND entity_id=$1", [noteId]);
  res.json({ ok: true });
});

export { router as notesRouter };
