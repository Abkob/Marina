import { activeEntitySql } from '../utils/archiveVisibility.js';
import { Router } from 'express';
import crypto from 'crypto';
import { query, transaction } from '../db.js';
import { EMBED_MODEL } from '../config/providers.js';

const router = Router();

// Entity tables that can hold topic memberships. Keys are the entity_type
// values allowed by the topic_memberships CHECK constraint.
const ENTITY_TABLES: Record<string, { table: string; titleCol: string }> = {
  goal:          { table: 'goals',           titleCol: 'title' },
  task:          { table: 'tasks',           titleCol: 'title' },
  milestone:     { table: 'goal_milestones', titleCol: 'title' },
  resource:      { table: 'resources',       titleCol: 'title' },
  meeting:       { table: 'meetings',        titleCol: 'title' },
  journal_entry: { table: 'journal_entries', titleCol: 'entry_date' },
  note:          { table: 'notes',           titleCol: 'title' },
};

const TITLE_JOIN_SQL = `
  COALESCE(g.title, t.title, gm.title, r.title, m.title, n.title, je.entry_date) AS entity_title
  FROM topic_memberships tm
  LEFT JOIN goals g            ON tm.entity_type='goal'          AND tm.entity_id=g.id
  LEFT JOIN tasks t            ON tm.entity_type='task'          AND tm.entity_id=t.id
  LEFT JOIN goal_milestones gm ON tm.entity_type='milestone'     AND tm.entity_id=gm.id
  LEFT JOIN resources r        ON tm.entity_type='resource'      AND tm.entity_id=r.id
  LEFT JOIN meetings m         ON tm.entity_type='meeting'       AND tm.entity_id=m.id
  LEFT JOIN notes n            ON tm.entity_type='note'          AND tm.entity_id=n.id
  LEFT JOIN journal_entries je ON tm.entity_type='journal_entry' AND tm.entity_id=je.id`;

async function entityExists(entityType: string, entityId: string): Promise<boolean> {
  const spec = ENTITY_TABLES[entityType];
  if (!spec) return false;
  const { rows } = await query(`SELECT 1 FROM ${spec.table} WHERE id=$1`, [entityId]);
  return rows.length > 0;
}

// ─── Topics CRUD ─────────────────────────────────────────────────────────────

// GET /api/topics — active topics with membership counts
router.get('/', async (req, res) => {
  const includeArchived = req.query.include_archived === 'true';
  const { rows } = await query(
    `SELECT tp.*,
       COUNT(tm.id) FILTER (WHERE tm.status='accepted' AND ${activeEntitySql('tm.entity_type', 'tm.entity_id')})::int  AS member_count,
       COUNT(tm.id) FILTER (WHERE tm.status='suggested' AND ${activeEntitySql('tm.entity_type', 'tm.entity_id')})::int AS suggestion_count
     FROM topics tp
     LEFT JOIN topic_memberships tm ON tm.topic_id = tp.id
     WHERE ($1 OR tp.status = 'active')
     GROUP BY tp.id
     ORDER BY tp.created_at DESC`,
    [includeArchived],
  );
  res.json(rows);
});

