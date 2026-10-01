import { Router } from 'express';
import crypto from 'crypto';
import { query, transaction } from '../db.js';
import type pg from 'pg';
import {
  embedDocument,
  embedQuery,
  EMBED_DIMENSION,
  EMBED_MODEL,
} from '../embeddingProvider.js';
import { queueEmbeddingUpsert } from '../services/embeddingLifecycle.js';
import { rateLimit } from '../utils/rateLimit.js';
import { ALLOW_CLOUD_RAW_TEXT, PROVIDER_MODE } from '../config/providers.js';
import { activeResourceSql } from '../utils/archiveVisibility.js';

const router = Router();

// ─── Build embedding text for each entity type ────────────────────────────────

async function buildEmbeddingText(entityType: string, entityId: string): Promise<string | null> {
  if (entityType === 'goal') {
    const { rows } = await query('SELECT * FROM goals WHERE id=$1', [entityId]);
    if (!rows.length) return null;
    const g = rows[0] as Record<string, unknown>;
    const { rows: milestones } = await query('SELECT title FROM goal_milestones WHERE goal_id=$1', [entityId]);
    return [
      `Entity: Goal`,
      `Title: ${g.title}`,
      `Description: ${g.description || '(none)'}`,
      `Category: ${g.category}`,
      `Status: ${g.status} | Progress: ${g.progress}%`,
      g.deadline ? `Deadline: ${g.deadline}` : null,
      milestones.length ? `Milestones: ${milestones.map((m: Record<string, unknown>) => m.title).join(', ')}` : null,
    ].filter(Boolean).join('\n');
  }

  if (entityType === 'task') {
    const { rows } = await query('SELECT * FROM tasks WHERE id=$1', [entityId]);
    if (!rows.length) return null;
    const t = rows[0] as Record<string, unknown>;
    const { rows: goalRows } = t.goal_id ? await query('SELECT title FROM goals WHERE id=$1', [t.goal_id]) : { rows: [] };
    const { rows: milestoneRows } = t.milestone_id ? await query('SELECT title FROM goal_milestones WHERE id=$1', [t.milestone_id]) : { rows: [] };
    return [
      `Entity: Task`,
      `Title: ${t.title}`,
      t.description ? `Description: ${t.description}` : null,
      goalRows.length ? `Goal: ${(goalRows[0] as Record<string, unknown>).title}` : null,
      milestoneRows.length ? `Milestone: ${(milestoneRows[0] as Record<string, unknown>).title}` : null,
      t.due_date ? `Due: ${t.due_date}` : null,
      t.estimated_minutes ? `Estimated: ${t.estimated_minutes} minutes` : null,
      `Status: ${t.status} | Priority: ${t.priority} | Kind: ${t.kind}`,
    ].filter(Boolean).join('\n');
  }

  if (entityType === 'resource') {
    const { rows } = await query('SELECT * FROM resources WHERE id=$1', [entityId]);
    if (!rows.length) return null;
    const r = rows[0] as Record<string, unknown>;
    return [
      `Entity: Resource`,
      `Title: ${r.title}`,
      `Type: ${r.type}`,
      r.description ? `Description: ${r.description}` : null,
      r.info ? `Info: ${r.info}` : null,
      `Read state: ${r.read_state}`,
      r.estimated_minutes ? `Estimated reading time: ${r.estimated_minutes} minutes` : null,
      r.url ? `URL: ${r.url}` : null,
    ].filter(Boolean).join('\n');
  }

  if (entityType === 'journal_entry') {
    const { rows } = await query('SELECT * FROM journal_entries WHERE id=$1', [entityId]);
    if (!rows.length) return null;
    const j = rows[0] as Record<string, unknown>;
    // Raw journal text must NOT be sent to cloud providers unless explicitly opted in.
    // In hybrid/cloud mode (Gemini embeddings), only use the AI-generated summary.
    const includeRawText = PROVIDER_MODE === 'local' || ALLOW_CLOUD_RAW_TEXT;
    return [
      `Entity: Journal Entry`,
      `Date: ${j.entry_date}`,
      j.summary ? `Summary: ${j.summary}` : null,
      j.mood ? `Mood: ${j.mood}` : null,
      j.energy_level ? `Energy: ${j.energy_level}` : null,
      includeRawText && j.raw_text ? `Content: ${(j.raw_text as string).slice(0, 500)}` : null,
    ].filter(Boolean).join('\n');
  }

  if (entityType === 'note') {
    const { rows } = await query('SELECT * FROM notes WHERE id=$1', [entityId]);
    if (!rows.length) return null;
    const n = rows[0] as Record<string, unknown>;
    return [
      `Entity: Note`,
      `Title: ${n.title}`,
      `Date: ${n.date_str}`,
      `Content: ${(n.content as string).slice(0, 500)}`,
    ].filter(Boolean).join('\n');
  }

  if (entityType === 'resource_chunk') {
    // entityId here IS the chunk_id (see embeddingWorker for how this is resolved)
    const { rows } = await query(
      `SELECT rc.id, rc.resource_id, rc.chunk_index, rc.content, rc.heading, rc.page_start, rc.page_end,
              r.title as resource_title
       FROM resource_chunks rc
       LEFT JOIN resources r ON r.id = rc.resource_id
       WHERE rc.id = $1`,
      [entityId],
    );
    if (!rows.length) return null;
    const c = rows[0] as Record<string, unknown>;
    return [
      `Entity: Resource Chunk`,
      `Resource: ${c.resource_title ?? 'Unknown'}`,
      c.heading ? `Section: ${c.heading}` : null,
      (c.page_start != null) ? `Pages: ${c.page_start}–${c.page_end ?? c.page_start}` : null,
      `Chunk: ${c.chunk_index}`,
      `Content: ${(c.content as string).slice(0, 600)}`,
    ].filter(Boolean).join('\n');
  }

  if (entityType === 'meeting') {
    const { rows } = await query('SELECT * FROM meetings WHERE id=$1', [entityId]);
    if (!rows.length) return null;
    const m = rows[0] as Record<string, unknown>;
    return [
      `Entity: Meeting`,
      `Title: ${m.title}`,
      `Scheduled: ${m.scheduled_at}`,
      m.notes ? `Notes: ${m.notes}` : null,
      m.summary ? `Summary: ${m.summary}` : null,
    ].filter(Boolean).join('\n');
  }

  return null;
}

