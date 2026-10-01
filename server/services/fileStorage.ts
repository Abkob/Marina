import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { del, get, head, issueSignedToken, presignUrl } from '@vercel/blob';
import { isBlobStorageConfigured } from '../runtime.js';

const PRIVATE_BLOB_URL = /^https:\/\/[a-z0-9-]+\.private\.blob\.vercel-storage\.com\//i;

export function isPrivateBlobReference(reference: string | null | undefined): reference is string {
  return Boolean(reference && PRIVATE_BLOB_URL.test(reference));
}

export async function verifyPrivateBlob(reference: string) {
  if (!isBlobStorageConfigured() || !isPrivateBlobReference(reference)) {
    throw Object.assign(new Error('Invalid private Blob reference'), { status: 400 });
  }
  return head(reference, { abortSignal: AbortSignal.timeout(15_000) });
}

export function parseFileRange(range: string | undefined, size: number): { start: number; end: number } | null {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const fail = () => { throw Object.assign(new Error('Requested byte range is not available'), { status: 416 }); };
  if (!match || (!match[1] && !match[2]) || size === 0) return fail();
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return fail();
  return { start, end };
}

type StoredFile = { stream: Readable; contentType: string | null; size: number; etag: string | null; statusCode?: number; contentRange?: string };
export async function openStoredFile(reference: string, rangeHeader?: string): Promise<StoredFile | null> {
  if (isPrivateBlobReference(reference)) {
    if (rangeHeader) {
      const metadata = await verifyPrivateBlob(reference);
      const range = parseFileRange(rangeHeader, metadata.size)!;
      const validUntil = Date.now() + 5 * 60_000;
      const signedToken = await issueSignedToken({ pathname: metadata.pathname, operations: ['get'], validUntil });
      const { presignedUrl } = await presignUrl(signedToken, { pathname: metadata.pathname, operation: 'get', validUntil, access: 'private', useCache: false });
      const response = await fetch(presignedUrl, { headers: { Range: `bytes=${range.start}-${range.end}` }, signal: AbortSignal.timeout(90_000) });
      if (response.status === 404) return null;
      if (![200, 206].includes(response.status) || !response.body) throw new Error('Stored file could not be read');
      if (response.status === 206 && response.headers.get('content-range') !== `bytes ${range.start}-${range.end}/${metadata.size}`) {
        await response.body.cancel();
        throw new Error('Storage returned an unexpected byte range');
      }
      return { stream: Readable.fromWeb(response.body as never), contentType: metadata.contentType,
        size: response.status === 206 ? range.end - range.start + 1 : metadata.size,
        etag: response.headers.get('etag'), statusCode: response.status,
        contentRange: response.status === 206 ? `bytes ${range.start}-${range.end}/${metadata.size}` : undefined };
    }
    const result = await get(reference, { access: 'private', abortSignal: AbortSignal.timeout(90_000) });
    if (!result || result.statusCode !== 200) return null;
    return {
      stream: Readable.fromWeb(result.stream as never),
      contentType: result.blob.contentType,
      size: result.blob.size,
      etag: result.blob.etag,
    };
  }
  if (!fs.existsSync(reference)) return null;
  const size = fs.statSync(reference).size;
  const range = parseFileRange(rangeHeader, size);
  return { stream: fs.createReadStream(reference, range ?? undefined), contentType: null,
    size: range ? range.end - range.start + 1 : size, etag: null, statusCode: range ? 206 : 200,
    contentRange: range ? `bytes ${range.start}-${range.end}/${size}` : undefined };
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
  try {
    await pipeline(opened.stream, fs.createWriteStream(tempPath, { flags: 'wx' }), { signal: AbortSignal.timeout(90_000) });
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => undefined);
    throw error;
  }
  return {
    path: tempPath,
    cleanup: async () => { try { await fsp.unlink(tempPath); } catch { /* best effort */ } },
  };
}