// POST /api/topics — create a topic (manual by default). Choice A: records
// already carrying a tag equal to the topic name join it retroactively
// (manual tags → accepted members, journal AI tags → suggestions).
router.post('/', async (req, res) => {
  const { name, description, color } = req.body as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name required' });
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO topics (id, name, description, color, status, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'active','manual',$5,$6)`,
    [id, name.trim(), (description as string) ?? null, (color as string) ?? null, now, now],
  );
  const { backfillTopicFromTags } = await import('../services/topicTagSync.js');
  const backfill = await backfillTopicFromTags(id, name.trim())
    .catch(err => { console.warn('[topics] tag backfill:', err); return { accepted: 0, suggested: 0 }; });
  const { rows } = await query('SELECT * FROM topics WHERE id=$1', [id]);
  res.status(201).json({ ...rows[0], backfill });
});

// GET /api/topics/suggestions — global review inbox (registered before /:id routes)
router.get('/suggestions', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'suggested';
  const { rows } = await query(
    `SELECT tm.*, tp.name AS topic_name, tp.color AS topic_color, ${TITLE_JOIN_SQL}
     JOIN topics tp ON tp.id = tm.topic_id
     WHERE ${activeEntitySql('tm.entity_type', 'tm.entity_id')} AND tm.status = $1 AND tp.status = 'active'
     ORDER BY tm.confidence DESC, tm.created_at DESC`,
    [status],
  );
  res.json(rows);
});

/**
 * Deterministic candidate generation across active topics. Signals: embedding
 * similarity to accepted members, graph adjacency (edges + journal_links), and
 * alias/keyword title matches. Manual and rejected rows are never modified;
 * new candidates enter as 'suggested'. Each run is recorded in suggestion_runs.
 * Called by the generate endpoint and fire-and-forget after journal ingestion.
 */
export async function runSuggestionGeneration(
  topicFilter: string | null = null,
  trigger: string = 'manual',
): Promise<{ run_id: string; suggestions_created: number; per_topic: Record<string, number> }> {
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  await query(
    `INSERT INTO suggestion_runs (id, kind, embedding_model, params_json, status, started_at)
     VALUES ($1,'cluster_candidates',$2,$3,'running',$4)`,
    [runId, EMBED_MODEL, JSON.stringify({ topic_id: topicFilter, min_cosine: MIN_COSINE, trigger }), now],
  );

  try {
    const { rows: topics } = await query(
      `SELECT id, name FROM topics WHERE status='active' ${topicFilter ? 'AND id=$1' : ''}`,
      topicFilter ? [topicFilter] : [],
    );
    let created = 0;
    const perTopic: Record<string, number> = {};
    for (const topic of topics as { id: string; name: string }[]) {
      const n = await generateCandidatesForTopic(topic.id, topic.name, runId);
      created += n;
      perTopic[topic.name] = n;
    }
    await query(
      `UPDATE suggestion_runs SET status='done', finished_at=$1, stats_json=$2 WHERE id=$3`,
      [new Date().toISOString(), JSON.stringify({ suggestions_created: created, per_topic: perTopic }), runId],
    );
    return { run_id: runId, suggestions_created: created, per_topic: perTopic };
  } catch (err) {
    await query(
      `UPDATE suggestion_runs SET status='failed', finished_at=$1, error=$2 WHERE id=$3`,
      [new Date().toISOString(), String(err), runId],
    ).catch(() => {});
    throw err;
  }
}

// POST /api/topics/suggestions/generate
router.post('/suggestions/generate', async (req, res) => {
  const topicFilter = typeof (req.body as Record<string, unknown>)?.topic_id === 'string'
    ? (req.body as Record<string, string>).topic_id : null;
  const result = await runSuggestionGeneration(topicFilter, 'manual');
  res.json({ ok: true, ...result });
});

// POST /api/topics/suggestions/:id/accept — suggestion becomes canonical membership
router.post('/suggestions/:id/accept', async (req, res) => {
  const now = new Date().toISOString();
  const { rows } = await query(
    `UPDATE topic_memberships
     SET status='accepted', source='ai_accepted', decided_at=$1, decided_by='user',
         row_version=row_version+1, updated_at=$1
     WHERE id=$2 AND status='suggested'
     RETURNING *`,
    [now, req.params.id],
  );
  if (!rows.length) return res.status(409).json({ error: 'Suggestion not found or already decided' });
  res.json(rows[0]);
});

// POST /api/topics/suggestions/:id/reject — persists so it does not reappear
router.post('/suggestions/:id/reject', async (req, res) => {
  const now = new Date().toISOString();
  const { rows } = await query(
    `UPDATE topic_memberships
     SET status='rejected', decided_at=$1, decided_by='user', row_version=row_version+1, updated_at=$1
     WHERE id=$2 AND status='suggested'
     RETURNING *`,
    [now, req.params.id],
  );
  if (!rows.length) return res.status(409).json({ error: 'Suggestion not found or already decided' });
  res.json(rows[0]);
});

// POST /api/topics/suggestions/:id/move — reject here, manually accept in another topic
router.post('/suggestions/:id/move', async (req, res) => {
  const { topic_id } = req.body as Record<string, unknown>;
  if (typeof topic_id !== 'string') return res.status(400).json({ error: 'topic_id required' });
  const now = new Date().toISOString();

  const result = await transaction(async (client) => {
    const { rows: sugg } = await client.query(
      `UPDATE topic_memberships
       SET status='rejected', decided_at=$1, decided_by='user', row_version=row_version+1, updated_at=$1
       WHERE id=$2 AND status='suggested'
       RETURNING entity_type, entity_id, evidence_json, reason_codes`,
      [now, req.params.id],
    );
    if (!sugg.length) return null;
    const s = sugg[0] as Record<string, string>;
    const { rows: target } = await client.query(
      `SELECT id FROM topics WHERE id=$1 AND status='active'`, [topic_id],
    );
    if (!target.length) throw Object.assign(new Error('Target topic not found'), { status: 404 });
    // Moving is a user decision — the destination membership is manual/accepted.
    const { rows: moved } = await client.query(
      `INSERT INTO topic_memberships
         (id, topic_id, entity_type, entity_id, source, status, confidence, evidence_json, reason_codes, decided_at, decided_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'manual','accepted',1.0,$5,$6,$7,'user',$7,$7)
       ON CONFLICT (topic_id, entity_type, entity_id)
       DO UPDATE SET source='manual', status='accepted', confidence=1.0,
                     decided_at=$7, decided_by='user', row_version=topic_memberships.row_version+1, updated_at=$7
       RETURNING *`,
      [crypto.randomUUID(), topic_id, s.entity_type, s.entity_id, s.evidence_json, s.reason_codes, now],
    );
    return moved[0];
  });
  if (!result) return res.status(409).json({ error: 'Suggestion not found or already decided' });
  res.json(result);
});

// GET /api/topics/of/:entityType/:entityId — accepted topic memberships for one
// entity (registered before '/:id' so 'of' is not parsed as a topic id).
router.get('/of/:entityType/:entityId', async (req, res) => {
  const { entityType, entityId } = req.params;
  const { rows } = await query(
    `SELECT tm.id AS membership_id, tm.source, tm.confidence, tp.id AS topic_id, tp.name, tp.color
     FROM topic_memberships tm
     JOIN topics tp ON tp.id = tm.topic_id AND tp.status = 'active'
     WHERE tm.entity_type=$1 AND tm.entity_id=$2 AND tm.status='accepted'
     ORDER BY tp.name`,
    [entityType, entityId],
  );
  res.json(rows);
});

// GET /api/topics/:id — one topic with counts
router.get('/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT tp.*,
       COUNT(tm.id) FILTER (WHERE tm.status='accepted' AND ${activeEntitySql('tm.entity_type', 'tm.entity_id')})::int  AS member_count,
       COUNT(tm.id) FILTER (WHERE tm.status='suggested' AND ${activeEntitySql('tm.entity_type', 'tm.entity_id')})::int AS suggestion_count
     FROM topics tp
     LEFT JOIN topic_memberships tm ON tm.topic_id = tp.id
     WHERE tp.id=$1
     GROUP BY tp.id`,
    [req.params.id],
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const { rows: aliases } = await query('SELECT * FROM topic_aliases WHERE topic_id=$1 ORDER BY alias', [req.params.id]);
  res.json({ ...rows[0], aliases });
});

