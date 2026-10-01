import type { PutBlobResult } from '@vercel/blob';
import { upload } from '@vercel/blob/client';
import { apiFetch, ApiError } from './apiFetch';
import { MAX_UPLOAD_BYTES, uploadMime, validateUploadMetadata } from '../../shared/uploadPolicy';
export { MAX_UPLOAD_BYTES, UPLOAD_ACCEPT } from '../../shared/uploadPolicy';

export type UploadProgress = { phase: 'preparing' | 'uploading' | 'saving'; percentage?: number };
export type UploadProgressListener = (progress: UploadProgress) => void;

type UploadCapabilities = { private_blob: boolean; max_bytes: number; local_uploads?: boolean };
let capabilitiesPromise: Promise<UploadCapabilities> | null = null;

async function capabilities(): Promise<UploadCapabilities> {
  capabilitiesPromise ??= apiFetch<UploadCapabilities>('/api/uploads/capabilities', {
    signal: AbortSignal.timeout(30_000),
  }).catch(error => {
    // A temporary connection/authentication failure must not poison every retry.
    capabilitiesPromise = null;
    throw error;
  });
  return capabilitiesPromise;
}

export function normalizedUploadType(file: File): string {
  // Windows can label CSV as Excel, and phones sometimes omit the MIME type.
  // The server still checks file signatures for binary formats.
  return uploadMime(file.name) ?? file.type ?? 'application/octet-stream';
}

export function validateUploadFile(file: File, maxBytes = MAX_UPLOAD_BYTES): void {
  if (!file.size) throw new Error('This file is empty. Choose a file with content.');
  if (file.size > maxBytes) throw new Error(`File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit. Choose a smaller file.`);
  validateUploadMetadata(file.name, file.size);
}

export async function uploadToPrivateBlob(file: File, kind: 'resource' | 'note', onProgress?: UploadProgressListener,
  intent?: { id: string; pathname: string }): Promise<PutBlobResult | null> {
  validateUploadFile(file);
  onProgress?.({ phase: 'preparing' });
  const available = await capabilities();
  validateUploadFile(file, available.max_bytes);
  if (!available.private_blob) {
    if (available.local_uploads === false) { capabilitiesPromise = null; throw new Error('Cloud file storage is unavailable. Please try again later.'); }
    return null;
  }
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180) || 'upload.bin';
  const contentType = normalizedUploadType(file);
  onProgress?.({ phase: 'uploading', percentage: 0 });
  return upload(intent?.pathname ?? `marina/${kind}/${crypto.randomUUID()}-${safeName}`, file, {
    access: 'private',
    contentType,
    handleUploadUrl: '/api/uploads/token',
    multipart: file.size > 5 * 1024 * 1024,
    abortSignal: AbortSignal.timeout(10 * 60_000),
    onUploadProgress: ({ percentage }) => onProgress?.({ phase: 'uploading', percentage }),
    clientPayload: JSON.stringify({ kind, contentType, size: file.size, ...(intent ? { uploadId: intent.id } : {}) }),
  });
}

type ResourceIntent = { id: string; pathname: string; state: string };
type UploadSession = { requestKey: string; intent?: ResourceIntent; transferred?: boolean; pending?: Promise<string> };
const resourceSessions = new WeakMap<File, Map<string, UploadSession>>();

// Reuse the same intent after a lost response. File object identity scopes this
// to one picker selection; deliberately selecting another file starts a new intent.
export function uploadResourceDocument(file: File, onProgress?: UploadProgressListener,
  attachment?: { attach_to_id: string; attach_to_type: 'task' | 'goal' }): Promise<string> {
  let sessions = resourceSessions.get(file);
  if (!sessions) { sessions = new Map(); resourceSessions.set(file, sessions); }
  const key = JSON.stringify(attachment ?? null);
  let session = sessions.get(key);
  if (!session) { session = { requestKey: crypto.randomUUID() }; sessions.set(key, session); }
  if (session.pending) return session.pending;
  session.pending = performResourceUpload(file, session, onProgress, attachment).finally(() => { session!.pending = undefined; });
  return session.pending;
}

async function performResourceUpload(file: File, session: UploadSession, onProgress?: UploadProgressListener,
  attachment?: { attach_to_id: string; attach_to_type: 'task' | 'goal' }): Promise<string> {
  validateUploadFile(file);
  onProgress?.({ phase: 'preparing' });
  const available = await capabilities();
  validateUploadFile(file, available.max_bytes);
  if (!available.private_blob && available.local_uploads === false) { capabilitiesPromise = null; throw new Error('Cloud file storage is unavailable. Please try again later.'); }
  const post = <T>(url: string, body: unknown) => apiFetch<T>(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  session.intent = session.intent
    ? await apiFetch<ResourceIntent>(`/api/uploads/resources/${session.intent.id}`, { signal: AbortSignal.timeout(30_000) })
    : await post<ResourceIntent>('/api/uploads/resources', {
      request_key: session.requestKey, original_name: file.name, mime_type: normalizedUploadType(file), size: file.size, ...attachment,
    });
  const intent = session.intent;
  if (intent.state === 'completed') return intent.id;
  const complete = async () => {
    onProgress?.({ phase: 'saving' });
    const result = await post<{ id: string }>(`/api/uploads/resources/${intent.id}/complete`, {});
    return result.id;
  };
  if (available.private_blob) {
    // A previous transfer may have succeeded even if its response was lost.
    if (session.transferred) return complete();
    try {
      await uploadToPrivateBlob(file, 'resource', onProgress, intent);
      session.transferred = true;
    } catch (transferError) {
      // Blob may already exist after a network interruption/duplicate transfer.
      // HEAD + idempotent completion checks receipt without creating another file.
      try { return await complete(); }
      catch (completionError) {
        if (completionError instanceof ApiError && completionError.status === 409) throw transferError;
        throw completionError;
      }
    }
    return complete();
  }
  const form = new FormData();
  form.append('upload_id', intent.id);
  form.append('file', new Blob([file], { type: normalizedUploadType(file) }), file.name);
  onProgress?.({ phase: 'uploading' });
  const result = await apiFetch<{ id: string }>('/api/resources/upload', { method: 'POST', body: form, signal: AbortSignal.timeout(10 * 60_000) });
  return result.id;
}
