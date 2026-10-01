import crypto from 'node:crypto';
import path from 'node:path';
import type pg from 'pg';
import { head } from '@vercel/blob';
import { query, transaction } from '../db.js';
import { isBlobStorageConfigured } from '../runtime.js';
import { validateUploadMetadata } from '../../shared/uploadPolicy.js';
import { isPrivateBlobReference } from './fileStorage.js';

export type UploadIntentInput = {
  request_key: string; original_name: string; mime_type: string; size: number;
  attach_to_id?: string; attach_to_type?: 'task' | 'goal';
};
export type UploadIntent = UploadIntentInput & {
  id: string; pathname: string; state: 'uploading' | 'completed' | 'expired' | 'deleted';
  expires_at: Date; size: number;
};
export const uploadError = (message: string, status = 400) => Object.assign(new Error(message), { status });

async function checkTarget(client: Pick<pg.PoolClient, 'query'>, input: UploadIntentInput, allowMissing = false): Promise<boolean> {
  if (Boolean(input.attach_to_id) !== Boolean(input.attach_to_type)) throw uploadError('Provide both attachment ID and type');
  if (!input.attach_to_id) return true;
  if (!['task', 'goal'].includes(input.attach_to_type!)) throw uploadError('Invalid attachment type');
  const table = input.attach_to_type === 'task' ? 'tasks' : 'goals';
  const { rows } = await client.query(`SELECT id FROM ${table} WHERE id=$1 FOR KEY SHARE`, [input.attach_to_id]);
  if (!rows.length && !allowMissing) throw uploadError('Attachment target no longer exists');
  return rows.length > 0;
}

export async function createUploadIntent(input: UploadIntentInput, legacyPath?: string): Promise<UploadIntent> {
  try { validateUploadMetadata(input.original_name, input.size, input.mime_type); }
  catch (err) { throw uploadError((err as Error).message); }
  if (!input.request_key || input.request_key.length > 200) throw uploadError('Invalid upload request key');
  return transaction(async client => {
    const id = crypto.randomUUID();
    const pathname = legacyPath ?? `marina/resource/${id}${path.extname(input.original_name).toLowerCase()}`;
    const { rows } = await client.query<UploadIntent>(
      `INSERT INTO resource_uploads (id,request_key,pathname,original_name,mime_type,size,attach_to_id,attach_to_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (request_key) DO UPDATE SET request_key=EXCLUDED.request_key RETURNING *`,
      [id, input.request_key, pathname, input.original_name, input.mime_type, input.size, input.attach_to_id ?? null, input.attach_to_type ?? null],
    );
    const intent = rows[0];
    if (intent.original_name !== input.original_name || intent.mime_type !== input.mime_type || Number(intent.size) !== input.size
      || (intent.attach_to_id ?? null) !== (input.attach_to_id ?? null) || (intent.attach_to_type ?? null) !== (input.attach_to_type ?? null)
      || (legacyPath && intent.pathname !== legacyPath)) throw uploadError('Upload request key was already used for a different file', 409);
    if (intent.id === id) await checkTarget(client, input);
    return intent;
  });
}

export async function getUploadIntent(id: string): Promise<UploadIntent> {
  const { rows } = await query('SELECT * FROM resource_uploads WHERE id=$1', [id]);
  if (!rows.length) throw uploadError('Upload not found', 404);
  return rows[0] as unknown as UploadIntent;
}

export function assertUploadOpen(intent: UploadIntent) {
  if (intent.state === 'deleted') throw uploadError('This resource was deleted', 410);
  if (intent.state === 'expired' || (intent.state !== 'completed' && new Date(intent.expires_at).getTime() <= Date.now())) {
    throw uploadError('Upload has expired. Select the file again.', 410);
  }
}

export async function enqueueResourceJob(client: pg.PoolClient, resourceId: string): Promise<string> {
  const id = crypto.randomUUID();
  const { rows } = await client.query<{ id: string; version: number }>(
    `INSERT INTO resource_processing_jobs (id,resource_id) VALUES ($1,$2)
     ON CONFLICT (resource_id) DO UPDATE SET resource_id=EXCLUDED.resource_id RETURNING id,version`, [id, resourceId],
  );
  await client.query('INSERT INTO resource_outbox (id,job_id,version) VALUES ($1,$2,$3)', [crypto.randomUUID(), rows[0].id, rows[0].version]);
  return rows[0].id;
}