// PATCH /api/topics/:id — rename / describe / archive / restore
router.patch('/:id', async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const now = new Date().toISOString();
  const updates: string[] = ['updated_at=$1'];
  const vals: unknown[] = [now];
  for (const field of ['name', 'description', 'color'] as const) {
    if (field in body) {
      vals.push(body[field]);
      updates.push(`${field}=$${vals.length}`);
    }
  }
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'archived') {
      return res.status(400).json({ error: 'status must be active or archived (use /merge for merging)' });
    }
    vals.push(body.status);
    updates.push(`status=$${vals.length}`);
  }
  vals.push(req.params.id);
  const { rows } = await query(
    `UPDATE topics SET ${updates.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals,
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// DELETE /api/topics/:id — permanently remove a topic. Memberships and aliases
// cascade (FK ON DELETE CASCADE); the member entities themselves are untouched.
router.delete('/:id', async (req, res) => {
  const { rowCount } = await query('DELETE FROM topics WHERE id=$1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Topic not found' });
  res.json({ ok: true });
});

// POST /api/topics/:id/merge — fold this topic into another, preserving provenance
router.post('/:id/merge', async (req, res) => {
  const { into_topic_id } = req.body as Record<string, unknown>;
  if (typeof into_topic_id !== 'string' || into_topic_id === req.params.id) {
    return res.status(400).json({ error: 'into_topic_id required and must differ' });
  }
  const now = new Date().toISOString();
  const moved = await transaction(async (client) => {
    const { rows: src } = await client.query(
      `SELECT id FROM topics WHERE id=$1 AND status='active' FOR UPDATE`, [req.params.id],
    );
    const { rows: dst } = await client.query(
      `SELECT id FROM topics WHERE id=$1 AND status='active' FOR UPDATE`, [into_topic_id],
    );
    if (!src.length || !dst.length) throw Object.assign(new Error('Both topics must exist and be active'), { status: 404 });

    // Copy memberships that don't already exist on the target; keep source,
    // confidence and evidence so provenance survives the merge.
    const { rows: toMove } = await client.query(
      `SELECT * FROM topic_memberships WHERE topic_id=$1 AND status IN ('accepted','suggested')`,
      [req.params.id],
    );
    let movedCount = 0;
    for (const tm of toMove as Record<string, unknown>[]) {
      const { rowCount } = await client.query(
        `INSERT INTO topic_memberships
           (id, topic_id, entity_type, entity_id, source, status, confidence, evidence_json, reason_codes, suggestion_run_id, decided_at, decided_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (topic_id, entity_type, entity_id) DO NOTHING`,
        [crypto.randomUUID(), into_topic_id, tm.entity_type, tm.entity_id, tm.source, tm.status,
         tm.confidence, tm.evidence_json, tm.reason_codes, tm.suggestion_run_id, tm.decided_at, tm.decided_by, tm.created_at, now],
      );
      movedCount += rowCount ?? 0;
    }
    // Old rows become superseded (not deleted) — merge history stays auditable.
    await client.query(
      `UPDATE topic_memberships SET status='superseded', row_version=row_version+1, updated_at=$1 WHERE topic_id=$2 AND status IN ('accepted','suggested')`,
      [now, req.params.id],
    );
    await client.query(
      `UPDATE topics SET status='merged', merged_into_id=$1, updated_at=$2 WHERE id=$3`,
      [into_topic_id, now, req.params.id],
    );
    // Topic aliases follow the merge
    await client.query(
      `INSERT INTO topic_aliases (id, topic_id, alias, created_by, created_at)
       SELECT gen_random_uuid()::text, $1, alias, created_by, $2 FROM topic_aliases WHERE topic_id=$3
       ON CONFLICT (topic_id, alias) DO NOTHING`,
      [into_topic_id, now, req.params.id],
    );
    return movedCount;
  });
  res.json({ ok: true, memberships_moved: moved });
});

// ─── Aliases ─────────────────────────────────────────────────────────────────

router.post('/:id/aliases', async (req, res) => {
  const { alias } = req.body as Record<string, unknown>;
  if (typeof alias !== 'string' || !alias.trim()) return res.status(400).json({ error: 'alias required' });
  const { rows: topic } = await query(`SELECT id FROM topics WHERE id=$1`, [req.params.id]);
  if (!topic.length) return res.status(404).json({ error: 'Topic not found' });
  const { rows } = await query(
    `INSERT INTO topic_aliases (id, topic_id, alias, created_by, created_at)
     VALUES ($1,$2,$3,'manual',$4)
     ON CONFLICT (topic_id, alias) DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), req.params.id, alias.trim().toLowerCase(), new Date().toISOString()],
  );
  res.status(201).json(rows[0] ?? { ok: true, duplicate: true });
});

