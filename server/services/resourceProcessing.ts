import crypto from 'node:crypto';
import type pg from 'pg';
import { query, transaction } from '../db.js';
import { processResourceChunks } from './chunkPipeline.js';
import { materializeStoredFile, isPrivateBlobReference, verifyPrivateBlob } from './fileStorage.js';
import { DocumentError, validateStoredContent } from './uploadValidation.js';
import { embedEntity } from '../routes/embeddings.js';
import { uploadMime } from '../../shared/uploadPolicy.js';
import { uploadError, enqueueResourceJob } from './resourceUploads.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Job = { id: string; resource_id: string; version: number; stage: 'extract' | 'embed'; attempts: number; lease_token: string };
class LeaseLost extends Error {}
const MAX_ATTEMPTS = 3;
export const ACTIVE_PROCESSING_STATES = ['queued', 'running'];

async function assertLease(client: pg.PoolClient, job: Job) {
  // Match deletion/retry lock ordering to avoid resource/job lock inversions.
  const resource = await client.query('SELECT id FROM resources WHERE id=$1 FOR UPDATE', [job.resource_id]);
  if (!resource.rows.length) throw new LeaseLost('Resource no longer exists');
  const { rows } = await client.query(
    `SELECT id FROM resource_processing_jobs WHERE id=$1 AND version=$2 AND lease_token=$3
     AND status='running' AND lease_expires_at > NOW() FOR UPDATE`, [job.id, job.version, job.lease_token],
  );
  if (!rows.length) throw new LeaseLost('Processing lease expired');
}

async function settle(job: Job, state: string, errorCode: string | null = null, error: string | null = null, stage = job.stage, delaySeconds = 0) {
  return transaction(async client => {
    await assertLease(client, job);
    await client.query(
      `UPDATE resource_processing_jobs SET status=$2,stage=$3,error_code=$4,error=$5,
       attempts=CASE WHEN $2='queued' AND $4::text IS NULL THEN 0 ELSE attempts END,
       lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NOW()+($6 * INTERVAL '1 second'),updated_at=NOW()
       WHERE id=$1`, [job.id, state, stage, errorCode, error, delaySeconds],
    );
    if (state === 'queued') await client.query('INSERT INTO resource_outbox (id,job_id,version) VALUES ($1,$2,$3)', [crypto.randomUUID(), job.id, job.version]);
  });
}

export async function reclaimResourceJobs() {
  await query(
    `UPDATE resource_processing_jobs SET status=CASE WHEN attempts >= $1 THEN 'failed' ELSE 'queued' END,
     error_code='worker_interrupted',error='Processing was interrupted. Retrying preserves the original file.',
     lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NOW(),updated_at=NOW()
     WHERE status='running' AND lease_expires_at < NOW()`, [MAX_ATTEMPTS],
  );
}

