import { activeEntitySql } from '../utils/archiveVisibility.js';
import { Router } from 'express';
import { query } from '../db.js';
import { embedQuery, EMBED_DIMENSION, EMBED_MODEL } from '../embeddingProvider.js';

const router = Router();

const ALLOWED_TYPES = new Set(['goal', 'task', 'resource', 'note', 'journal_entry', 'meeting', 'milestone', 'resource_chunk']);

interface SearchHit {
  entity_type: string;
  entity_id: string;
  title: string;
  snippet: string | null;
  score: number;
  url?: string | null;
  due_date?: string | null;
  status?: string | null;
  goal_id?: string | null;
}

async function hydrate(entityType: string, entityId: string): Promise<{ title: string; snippet: string | null; extra: Record<string, unknown> } | null> {
  if (entityType === 'goal') {
    const { rows } = await query(`SELECT title, description, status FROM goals WHERE id=$1 AND ${activeEntitySql("'goal'", 'goals.id')}`, [entityId]);
    if (!rows.length) return null;
    const g = rows[0] as Record<string, unknown>;
    return { title: String(g.title ?? ''), snippet: g.description ? String(g.description).slice(0, 200) : null, extra: { status: g.status } };
  }
  if (entityType === 'task') {
    const { rows } = await query(`SELECT title, description, status, due_date, goal_id FROM tasks WHERE id=$1 AND ${activeEntitySql("'task'", 'tasks.id')}`, [entityId]);
    if (!rows.length) return null;
    const t = rows[0] as Record<string, unknown>;
    return { title: String(t.title ?? ''), snippet: t.description ? String(t.description).slice(0, 200) : null, extra: { status: t.status, due_date: t.due_date, goal_id: t.goal_id } };
  }
  if (entityType === 'resource') {
    const { rows } = await query(`SELECT title, description, url FROM resources WHERE id=$1 AND ${activeEntitySql("'resource'", 'resources.id')}`, [entityId]);
    if (!rows.length) return null;
    const r = rows[0] as Record<string, unknown>;
    return { title: String(r.title ?? ''), snippet: r.description ? String(r.description).slice(0, 200) : null, extra: { url: r.url } };
  }
  if (entityType === 'note') {
    const { rows } = await query('SELECT title, content, date_str FROM notes WHERE id=$1', [entityId]);
    if (!rows.length) return null;
    const n = rows[0] as Record<string, unknown>;
    return { title: String(n.title ?? n.date_str ?? ''), snippet: n.content ? String(n.content).slice(0, 200) : null, extra: {} };
  }
  if (entityType === 'journal_entry') {
    const { rows } = await query('SELECT entry_date, summary FROM journal_entries WHERE id=$1', [entityId]);
    if (!rows.length) return null;
    const j = rows[0] as Record<string, unknown>;
    return { title: `Journal — ${j.entry_date}`, snippet: j.summary ? String(j.summary).slice(0, 200) : null, extra: {} };
  }
  if (entityType === 'meeting') {
    const { rows } = await query(`SELECT title, summary, scheduled_at FROM meetings WHERE id=$1 AND ${activeEntitySql("'meeting'", 'meetings.id')}`, [entityId]);
    if (!rows.length) return null;
    const m = rows[0] as Record<string, unknown>;
    return { title: String(m.title ?? ''), snippet: m.summary ? String(m.summary).slice(0, 200) : null, extra: {} };
  }
  if (entityType === 'milestone') {
    const { rows } = await query(`SELECT title, description, due_date, goal_id FROM goal_milestones WHERE id=$1 AND ${activeEntitySql("'milestone'", 'goal_milestones.id')}`, [entityId]);
    if (!rows.length) return null;
    const ms = rows[0] as Record<string, unknown>;
    return { title: String(ms.title ?? ''), snippet: ms.description ? String(ms.description).slice(0, 200) : null, extra: { due_date: ms.due_date, goal_id: ms.goal_id } };
  }
  if (entityType === 'resource_chunk') {
    // entityId is the chunk id; surface the parent resource with a page citation
    const { rows } = await query(
      `SELECT rc.content, rc.page_start, rc.page_end, rc.resource_id, r.title AS resource_title, r.url
       FROM resource_chunks rc LEFT JOIN resources r ON r.id = rc.resource_id
       WHERE rc.id=$1 AND ${activeEntitySql("'resource'", "r.id")}`,
      [entityId],
    );
    if (!rows.length) return null;
    const c = rows[0] as Record<string, unknown>;
    const pages = c.page_start != null
      ? ` (p. ${c.page_start}${c.page_end && c.page_end !== c.page_start ? `–${c.page_end}` : ''})`
      : '';
    return {
      title: `${c.resource_title ?? 'Document'}${pages}`,
      snippet: c.content ? String(c.content).slice(0, 200) : null,
      extra: { url: c.url, resource_id: c.resource_id, page_start: c.page_start, page_end: c.page_end },
    };
  }
  return null;
}

