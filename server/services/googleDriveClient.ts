import { Readable } from 'node:stream';
import { MAX_UPLOAD_BYTES, uploadMime, validateUploadMetadata } from '../../shared/uploadPolicy.js';

const API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_CHUNK_BYTES = 2 * 1024 * 1024;
export const DRIVE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.readonly'];
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DRIVE_NATIVE_TYPES = new Set(['application/vnd.google-apps.document', 'application/vnd.google-apps.spreadsheet', 'application/vnd.google-apps.presentation']);
export type DriveFile = { id: string; name: string; mimeType: string; size?: string; version: string; modifiedTime?: string; trashed?: boolean; parents?: string[]; appProperties?: Record<string,string>; capabilities?: { canDownload?: boolean }; };
const FIELDS = 'id,name,mimeType,size,version,modifiedTime,trashed,parents,appProperties,capabilities(canDownload)';
export const driveError = (message: string, status = 400) => Object.assign(new Error(message), { status });
export function validateDriveId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw driveError('Invalid Drive file ID');
  return id;
}
export function driveReference(id: string) { return `gdrive://${validateDriveId(id)}`; }
export function driveFileId(reference: string) {
  const match = /^gdrive:\/\/([a-zA-Z0-9_-]{1,200})$/.exec(reference);
  if (!match) throw driveError('Invalid Drive reference');
  return match[1];
}
export function isDriveReference(reference: string | null | undefined): reference is string { return Boolean(reference?.startsWith('gdrive://')); }
export function driveDocument(file: DriveFile) {
  if (file.trashed) throw driveError('This file is in the Drive trash. Restore it in Drive to use it.', 404);
  if (file.capabilities?.canDownload === false) throw driveError('This Drive file cannot be downloaded with the connected account.', 403);
  if (DRIVE_NATIVE_TYPES.has(file.mimeType)) return { name: `${file.name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 245)}.pdf`, mime: 'application/pdf', native: true };
  const mime = uploadMime(file.name);
  try { validateUploadMetadata(file.name, Number(file.size), mime); }
  catch (error) { throw driveError(error instanceof Error ? error.message : 'Unsupported Drive document.', 400); }
  return { name: file.name, mime: mime!, native: false };
}
// Treat provider errors as data. Do not persist Google payloads, tokens, or session URLs.
export async function checkDriveResponse(response: Response) {
  if (response.ok || response.status === 308) return response;
  const body = await response.json().catch(() => ({})) as { error?: { errors?: { reason?: string }[] } };
  const reasons = body.error?.errors?.map(error => error.reason) ?? [];
  if (reasons.includes('storageQuotaExceeded')) throw driveError('Your Google Drive storage is full. Free space in Drive and retry.', 507);
  if (reasons.includes('exportSizeLimitExceeded')) throw driveError('Google cannot export this document because it exceeds its export limit. Upload a PDF copy instead.', 400);
  if (response.status === 401) throw driveError('Google Drive access expired. Reconnect the same Google account.', 401);
  if (response.status === 404 || response.status === 410) throw driveError('Drive file or upload session is no longer available.', 404);
  if (response.status === 429 || response.status >= 500 || reasons.some(reason => /rateLimit|dailyLimit/i.test(reason))) {
    throw driveError('Google Drive is temporarily busy. Retry shortly; saved files are preserved.', 503);
  }
  if (response.status === 403) throw driveError('Google Drive denied access. Check file permissions, enable the Drive API, or reconnect your account.', 403);
  throw driveError('Google Drive could not complete this request. Retry or reconnect your account.', 502);
}
export async function driveRequest(token: string, route: string, init: RequestInit = {}) {
  const response = await fetch(`${API}/${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers },
    redirect: 'error', signal: AbortSignal.timeout(45_000) });
  return checkDriveResponse(response);
}
export async function getDriveFile(token: string, id: string): Promise<DriveFile> {
  return (await driveRequest(token, `files/${validateDriveId(id)}?supportsAllDrives=true&fields=${encodeURIComponent(FIELDS)}`)).json();
}
export async function generateDriveId(token: string): Promise<string> {
  const body = await (await driveRequest(token, 'files/generateIds?count=1&space=drive&type=files')).json() as { ids?: string[] };
  return validateDriveId(body.ids?.[0] ?? '');
}
export function driveListQuery(search = '', folder?: string) {
  const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const clauses = ['trashed = false'];
  if (folder) clauses.push(`'${validateDriveId(folder)}' in parents`);
  if (search.trim()) clauses.push(`name contains '${escape(search.trim().slice(0, 200))}'`);
  return clauses.join(' and ');
}
export async function listDriveFiles(token: string, search = '', folder?: string, pageToken?: string, pageSize = 50) {
  const params = new URLSearchParams({ q: driveListQuery(search, folder), pageSize: String(Math.max(1, Math.min(50, pageSize))), orderBy: 'folder,name',
    fields: `nextPageToken,files(${FIELDS})`, supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
  if (pageToken) params.set('pageToken', pageToken);
  return (await driveRequest(token, `files?${params}`)).json() as Promise<{ files: DriveFile[]; nextPageToken?: string }>;
}
export function validateSessionUrl(value: string) {
  const url = new URL(value);
  if (url.origin !== 'https://www.googleapis.com' || url.pathname !== '/upload/drive/v3/files' || !url.searchParams.get('upload_id') || url.username || url.password) {
    throw driveError('Invalid Google upload session', 502);
  }
  return value;
}
export async function createDriveSession(token: string, fileId: string, folderId: string, intent: { id: string; original_name: string; mime_type: string; size: number }) {
  const response = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-Upload-Content-Type': intent.mime_type, 'X-Upload-Content-Length': String(intent.size) },
    body: JSON.stringify({ id: validateDriveId(fileId), name: intent.original_name, mimeType: intent.mime_type,
      parents: [validateDriveId(folderId)], appProperties: { marinaUploadId: intent.id } }),
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  await checkDriveResponse(response);
  return validateSessionUrl(response.headers.get('location') ?? '');
}
export function receivedOffset(response: Response, total: number) {
  if (response.ok) return total;
  const range = response.headers.get('range');
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw driveError('Drive returned an invalid upload position.', 502);
  return offset;
}
export async function sendDriveChunk(token: string, session: string, total: number, offset?: number, bytes?: Buffer) {
  if (bytes && (!Number.isSafeInteger(offset) || offset! < 0 || !bytes.length || bytes.length > DRIVE_CHUNK_BYTES || offset! + bytes.length > total
    || (offset! + bytes.length < total && bytes.length % (256 * 1024) !== 0))) throw driveError('Invalid upload chunk');
  const response = await fetch(validateSessionUrl(session), { method: 'PUT', redirect: 'manual',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes?.length ?? 0), 'Content-Range': bytes ? `bytes ${offset}-${offset! + bytes.length - 1}/${total}` : `bytes */${total}` },
    body: bytes ? new Uint8Array(bytes) : undefined, signal: AbortSignal.timeout(60_000) });
  await checkDriveResponse(response);
  const next = receivedOffset(response, total);
  await response.body?.cancel();
  return next;
}
export async function openDriveContent(token: string, file: DriveFile, range?: { start: number; end: number }) {
  const doc = driveDocument(file);
  const route = doc.native ? `files/${file.id}/export?mimeType=application%2Fpdf`
    : `files/${file.id}?alt=media&supportsAllDrives=true`;
  const response = await driveRequest(token, route, { headers: !doc.native && range ? { Range: `bytes=${range.start}-${range.end}` } : {} });
  if (!response.body) throw driveError('Drive returned an empty file response.', 502);
  if (doc.native) {
    // Google exports are bounded independently of the source document's size.
    const parts: Uint8Array[] = []; let size = 0;
    for await (const part of Readable.fromWeb(response.body as never)) {
      size += part.length;
      if (size > MAX_UPLOAD_BYTES) throw driveError('Export exceeds the 50 MB resource limit.', 413);
      parts.push(part);
    }
    const bytes = Buffer.concat(parts);
    return { stream: Readable.from(range ? bytes.subarray(range.start, range.end + 1) : bytes), size: range ? range.end - range.start + 1 : size,
      contentType: doc.mime, etag: `"drive-${file.version}"`, statusCode: range ? 206 : 200,
      contentRange: range ? `bytes ${range.start}-${range.end}/${size}` : undefined };
  }
  const expectedRange = range ? `bytes ${range.start}-${range.end}/${file.size}` : undefined;
  if (range && response.status === 206 && response.headers.get('content-range') !== expectedRange) {
    await response.body.cancel(); throw driveError('Drive returned an unexpected byte range.', 502);
  }
  return { stream: Readable.fromWeb(response.body as never), size: response.status === 206 && range ? range.end - range.start + 1 : Number(file.size),
    contentType: doc.mime, etag: `"drive-${file.version}"`, statusCode: response.status,
    contentRange: response.status === 206 ? expectedRange : undefined };
}
