import {EMBED_TABLE} from '../config/providers.js';
import { pool, query } from '../db.js';
import { embedEntity } from '../routes/embeddings.js';
import { log, newCid } from '../utils/logger.js';

interface EmbeddingJob {
  id: string;
  entity_type: string;
  entity_id: string;
  chunk_id: string | null;
  action: string;
  attempts: number;
}

const MAX_ATTEMPTS = 3;

// Reset jobs stuck in 'processing' past their lease window (handles server crashes).
export async function reclaimExpiredJobs(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE embedding_jobs
     SET status = 'pending', lease_expires_at = NULL
     WHERE status = 'processing'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at::TIMESTAMPTZ < NOW()`,
  );
  return rowCount ?? 0;
}

export async function processEmbeddingJobs(batchSize = 10): Promise<{ processed: number; failed: number }> {
  // ── Step 1: Atomically claim a batch. ────────────────────────────────────────
  // FOR UPDATE SKIP LOCKED prevents two overlapping intervals from claiming the
  // same jobs. The transaction is kept short (no Ollama calls inside it).
  let jobs: EmbeddingJob[] = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<EmbeddingJob>(
      `SELECT id, entity_type, entity_id, chunk_id, action, attempts
       FROM embedding_jobs
       WHERE status = 'pending'
         AND attempts < $1
         AND (next_attempt_at IS NULL OR next_attempt_at::TIMESTAMPTZ <= NOW())
       ORDER BY priority DESC, created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS, batchSize],
    );
    jobs = rows;
    if (jobs.length) {
      // lease_expires_at gives a 10-minute window to finish; expired leases are recovered on startup
      const leaseExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await client.query(
        `UPDATE embedding_jobs SET status = 'processing', attempts = attempts + 1, lease_expires_at = $1
         WHERE id = ANY($2)`,
        [leaseExpiry, jobs.map(j => j.id)],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  if (!jobs.length) return { processed: 0, failed: 0 };

  // ── Step 2: Process jobs outside the transaction (Ollama calls are slow). ────
  let processed = 0;
  let failed = 0;
  const now = new Date().toISOString();

  for (const job of jobs) {
    try {
      if (job.action === 'upsert') {
        // For resource_chunk jobs, chunk_id IS the entity to embed (it identifies the unique chunk).
        // embedEntity('resource_chunk', chunkId) builds text by loading the chunk by its own ID.
        const effectiveEntityId = (job.entity_type === 'resource_chunk' && job.chunk_id)
          ? job.chunk_id
          : job.entity_id;
        await embedEntity(job.entity_type, effectiveEntityId);
      } else if (job.action === 'delete') {
        if (job.entity_type === 'resource_chunk' && job.chunk_id) {
          // Delete only the specific chunk embedding, not all embeddings for the resource
          await query(
            `DELETE FROM ${EMBED_TABLE} WHERE entity_type=$1 AND entity_id=$2`,
            [job.entity_type, job.chunk_id],
          );
        } else {
          await query(
            `DELETE FROM ${EMBED_TABLE} WHERE entity_type=$1 AND entity_id=$2`,
            [job.entity_type, job.entity_id],
          );
        }
      } else {
        // Unknown action — fail permanently so the bug is visible in stats, not silently swallowed.
        throw new Error(`Unknown embedding job action: ${job.action}`);
      }
      await query(
        `UPDATE embedding_jobs SET status = 'done', processed_at = $1 WHERE id = $2`,
        [now, job.id],
      );
      processed++;
    } catch (err) {
      // attempts was already incremented to job.attempts+1 in the transaction above
      const newAttempts = job.attempts + 1;
      if (newAttempts >= MAX_ATTEMPTS) {
        await query(
          `UPDATE embedding_jobs SET status = 'failed', error = $1 WHERE id = $2`,
          [String(err), job.id],
        );
        log('error', 'embedding-worker', 'Job permanently failed', {
            job_id: job.id, entity_type: job.entity_type, entity_id: job.entity_id,
            action: job.action, attempts: newAttempts, error: String(err),
          }, newCid());
        failed++;
      } else {
        // Exponential backoff: 2, 4, 8 minutes
        const delayMs = Math.pow(2, newAttempts) * 60 * 1000;
        const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
        await query(
          `UPDATE embedding_jobs SET status = 'pending', error = $1, next_attempt_at = $2 WHERE id = $3`,
          [String(err), nextAttemptAt, job.id],
        );
        log('warn', 'embedding-worker', 'Job failed — will retry', {
            job_id: job.id, entity_type: job.entity_type, entity_id: job.entity_id,
            action: job.action, attempt: newAttempts, next_attempt: nextAttemptAt, error: String(err),
          }, newCid());
      }
    }
  }

  return { processed, failed };
}
