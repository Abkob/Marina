import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { del, get, head } from '@vercel/blob';
import { isBlobStorageConfigured } from '../runtime.js';

const PRIVATE_BLOB_URL = /^https:\/\/[a-z0-9-]+\.private\.blob\.vercel-storage\.com\//i;

export function isPrivateBlobReference(reference: string | null | undefined): reference is string {
  return Boolean(reference && PRIVATE_BLOB_URL.test(reference));
}

export async function verifyPrivateBlob(reference: string) {
  if (!isBlobStorageConfigured() || !isPrivateBlobReference(reference)) {
    throw Object.assign(new Error('Invalid private Blob reference'), { status: 400 });
  }
  return head(reference);
}

export async function openStoredFile(reference: string) {
  if (isPrivateBlobReference(reference)) {
    const result = await get(reference, { access: 'private' });
    if (!result || result.statusCode !== 200) return null;
    return {
      stream: Readable.fromWeb(result.stream as never),
      contentType: result.blob.contentType,
      size: result.blob.size,
      etag: result.blob.etag,
    };
  }
  if (!fs.existsSync(reference)) return null;
  return { stream: fs.createReadStream(reference), contentType: null, size: fs.statSync(reference).size, etag: null };
}

export async function deleteStoredFile(reference: string | null | undefined): Promise<void> {
  if (!reference) return;
  if (isPrivateBlobReference(reference)) {
    if (isBlobStorageConfigured()) await del(reference);
    return;
  }
  try { await fsp.unlink(reference); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export async function materializeStoredFile(reference: string, originalName = 'upload.bin') {
  if (!isPrivateBlobReference(reference)) {
    return { path: reference, cleanup: async () => undefined };
  }
  const opened = await openStoredFile(reference);
  if (!opened) throw Object.assign(new Error('Stored file not found'), { status: 404 });
  const safeExtension = path.extname(originalName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
  const tempDir = path.join(os.tmpdir(), 'marina-materialized');
  await fsp.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `${crypto.randomUUID()}${safeExtension}`);
  await pipeline(opened.stream, fs.createWriteStream(tempPath, { flags: 'wx' }));
  return {
    path: tempPath,
    cleanup: async () => { try { await fsp.unlink(tempPath); } catch { /* best effort */ } },
  };
}