router.delete('/:id/aliases/:aliasId', async (req, res) => {
  const { rowCount } = await query(
    'DELETE FROM topic_aliases WHERE id=$1 AND topic_id=$2', [req.params.aliasId, req.params.id],
  );
  if (!rowCount) return res.status(404).json({ error: 'Alias not found' });
  res.json({ ok: true });
});

// ─── Memberships ─────────────────────────────────────────────────────────────

// GET /api/topics/:id/members?status=accepted
router.get('/:id/members', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'accepted';
  const { rows } = await query(
    `SELECT tm.*, ${TITLE_JOIN_SQL}
     WHERE tm.topic_id=$1 AND tm.status=$2 AND ${activeEntitySql('tm.entity_type', 'tm.entity_id')}
     ORDER BY tm.created_at DESC`,
    [req.params.id, status],
  );
  res.json(rows);
});

// POST /api/topics/:id/members — manual membership (authoritative)
router.post('/:id/members', async (req, res) => {
  const { entity_type, entity_id } = req.body as Record<string, unknown>;
  if (typeof entity_type !== 'string' || !ENTITY_TABLES[entity_type]) {
    return res.status(400).json({ error: `entity_type must be one of: ${Object.keys(ENTITY_TABLES).join(', ')}` });
  }
  if (typeof entity_id !== 'string' || !entity_id) return res.status(400).json({ error: 'entity_id required' });

  const { rows: topic } = await query(`SELECT id FROM topics WHERE id=$1 AND status='active'`, [req.params.id]);
  if (!topic.length) return res.status(404).json({ error: 'Topic not found' });
  if (!(await entityExists(entity_type, entity_id))) {
    return res.status(404).json({ error: `${entity_type} not found` });
  }

  const now = new Date().toISOString();
  // Manual add overrides any prior AI suggestion/rejection for this pair.
  const { rows } = await query(
    `INSERT INTO topic_memberships
       (id, topic_id, entity_type, entity_id, source, status, confidence, evidence_json, reason_codes, decided_at, decided_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'manual','accepted',1.0,'{}','["manual_assertion"]',$5,'user',$5,$5)
     ON CONFLICT (topic_id, entity_type, entity_id)
     DO UPDATE SET source='manual', status='accepted', confidence=1.0,
                   decided_at=$5, decided_by='user', row_version=topic_memberships.row_version+1, updated_at=$5
     RETURNING *`,
    [crypto.randomUUID(), req.params.id, entity_type, entity_id, now],
  );
  res.status(201).json(rows[0]);
});