// ─── Core embed + store function ─────────────────────────────────────────────

export async function embedEntity(
  entityType: string,
  entityId: string,
  scope = 'full_text',
  beforeWrite?: (client: pg.PoolClient) => Promise<void>,
) {
  const text = await buildEmbeddingText(entityType, entityId);
  if (!text) return;

  const contentHash = crypto.createHash('sha256').update(text).digest('hex');

  // Check if unchanged
  const { rows: existing } = await query(
    `SELECT id, content_hash, embedding_model, embedding_dimension,
            embedding_3072 IS NOT NULL AS has_embedding
     FROM embeddings
     WHERE entity_type=$1 AND entity_id=$2 AND embedding_scope=$3`,
    [entityType, entityId, scope],
  );
  if (existing.length) {
    const current = existing[0] as Record<string, unknown>;
    if (
      current.content_hash === contentHash
      && current.embedding_model === EMBED_MODEL
      && Number(current.embedding_dimension) === EMBED_DIMENSION
      && current.has_embedding === true
    ) {
      await transaction(async client => {
        await beforeWrite?.(client);
        await client.query('UPDATE embeddings SET is_stale=false WHERE id=$1', [current.id]);
      });
      return;
    }
  }

  const vector = await embedDocument(text);
  if (vector.length !== EMBED_DIMENSION) {
    throw new Error(
      `dimension_mismatch: got ${vector.length} expected ${EMBED_DIMENSION} (model=${EMBED_MODEL})`,
    );
  }
  const vectorStr = `[${vector.join(',')}]`;
  const now = new Date().toISOString();
  const id = existing.length ? (existing[0] as Record<string, unknown>).id as string : crypto.randomUUID();

  // Upsert by primary key. Three cases:
  //   new entity     → new UUID, clean insert
  //   content same   → caught by early-return above, never reaches here
  //   content changed→ reused UUID, PK conflict → DO UPDATE replaces the row in place
  // Using (entity_type,entity_id,embedding_scope,content_hash) as conflict target would
  // miss the PK conflict when hash changes, causing a constraint violation error.
  await transaction(async client => {
    await beforeWrite?.(client);
    await client.query(
    `INSERT INTO embeddings (
       id,entity_type,entity_id,embedding_scope,embedding_text,embedding_3072,
       embedding_model,embedding_dimension,content_hash,is_stale,created_at,updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6::halfvec,$7,$8,$9,false,$10,$11)
     ON CONFLICT (id) DO UPDATE
     SET embedding_text=EXCLUDED.embedding_text,
         embedding_3072=EXCLUDED.embedding_3072,
         embedding_model=EXCLUDED.embedding_model,
         embedding_dimension=EXCLUDED.embedding_dimension,
         content_hash=EXCLUDED.content_hash,
         is_stale=false,
         updated_at=EXCLUDED.updated_at`,
    [id, entityType, entityId, scope, text, vectorStr, EMBED_MODEL, EMBED_DIMENSION, contentHash, now, now],
  );
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/embeddings/embed — embed a single entity on demand
router.post('/embed', async (req, res) => {
  const { entity_type, entity_id, scope = 'full_text' } = req.body as Record<string, string>;
  if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type and entity_id required' });
  try {
    await embedEntity(entity_type, entity_id, scope);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/embeddings/search — semantic search across all embedded entities
router.post('/search', async (req, res) => {
  const { query: searchQuery, entity_types, limit = 10 } = req.body as {
    query: string;
    entity_types?: string[];
    limit?: number;
  };
  if (!searchQuery) return res.status(400).json({ error: 'query required' });

  try {
    const queryVec = await embedQuery(searchQuery);
    const vectorStr = `[${queryVec.join(',')}]`;

    let sql = `
      SELECT id, entity_type, entity_id, embedding_scope,
             LEFT(embedding_text, 200) as text_snippet,
             1 - (embedding_3072 <=> $1::halfvec) as similarity
      FROM embeddings
      WHERE is_stale = false
        AND embedding_3072 IS NOT NULL
        AND embedding_model = $2
        AND embedding_dimension = $3
        AND (entity_type <> 'resource_chunk' OR EXISTS (
          SELECT 1 FROM resource_chunks c JOIN resources r ON r.id=c.resource_id
          LEFT JOIN resource_processing_jobs j ON j.resource_id=r.id
          LEFT JOIN resource_drive_files d ON d.resource_id=r.id AND r.file_path LIKE 'gdrive://%'
          WHERE c.id=embeddings.entity_id AND ${activeResourceSql('r.id')}
            AND (j.resource_id IS NULL OR j.status='ready')
            AND (d.resource_id IS NULL OR (d.available AND j.status='ready' AND r.file_validation='valid'))
        ))
    `;
    const params: unknown[] = [vectorStr, EMBED_MODEL, EMBED_DIMENSION];

    if (entity_types?.length) {
      params.push(entity_types);
      sql += ` AND entity_type = ANY($${params.length})`;
    }

    sql += ` ORDER BY embedding_3072 <=> $1::halfvec LIMIT $${params.length + 1}`;
    params.push(limit);

    const { rows } = await query(sql, params);

    // Hydrate resource_chunk results with chunk metadata so callers don't need a second request
    const chunkRows = rows.filter((r: Record<string, unknown>) => r.entity_type === 'resource_chunk');
    if (chunkRows.length) {
      const chunkIds = chunkRows.map((r: Record<string, unknown>) => r.entity_id as string);
      const { rows: chunks } = await query(
        `SELECT rc.id, rc.resource_id, rc.chunk_index, rc.heading, rc.content, rc.page_start, rc.page_end,
                r.title as resource_title
         FROM resource_chunks rc
         LEFT JOIN resources r ON r.id = rc.resource_id
         WHERE rc.id = ANY($1)`,
        [chunkIds],
      );
      const chunkMap = new Map(chunks.map((c: Record<string, unknown>) => [c.id as string, c]));
      for (const row of rows as Record<string, unknown>[]) {
        if (row.entity_type === 'resource_chunk') {
          const chunk = chunkMap.get(row.entity_id as string);
          if (chunk) {
            row.chunk_context = {
              resource_id: chunk.resource_id,
              resource_title: chunk.resource_title,
              chunk_index: chunk.chunk_index,
              heading: chunk.heading,
              page_start: chunk.page_start,
              page_end: chunk.page_end,
              content_snippet: (chunk.content as string).slice(0, 400),
            };
          }
        }
      }
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/embeddings/process-jobs — process pending embedding_jobs (also called by auto-worker)
router.post('/process-jobs', async (req, res) => {
  const raw = Number((req.body as Record<string, unknown>).batch_size ?? 10);
  const batchSize = Math.min(Math.max(1, Math.trunc(raw) || 10), 50); // clamp 1–50
  const { processEmbeddingJobs } = await import('../services/embeddingWorker.js');
  const result = await processEmbeddingJobs(batchSize);
  res.json(result);
});

// POST /api/embeddings/retry-failed — reset failed jobs so worker retries them
router.post('/retry-failed', async (_req, res) => {
  const { rowCount } = await query(
    `UPDATE embedding_jobs SET status='pending', attempts=0, error=NULL WHERE status='failed'`,
  );
  res.json({ reset: rowCount ?? 0 });
});

// POST /api/embeddings/backfill — rate-limited: 3 per minute (bulk Gemini API calls)
router.post('/backfill', rateLimit(3, 60_000, 'embeddings-backfill'), async (_req, res) => {
  const entityTypes = ['goal', 'task', 'resource', 'journal_entry', 'note', 'meeting'];
  const tables: Record<string, string> = {
    goal: 'goals', task: 'tasks', resource: 'resources',
    journal_entry: 'journal_entries', note: 'notes', meeting: 'meetings',
  };
  let queued = 0;

  for (const etype of entityTypes) {
    const table = tables[etype];
    const { rows } = await query(
      `SELECT t.id FROM ${table} t
       LEFT JOIN embeddings e
         ON e.entity_type=$1
        AND e.entity_id=t.id
        AND e.is_stale=false
        AND e.embedding_3072 IS NOT NULL
        AND e.embedding_model=$2
        AND e.embedding_dimension=$3
       WHERE e.id IS NULL`,
      [etype, EMBED_MODEL, EMBED_DIMENSION],
    );
    for (const row of rows) {
      await queueEmbeddingUpsert(etype, (row as Record<string, unknown>).id as string);
      queued++;
    }
  }

  res.json({ queued });
});

// GET /api/embeddings/status/:entityType/:entityId — per-entity embedding
// inspection for the Testing workbench: is there a vector, is it stale, what
// text was embedded, and what jobs are outstanding.
router.get('/status/:entityType/:entityId', async (req, res) => {
  const { entityType, entityId } = req.params;
  const [{ rows: embRows }, { rows: jobRows }] = await Promise.all([
    query(
      `SELECT embedding_scope, embedding_model, embedding_dimension, is_stale, updated_at,
              (embedding_3072 IS NOT NULL) AS has_vector,
              LEFT(embedding_text, 400) AS embedded_text_preview
       FROM embeddings WHERE entity_type=$1 AND entity_id=$2`,
      [entityType, entityId],
    ),
    query(
      `SELECT status, action, attempts, error, created_at, processed_at
       FROM embedding_jobs WHERE entity_type=$1 AND (entity_id=$2 OR chunk_id=$2)
       ORDER BY created_at DESC LIMIT 5`,
      [entityType, entityId],
    ),
  ]);
  res.json({ embeddings: embRows, recent_jobs: jobRows });
});

// GET /api/embeddings/stats
router.get('/stats', async (_req, res) => {
  const [
    { rows: countRows },
    { rows: jobRows },
    { rows: ageRows },
    { rows: stuckRows },
    { rows: staleRows },
  ] = await Promise.all([
    query(
      `SELECT entity_type, embedding_model, embedding_dimension, COUNT(*) as count
       FROM embeddings
       WHERE is_stale=false AND embedding_3072 IS NOT NULL
       GROUP BY entity_type, embedding_model, embedding_dimension
       ORDER BY count DESC`,
    ),
    query("SELECT status, COUNT(*) as count FROM embedding_jobs GROUP BY status"),
    // Oldest pending job age
    query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int as oldest_pending_seconds
       FROM embedding_jobs WHERE status='pending'`,
    ),
    // Stuck leases: processing past lease_expires_at
    query(
      `SELECT COUNT(*) as count FROM embedding_jobs
       WHERE status='processing' AND lease_expires_at IS NOT NULL AND lease_expires_at::TIMESTAMPTZ < NOW()`,
    ),
    // Stale embedding count
    query(
      `SELECT COUNT(*) as count FROM embeddings WHERE is_stale=true`,
    ),
  ]);

  res.json({
    embeddings: countRows,
    jobs: jobRows,
    oldest_pending_seconds: ageRows[0]?.oldest_pending_seconds ?? null,
    stuck_leases: Number((stuckRows[0] as Record<string, unknown>)?.count ?? 0),
    stale_embeddings: Number((staleRows[0] as Record<string, unknown>)?.count ?? 0),
    embed_model: EMBED_MODEL,
    embed_dimension: EMBED_DIMENSION,
  });
});

export { router as embeddingsRouter };