// Only trusted storage metadata enters this transaction. No object is deleted on
// failure: the intent makes the uploaded bytes recoverable and safe to retry.
async function commitUpload(id: string, stored: { reference: string; pathname?: string; size: number; contentType: string }, localValidated = false) {
  return transaction(async client => {
    const { rows } = await client.query<UploadIntent>('SELECT * FROM resource_uploads WHERE id=$1 FOR UPDATE', [id]);
    const intent = rows[0];
    if (!intent) throw uploadError('Upload not found', 404);
    assertUploadOpen(intent);
    if (intent.state === 'completed') return { id: intent.id, already_saved: true };
    if ((stored.pathname && stored.pathname !== intent.pathname) || Number(intent.size) !== stored.size || intent.mime_type !== stored.contentType) {
      throw uploadError('Stored file metadata does not match the upload');
    }
    // If the user deleted the target while bytes were in flight, keep the file
    // in the library and explain the missing attachment. SQL write failures
    // still roll back the entire transaction and remain safely retryable.
    const targetExists = await checkTarget(client, intent, true);
    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO resources (id,title,url,type,info,file_path,original_name,mime_type,file_size,file_validation,created_at,updated_at)
       VALUES ($1,$2,$3,'document',$10,$4,$5,$6,$7,$8,$9,$9)`,
      [id, path.basename(intent.original_name, path.extname(intent.original_name)), `/api/resources/blob/${id}`, stored.reference,
        intent.original_name, intent.mime_type, stored.size, localValidated ? 'valid' : 'pending', now,
        targetExists ? '' : 'The original attachment target was removed. This file is saved in your library.'],
    );
    if (intent.attach_to_id && targetExists) await client.query(
      `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
       VALUES ($1,$2,'resource',$3,$4,'attached_to',NULL,$5)`,
      [crypto.randomUUID(), id, intent.attach_to_id, intent.attach_to_type, now],
    );
    await enqueueResourceJob(client, id);
    await client.query("UPDATE resource_uploads SET state='completed',completed_at=NOW() WHERE id=$1", [id]);
    return { id, already_saved: false };
  });
}

export async function finalizeBlobUpload(id: string, supplied?: { url: string; pathname: string }) {
  const intent = await getUploadIntent(id);
  assertUploadOpen(intent);
  if (supplied && supplied.pathname !== intent.pathname) throw uploadError('Upload path does not match');
  // Retry of a lost success response needs neither another transfer nor HEAD.
  if (intent.state === 'completed') return { id, already_saved: true };
  if (!isBlobStorageConfigured()) throw uploadError('Cloud file storage is unavailable', 503);
  let metadata;
  try { metadata = await head(intent.pathname, { abortSignal: AbortSignal.timeout(15_000) }); }
  catch (error) {
    if ((error as Error).name === 'BlobNotFoundError') throw uploadError('File transfer has not completed yet', 409);
    throw error;
  }
  if (!isPrivateBlobReference(metadata.url) || (supplied && supplied.url !== metadata.url)) throw uploadError('Upload object does not match');
  return commitUpload(id, { reference: metadata.url, pathname: metadata.pathname, size: metadata.size, contentType: metadata.contentType });
}

export async function finalizeLocalUpload(id: string, file: { path: string; size: number; mimetype: string }) {
  return commitUpload(id, { reference: file.path, size: file.size, contentType: file.mimetype }, true);
}

// Compatibility for a browser tab opened before the deployment. Use the
// immutable path as the deduplication key, and keep the same transaction rules.
export async function registerLegacyBlob(input: Omit<UploadIntentInput, 'request_key'> & { blob: { url: string; pathname: string } }) {
  if (!input.blob.pathname.startsWith('marina/resource/') || input.blob.pathname.includes('..') || !isPrivateBlobReference(input.blob.url)) {
    throw uploadError('Invalid resource upload path');
  }
  // Preserve pre-existing IDs if an older request already committed this Blob.
  const existing = await query<{ id: string }>('SELECT id FROM resources WHERE file_path=$1 ORDER BY created_at LIMIT 1', [input.blob.url]);
  if (existing.rows.length) return { id: existing.rows[0].id, already_saved: true };
  const request_key = `legacy:${crypto.createHash('sha256').update(input.blob.pathname).digest('hex')}`;
  const intent = await createUploadIntent({ ...input, request_key }, input.blob.pathname);
  return finalizeBlobUpload(intent.id, input.blob);
}

export async function reconcileUploads(limit = 10): Promise<number> {
  if (!isBlobStorageConfigured()) return 0;
  // No deletion: expired intents retain their identity for inspection/recovery.
  const { rows } = await query<{ id: string }>(
    `WITH candidates AS (SELECT id FROM resource_uploads WHERE state='uploading'
       AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '5 minutes')
       ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE resource_uploads u SET last_checked_at=NOW() FROM candidates c WHERE u.id=c.id RETURNING u.id`, [limit],
  );
  let recovered = 0;
  for (const { id } of rows) {
    try { await finalizeBlobUpload(id); recovered++; }
    catch (error) {
      if ((error as { status?: number }).status === 410) {
        await query("UPDATE resource_uploads SET state='expired' WHERE id=$1 AND state='uploading'", [id]);
      } else if ((error as { status?: number }).status !== 409) {
        console.warn('[resource-upload] reconciliation failed', { uploadId: id, error: (error as Error).name });
      }
    }
  }
  return recovered;
}
