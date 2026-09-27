import type { PutBlobResult } from '@vercel/blob';
import { upload } from '@vercel/blob/client';
import { apiFetch } from './apiFetch';

type UploadCapabilities = { private_blob: boolean; max_bytes: number };
let capabilitiesPromise: Promise<UploadCapabilities> | null = null;

async function capabilities(): Promise<UploadCapabilities> {
  capabilitiesPromise ??= apiFetch<UploadCapabilities>('/api/uploads/capabilities');
  return capabilitiesPromise;
}

export function normalizedUploadType(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  };
  return types[extension ?? ''] ?? 'application/octet-stream';
}

export async function uploadToPrivateBlob(file: File, kind: 'resource' | 'note'): Promise<PutBlobResult | null> {
  const available = await capabilities();
  if (!available.private_blob) return null;
  if (file.size > available.max_bytes) throw new Error(`File exceeds the ${Math.round(available.max_bytes / 1024 / 1024)} MB limit`);
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180) || 'upload.bin';
  return upload(`marina/${kind}/${crypto.randomUUID()}-${safeName}`, file, {
    access: 'private',
    handleUploadUrl: '/api/uploads/token',
    multipart: file.size > 5 * 1024 * 1024,
    clientPayload: JSON.stringify({ kind, contentType: normalizedUploadType(file), size: file.size }),
  });
}