// One bounded stage/batch per invocation. The durable DB job is authoritative;
// an event is only a wake-up signal and may be duplicated or lost.
export async function processResourceJob(id: string, version?: number): Promise<boolean> {
  const token = crypto.randomUUID();
  const { rows } = await query(
    `UPDATE resource_processing_jobs SET status='running',attempts=attempts+1,lease_token=$2,
       lease_expires_at=NOW()+INTERVAL '6 minutes',updated_at=NOW()
     WHERE id=$1 AND status='queued' AND next_attempt_at<=NOW() AND attempts<$3
       AND ($4::int IS NULL OR version=$4) RETURNING *`, [id, token, MAX_ATTEMPTS, version ?? null],
  );
  const job = rows[0] as unknown as Job | undefined;
  if (!job) return false;
  try {
    const resource = (await query<{
      file_path: string | null; original_name: string | null; mime_type: string | null; file_size: string | null;
    }>('SELECT file_path,original_name,mime_type,file_size FROM resources WHERE id=$1', [job.resource_id])).rows[0];
    if (!resource?.file_path) throw new DocumentError('missing_file', 'The stored original could not be found.');
    if (job.stage === 'extract') {
      const file = await materializeStoredFile(resource.file_path, resource.original_name ?? 'resource.bin');
      try {
        await validateStoredContent(file.path, resource.mime_type!, Number(resource.file_size));
        await transaction(async client => {
          await assertLease(client, job);
          await client.query("UPDATE resources SET file_validation='valid' WHERE id=$1", [job.resource_id]);
        });
        if (resource.mime_type?.startsWith('image/')) {
          await settle(job, 'unsupported', 'ocr_required', 'Image saved. Text search needs OCR, which is not enabled.');
          return true;
        }
        const result = await processResourceChunks(job.resource_id, file.path, resource.mime_type!, {
          enqueueEmbeddings: false, beforeCommit: client => assertLease(client, job),
        });
        if (!result) {
          await settle(job, 'no_text', 'no_text', resource.mime_type === 'application/pdf'
            ? 'No searchable text was found. This PDF may be scanned and need OCR. The original is available.'
            : 'This file contains no indexable text. The original is available.');
        } else await settle(job, 'queued', null, null, 'embed');
      } finally { await file.cleanup(); }
    } else {
      const { rows: chunks } = await query<{ id: string }>(
        `SELECT c.id FROM resource_chunks c WHERE c.resource_id=$1 AND NOT EXISTS
          (SELECT 1 FROM embeddings e WHERE e.entity_type='resource_chunk' AND e.entity_id=c.id
           AND e.embedding_3072 IS NOT NULL AND e.is_stale=false)
         ORDER BY c.chunk_index LIMIT 3`, [job.resource_id],
      );
      for (const chunk of chunks) await embedEntity('resource_chunk', chunk.id, 'full_text', client => assertLease(client, job));
      const { rows: remaining } = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM resource_chunks c WHERE c.resource_id=$1 AND NOT EXISTS
          (SELECT 1 FROM embeddings e WHERE e.entity_type='resource_chunk' AND e.entity_id=c.id
           AND e.embedding_3072 IS NOT NULL AND e.is_stale=false)`, [job.resource_id],
      );
      await settle(job, Number(remaining[0].count) ? 'queued' : 'ready');
    }
  } catch (error) {
    if (error instanceof LeaseLost) return false;
    const permanent = error instanceof DocumentError;
    const code = permanent ? error.code : 'processing_error';
    // Provider responses may contain private URLs or text. Persist a useful,
    // bounded message, never raw provider payloads or signed links.
    const message = permanent ? error.message : (job.stage === 'embed'
      ? 'Search indexing is temporarily unavailable. The original file is preserved.'
      : 'File processing was interrupted or storage is unavailable. The original is preserved.');
    try {
      if (code === 'invalid_file' || code === 'size_mismatch') await transaction(async client => {
        await assertLease(client, job);
        await client.query("UPDATE resources SET file_validation='invalid' WHERE id=$1", [job.resource_id]);
      });
      await settle(job, permanent || job.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', code, message, job.stage, 30 * 2 ** (job.attempts - 1));
    } catch (settleError) { if (!(settleError instanceof LeaseLost)) throw settleError; }
  }
  return true;
}

export async function processPendingResources(limit = 3) {
  await reclaimResourceJobs();
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM resource_processing_jobs WHERE status='queued' AND next_attempt_at<=NOW() ORDER BY next_attempt_at LIMIT $1", [limit],
  );
  for (const { id } of rows) await processResourceJob(id);
  return rows.length;
}

export async function retryResourceProcessing(resourceId: string) {
  // Legacy files acquire metadata lazily without changing their IDs or bytes.
  const resource = (await query('SELECT * FROM resources WHERE id=$1', [resourceId])).rows[0];
  if (!resource) throw uploadError('Resource not found', 404);
  if (!resource.file_path && typeof resource.url === 'string') {
    const name = /^\/api\/resources\/serve\/([a-zA-Z0-9._-]+)$/.exec(resource.url)?.[1];
    if (name) {
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');
      const recovered = path.resolve(root, name);
      if (recovered.startsWith(root + path.sep) && (await fs.stat(recovered).catch(() => null))?.isFile()) {
        await query('UPDATE resources SET file_path=$2 WHERE id=$1 AND file_path IS NULL', [resourceId, recovered]);
        resource.file_path = recovered;
      }
    }
  }
  if (!resource.file_path) throw uploadError('This resource has no stored file', 409);
  if (!resource.original_name || !resource.mime_type || resource.file_size == null) {
    const reference = String(resource.file_path);
    const metadata = isPrivateBlobReference(reference) ? await verifyPrivateBlob(reference) : null;
    const name = metadata?.pathname.split('/').pop() ?? path.basename(reference);
    const size = metadata?.size ?? (await fs.stat(reference)).size;
    const mime = metadata?.contentType ?? uploadMime(name);
    await query('UPDATE resources SET original_name=$2,mime_type=$3,file_size=$4 WHERE id=$1', [resourceId, name, mime ?? 'application/octet-stream', size]);
  }
  return transaction(async client => {
    // Lock resource first, then its job, consistently with deletion.
    const resourceLock = await client.query('SELECT id FROM resources WHERE id=$1 FOR UPDATE', [resourceId]);
    if (!resourceLock.rows.length) throw uploadError('Resource no longer exists', 404);
    const { rows } = await client.query('SELECT * FROM resource_processing_jobs WHERE resource_id=$1 FOR UPDATE', [resourceId]);
    const existing = rows[0];
    if (!existing) return { id: await enqueueResourceJob(client, resourceId), status: 'queued' };
    if (existing.status === 'running' && new Date(existing.lease_expires_at).getTime() > Date.now()) return { id: existing.id, status: 'running' };
    if (existing.status === 'queued') return { id: existing.id, status: 'queued' };
    // Resume a failed embedding stage without repeating successful extraction.
    const stage = existing.stage === 'embed' && existing.status === 'failed' ? 'embed' : 'extract';
    const updated = await client.query<{ version: number }>(
      `UPDATE resource_processing_jobs SET version=version+1,stage=$2,status='queued',attempts=0,error=NULL,error_code=NULL,
       lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING version`, [existing.id, stage],
    );
    await client.query('DELETE FROM resource_outbox WHERE job_id=$1', [existing.id]);
    await client.query('INSERT INTO resource_outbox (id,job_id,version) VALUES ($1,$2,$3)', [crypto.randomUUID(), existing.id, updated.rows[0].version]);
    return { id: existing.id, status: 'queued' };
  });
}

export async function getResourceProcessing(resourceId: string) {
  const { rows } = await query(
    `SELECT r.file_validation,r.original_name,r.mime_type,r.file_size,j.status,j.stage,j.attempts,j.error_code,j.error,j.updated_at,
       (SELECT COUNT(*)::int FROM resource_chunks WHERE resource_id=r.id) AS chunks,
       (SELECT COUNT(*)::int FROM resource_chunks c WHERE c.resource_id=r.id AND EXISTS
         (SELECT 1 FROM embeddings e WHERE e.entity_type='resource_chunk' AND e.entity_id=c.id AND NOT e.is_stale AND e.embedding_3072 IS NOT NULL)) AS embedded
     FROM resources r LEFT JOIN resource_processing_jobs j ON j.resource_id=r.id WHERE r.id=$1`, [resourceId],
  );
  if (!rows.length) throw uploadError('Resource not found', 404);
  const row = rows[0];
  return { ...row, status: row.status ?? (Number(row.chunks) > 0 && row.chunks === row.embedded ? 'ready' : 'not_started') };
}