async function keywordSearch(q: string, types: string[], limit: number): Promise<SearchHit[]> {
  const pat = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const hits: SearchHit[] = [];

  const queries: { type: string; sql: string }[] = [
    { type: 'goal', sql: `SELECT id, title, description as snippet, status, NULL as url, NULL as due_date, NULL as goal_id FROM goals WHERE ${activeEntitySql("'goal'", 'goals.id')} AND ((title ILIKE $1 OR description ILIKE $1) AND archived_at IS NULL) LIMIT $2` },
    { type: 'task', sql: `SELECT id, title, description as snippet, status, NULL as url, due_date, goal_id FROM tasks WHERE ${activeEntitySql("'task'", 'tasks.id')} AND ((title ILIKE $1 OR description ILIKE $1) AND completed=false) LIMIT $2` },
    { type: 'resource', sql: `SELECT id, title, description as snippet, NULL as status, url, NULL as due_date, NULL as goal_id FROM resources WHERE ${activeEntitySql("'resource'", 'resources.id')} AND (title ILIKE $1 OR description ILIKE $1) LIMIT $2` },
    { type: 'note', sql: `SELECT id, title, LEFT(content,200) as snippet, NULL as status, NULL as url, NULL as due_date, NULL as goal_id FROM notes WHERE title ILIKE $1 OR content ILIKE $1 LIMIT $2` },
    { type: 'journal_entry', sql: `SELECT id, entry_date::TEXT as title, LEFT(summary,200) as snippet, NULL as status, NULL as url, NULL as due_date, NULL as goal_id FROM journal_entries WHERE summary ILIKE $1 LIMIT $2` },
    { type: 'meeting', sql: `SELECT id, title, LEFT(summary,200) as snippet, NULL as status, NULL as url, NULL as due_date, NULL as goal_id FROM meetings WHERE ${activeEntitySql("'meeting'", 'meetings.id')} AND (title ILIKE $1 OR summary ILIKE $1) LIMIT $2` },
    { type: 'milestone', sql: `SELECT id, title, description as snippet, NULL as status, NULL as url, due_date, goal_id FROM goal_milestones WHERE ${activeEntitySql("'milestone'", 'goal_milestones.id')} AND (title ILIKE $1 OR description ILIKE $1) LIMIT $2` },
    { type: 'resource_chunk', sql: `SELECT rc.id, r.title || COALESCE(' (p. ' || rc.page_start || ')', '') as title, LEFT(rc.content,200) as snippet, NULL as status, r.url, NULL as due_date, NULL as goal_id FROM resource_chunks rc LEFT JOIN resources r ON r.id = rc.resource_id WHERE rc.content ILIKE $1 AND ${activeEntitySql("'resource'", "r.id")} LIMIT $2` },
  ];

  const perType = Math.ceil(limit / types.length);
  await Promise.all(
    queries
      .filter(q => types.includes(q.type))
      .map(async ({ type, sql }) => {
        const { rows } = await query(sql, [pat, perType]);
        for (const r of rows as Record<string, unknown>[]) {
          hits.push({
            entity_type: type,
            entity_id: r.id as string,
            title: String(r.title ?? ''),
            snippet: r.snippet ? String(r.snippet).slice(0, 200) : null,
            score: 0.5,
            url: r.url as string | null,
            due_date: r.due_date as string | null,
            status: r.status as string | null,
            goal_id: r.goal_id as string | null,
          });
        }
      }),
  );

  return hits.slice(0, limit);
}

// GET /api/search?q=...&types=goal,task&limit=20
router.get('/', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });

  const rawLimit = Math.min(Math.max(1, Number(req.query.limit ?? 20)), 50);
  const rawTypes = req.query.types ? String(req.query.types).split(',').map(s => s.trim()) : Array.from(ALLOWED_TYPES);
  const types = rawTypes.filter(t => ALLOWED_TYPES.has(t));
  if (!types.length) return res.status(400).json({ error: 'No valid entity types specified' });

  let vectorDegraded = false;
  let hits: SearchHit[] = [];

  // Attempt vector search
  try {
    const vec = await embedQuery(q);
    const vectorStr = `[${vec.join(',')}]`;

    const sql = `
      SELECT e.entity_type, e.entity_id, 1 - (e.embedding_3072 <=> $1::halfvec) as score
      FROM embeddings e
      WHERE e.is_stale = false AND ${activeEntitySql('e.entity_type', 'e.entity_id')}
        AND e.embedding_3072 IS NOT NULL
        AND e.embedding_model = $2
        AND e.embedding_dimension = $3
        AND e.entity_type = ANY($4)
      ORDER BY e.embedding_3072 <=> $1::halfvec
      LIMIT $5
    `;
    const { rows } = await query(sql, [vectorStr, EMBED_MODEL, EMBED_DIMENSION, types, rawLimit]);

    // Hydrate each result with entity metadata
    const settled = await Promise.allSettled(
      (rows as Record<string, unknown>[]).map(async r => {
        const info = await hydrate(r.entity_type as string, r.entity_id as string);
        if (!info) return null;
        return {
          entity_type: r.entity_type as string,
          entity_id: r.entity_id as string,
          title: info.title,
          snippet: info.snippet,
          score: Number(r.score),
          ...info.extra,
        } as SearchHit;
      }),
    );

    hits = settled
      .filter((s): s is PromiseFulfilledResult<SearchHit | null> => s.status === 'fulfilled' && s.value !== null)
      .map(s => s.value as SearchHit);
  } catch {
    vectorDegraded = true;
  }

  // Fall back to keyword search if vector gave 0 results or degraded
  if (vectorDegraded || hits.length === 0) {
    hits = await keywordSearch(q, types, rawLimit);
  }

  res.json({
    results: hits.sort((a, b) => b.score - a.score),
    total: hits.length,
    vector_degraded: vectorDegraded,
    query: q,
  });
});

export { router as searchRouter };