// DELETE /api/topics/:id/members/:membershipId
// Manual rows are deleted outright; AI rows become 'rejected' so candidate
// generation cannot immediately resurface them.
router.delete('/:id/members/:membershipId', async (req, res) => {
  const now = new Date().toISOString();
  const { rows } = await query(
    'SELECT id, source FROM topic_memberships WHERE id=$1 AND topic_id=$2',
    [req.params.membershipId, req.params.id],
  );
  if (!rows.length) return res.status(404).json({ error: 'Membership not found' });
  const source = (rows[0] as { source: string }).source;
  if (source === 'manual' || source === 'imported') {
    await query('DELETE FROM topic_memberships WHERE id=$1', [req.params.membershipId]);
    return res.json({ ok: true, removed: true });
  }
  await query(
    `UPDATE topic_memberships SET status='rejected', decided_at=$1, decided_by='user', row_version=row_version+1, updated_at=$1 WHERE id=$2`,
    [now, req.params.membershipId],
  );
  res.json({ ok: true, rejected: true });
});

// ─── Candidate generation internals ──────────────────────────────────────────

const MIN_COSINE = 0.55;          // below this, embedding similarity alone is noise
const SUGGEST_THRESHOLD = 0.45;   // combined score needed to surface a suggestion

interface CandidateSignal {
  cosine?: { score: number; nearest_member: string };
  graph?: { via: string[] };
  alias?: { matched: string[] };
}

