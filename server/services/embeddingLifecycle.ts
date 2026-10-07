import crypto from 'crypto';
import type pg from 'pg';
import { query } from '../db.js';

const DEFAULT_PRIORITY = 3;

export async function queueEmbeddingUpsert(
  entityType: string,
  entityId: string,
  chunkId?: string | null,
  priority = DEFAULT_PRIORITY,
  client?: pg.PoolClient,
): Promise<void> {
  const execute = client ? (sql: string, values: unknown[]) => client.query(sql, values) : query;
  await execute(
    `INSERT INTO embedding_jobs
       (id, entity_type, entity_id, chunk_id, action, priority, status, attempts, created_at)
     VALUES ($1, $2, $3, $4, 'upsert', $5, 'pending', 0, $6)
     ON CONFLICT DO NOTHING`,
    [crypto.randomUUID(), entityType, entityId, chunkId ?? null, priority, new Date().toISOString()],
  );
}

export async function queueEmbeddingDelete(
  entityType: string,
  entityId: string,
  chunkId?: string | null,
  priority = DEFAULT_PRIORITY,
): Promise<void> {
  await query(
    `INSERT INTO embedding_jobs
       (id, entity_type, entity_id, chunk_id, action, priority, status, attempts, created_at)
     VALUES ($1, $2, $3, $4, 'delete', $5, 'pending', 0, $6)
     ON CONFLICT DO NOTHING`,
    [crypto.randomUUID(), entityType, entityId, chunkId ?? null, priority, new Date().toISOString()],
  );
}

export async function markEmbeddingStale(
  entityType: string,
  entityId: string,
  client?: pg.PoolClient,
): Promise<void> {
  const execute = client ? (sql: string, values: unknown[]) => client.query(sql, values) : query;
  await execute(
    `UPDATE embeddings SET is_stale = true, updated_at = $1
     WHERE entity_type = $2 AND entity_id = $3`,
    [new Date().toISOString(), entityType, entityId],
  );
}