async function generateCandidatesForTopic(topicId: string, topicName: string, runId: string): Promise<number> {
  const now = new Date().toISOString();

  // Anything already decided for this topic (any status) is excluded — a
  // rejected pair must not reappear until the user changes something.
  const { rows: existingRows } = await query(
    'SELECT entity_type, entity_id FROM topic_memberships WHERE topic_id=$1',
    [topicId],
  );
  const excluded = new Set((existingRows as { entity_type: string; entity_id: string }[])
    .map(r => `${r.entity_type}:${r.entity_id}`));

  const { rows: memberRows } = await query(
    `SELECT entity_type, entity_id FROM topic_memberships WHERE topic_id=$1 AND status='accepted' AND ${activeEntitySql('entity_type', 'entity_id')}`,
    [topicId],
  );
  const members = memberRows as { entity_type: string; entity_id: string }[];

  const signals = new Map<string, CandidateSignal>();

  // Lane 1: embedding similarity — max cosine from any candidate embedding to
  // any accepted member embedding. Typed keys prevent cross-type collisions.
  if (members.length) {
    const memberKeys = members.map(m => `${m.entity_type}:${m.entity_id}`);
    const { rows: simRows } = await query(
      `WITH member_vecs AS (
         SELECT entity_type, entity_id, embedding_3072
         FROM embeddings
         WHERE is_stale = false AND embedding_3072 IS NOT NULL
           AND (entity_type || ':' || entity_id) = ANY($1)
       )
       SELECT e.entity_type, e.entity_id,
              MAX(1 - (e.embedding_3072 <=> mv.embedding_3072)) AS max_cosine,
              (ARRAY_AGG(mv.entity_type || ':' || mv.entity_id ORDER BY (e.embedding_3072 <=> mv.embedding_3072) ASC))[1] AS nearest_member
       FROM embeddings e
       CROSS JOIN member_vecs mv
       WHERE e.is_stale = false AND e.embedding_3072 IS NOT NULL AND ${activeEntitySql('e.entity_type', 'e.entity_id')}
         AND e.entity_type IN ('goal','task','milestone','resource','meeting','journal_entry','note')
         AND (e.entity_type || ':' || e.entity_id) <> ALL($1)
       GROUP BY e.entity_type, e.entity_id
       HAVING MAX(1 - (e.embedding_3072 <=> mv.embedding_3072)) >= $2`,
      [memberKeys, MIN_COSINE],
    );
    for (const r of simRows as { entity_type: string; entity_id: string; max_cosine: number; nearest_member: string }[]) {
      const key = `${r.entity_type}:${r.entity_id}`;
      if (excluded.has(key)) continue;
      signals.set(key, { ...signals.get(key), cosine: { score: Number(r.max_cosine), nearest_member: r.nearest_member } });
    }
  }

  // Lane 2: graph adjacency — edges and journal_links touching accepted members.
  if (members.length) {
    const memberKeys = members.map(m => `${m.entity_type}:${m.entity_id}`);
    const { rows: graphRows } = await query(
      `SELECT DISTINCT x.entity_type, x.entity_id, x.via FROM (
         SELECT e.target_type AS entity_type, e.target_id AS entity_id,
                'edge:' || e.relationship || ':' || e.source_type || ':' || e.source_id AS via
         FROM edges e WHERE (e.source_type || ':' || e.source_id) = ANY($1)
         UNION ALL
         SELECT e.source_type, e.source_id,
                'edge:' || e.relationship || ':' || e.target_type || ':' || e.target_id
         FROM edges e WHERE (e.target_type || ':' || e.target_id) = ANY($1)
         UNION ALL
         SELECT 'journal_entry', jl.journal_entry_id,
                'journal_link:' || jl.relationship || ':' || jl.target_type || ':' || jl.target_id
         FROM journal_links jl WHERE (jl.target_type || ':' || jl.target_id) = ANY($1)
         UNION ALL
         SELECT jl.target_type, jl.target_id,
                'journal_link:' || jl.relationship || ':journal_entry:' || jl.journal_entry_id
         FROM journal_links jl WHERE ('journal_entry:' || jl.journal_entry_id) = ANY($1)
       ) x
       WHERE ${activeEntitySql('x.entity_type', 'x.entity_id')} AND x.entity_type IN ('goal','task','milestone','resource','meeting','journal_entry','note')`,
      [memberKeys],
    );
    for (const r of graphRows as { entity_type: string; entity_id: string; via: string }[]) {
      const key = `${r.entity_type}:${r.entity_id}`;
      if (excluded.has(key)) continue;
      const prev = signals.get(key) ?? {};
      const via = prev.graph?.via ?? [];
      if (via.length < 5) via.push(r.via);
      signals.set(key, { ...prev, graph: { via } });
    }
  }

  // Lane 3: name/alias keyword match against entity titles.
  const { rows: aliasRows } = await query('SELECT alias FROM topic_aliases WHERE topic_id=$1', [topicId]);
  const terms = [topicName.toLowerCase(), ...(aliasRows as { alias: string }[]).map(a => a.alias.toLowerCase())]
    .filter(t => t.length >= 3);
  if (terms.length) {
    for (const [etype, spec] of Object.entries(ENTITY_TABLES)) {
      if (etype === 'journal_entry') continue; // date column — no meaningful title match
      const conds = terms.map((_, i) => `LOWER(${spec.titleCol}) LIKE $${i + 1}`).join(' OR ');
      const { rows: matchRows } = await query(
        `SELECT id, ${spec.titleCol} AS title FROM ${spec.table} WHERE (${conds}) AND ${activeEntitySql(`'${etype}'`, 'id')}`,
        terms.map(t => `%${t}%`),
      );
      for (const r of matchRows as { id: string; title: string }[]) {
        const key = `${etype}:${r.id}`;
        if (excluded.has(key)) continue;
        const prev = signals.get(key) ?? {};
        const matched = terms.filter(t => r.title.toLowerCase().includes(t));
        signals.set(key, { ...prev, alias: { matched } });
      }
    }
  }

  // Score + insert suggestions. An embedding-near record does NOT become a
  // member — it becomes an explainable suggestion pending user review.
  let created = 0;
  for (const [key, sig] of signals) {
    const cosine = sig.cosine?.score ?? 0;
    const graphBoost = sig.graph ? 0.25 : 0;
    const aliasBoost = sig.alias ? 0.2 : 0;
    const score = 0.6 * cosine + graphBoost + aliasBoost;
    if (score < SUGGEST_THRESHOLD) continue;

    const [entityType, entityId] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const reasons: string[] = [];
    if (sig.cosine) reasons.push('embedding_similarity');
    if (sig.graph) reasons.push('graph_neighbor');
    if (sig.alias) reasons.push('alias_match');

    const { rowCount } = await query(
      `INSERT INTO topic_memberships
         (id, topic_id, entity_type, entity_id, source, status, confidence, evidence_json, reason_codes, suggestion_run_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'ai_suggested','suggested',$5,$6,$7,$8,$9,$9)
       ON CONFLICT (topic_id, entity_type, entity_id) DO NOTHING`,
      [crypto.randomUUID(), topicId, entityType, entityId,
       Math.min(0.95, Math.round(score * 100) / 100),
       JSON.stringify(sig), JSON.stringify(reasons), runId, now],
    );
    created += rowCount ?? 0;
  }
  return created;
}

export { router as topicsRouter };
