import crypto from 'node:crypto';
import type pg from 'pg';
import { createDriveAncestryGuard } from './driveAncestry.js';
import { ensureResourceFolder, resourceFolderPath, type ResourceTarget } from './driveFolders.js';
import { query, transaction } from '../db.js';
import { buildGoogleAuthorizationUrl, googleConfiguration, verifyGoogleOAuthState, encryptGoogleRefreshToken, decryptGoogleRefreshToken, refreshGoogleAccessToken } from './googleWorkspaceAuth.js';
import { assertUploadOpen, commitUpload, enqueueResourceJob, getUploadIntent } from './resourceUploads.js';
import { DRIVE_SCOPES, DRIVE_FOLDER_MIME, DRIVE_CHUNK_BYTES, driveDocument, driveError, driveFileId, driveReference, driveRequest,
  createDriveSession, generateDriveId, getDriveFile, listDriveFiles, openDriveContent, sendDriveChunk, type DriveFile } from './googleDriveClient.js';

type Connection = { account_id: string; account_email: string; encrypted_refresh_token: string | null; folder_id: string | null; scopes: string; last_error: string | null };
const tokenCache = new Map<string, { token: string; expires: number }>();
export async function driveSchemaReady() {
  const row = (await query("SELECT to_regclass('google_drive_connection') AS connection, to_regclass('resource_drive_files') AS files, to_regclass('google_drive_oauth_states') AS states, to_regclass('resource_drive_uploads') AS uploads")).rows[0];
  return Boolean(row?.connection && row.files && row.states && row.uploads);
}
export async function driveConnection(): Promise<Connection | undefined> {
  if (!await driveSchemaReady()) return undefined;
  return (await query<Connection>("SELECT account_id,account_email,encrypted_refresh_token,folder_id,scopes,last_error FROM google_drive_connection WHERE id='primary'")).rows[0];
}
export async function driveStatus() {
  const config = googleConfiguration();
  const connection = await driveConnection();
  return { configured: config.configured, connected: Boolean(connection?.encrypted_refresh_token), account_email: connection?.account_email ?? null,
    folder_url: connection?.folder_id ? `https://drive.google.com/drive/folders/${connection.folder_id}` : null,
    last_error: connection?.last_error ?? null, max_bytes: 50 * 1024 * 1024 };
}
export async function driveToken() {
  const connection = await driveConnection();
  if (!connection?.encrypted_refresh_token) throw driveError('Connect Google Drive in Resource Library first.', 409);
  const key = crypto.createHash('sha256').update(connection.encrypted_refresh_token).digest('hex');
  const cached = tokenCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.token;
  try {
    const token = await refreshGoogleAccessToken(connection.encrypted_refresh_token);
    tokenCache.clear(); tokenCache.set(key, { token, expires: Date.now() + 45 * 60_000 });
    return token;
  } catch {
    const message = 'Google Drive access could not be refreshed. Reconnect the same Google account.';
    await query("UPDATE google_drive_connection SET last_error=$1 WHERE id='primary'", [message]);
    throw driveError(message, 503);
  }
}
export async function createDriveAuthorization(returnTo?: string) {
  if (!await driveSchemaReady()) throw driveError('Drive setup is awaiting the database migration.', 503);
  const url = buildGoogleAuthorizationUrl(returnTo, { scopes: DRIVE_SCOPES, purpose: 'drive' });
  const state = verifyGoogleOAuthState(new URL(url).searchParams.get('state')!);
  await query('DELETE FROM google_drive_oauth_states WHERE expires_at < NOW()');
  await query('INSERT INTO google_drive_oauth_states(nonce,expires_at) VALUES ($1,$2)', [state.nonce, new Date(state.exp)]);
  return url;
}
export async function consumeDriveAuthorization(nonce: string) {
  const { rowCount } = await query('DELETE FROM google_drive_oauth_states WHERE nonce=$1 AND expires_at > NOW() RETURNING nonce', [nonce]);
  if (!rowCount) throw driveError('Google authorization expired or was already used. Connect Drive again.', 400);
}
export async function saveDriveAuthorization(tokens: { access_token: string; refresh_token?: string; scope?: string }) {
  if (!DRIVE_SCOPES.filter(scope => scope.startsWith('https:')).every(scope => tokens.scope?.split(' ').includes(scope))) {
    throw driveError('Approve both Google Drive permissions to upload and import resources.');
  }
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw driveError('Could not verify the connected Google account.', 502);
  const account = await response.json() as { sub?: string; email?: string };
  if (!account.sub || !account.email) throw driveError('Google did not return an account identity.', 502);
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('marina-drive-connection'))");
    const existing = (await client.query<Connection>("SELECT * FROM google_drive_connection WHERE id='primary' FOR UPDATE")).rows[0];
    // Keep file IDs bound to the original account, including after disconnect.
    if (existing && existing.account_id !== account.sub) throw driveError(`Reconnect ${existing.account_email} to preserve access to your Drive resources.`, 409);
    const encrypted = tokens.refresh_token ? encryptGoogleRefreshToken(tokens.refresh_token) : existing?.encrypted_refresh_token;
    if (!encrypted) throw driveError('Google did not grant long-term access. Connect Drive again.');
    await client.query(`INSERT INTO google_drive_connection(id,account_id,account_email,encrypted_refresh_token,scopes)
      VALUES ('primary',$1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET encrypted_refresh_token=$3,scopes=$4,last_error=NULL,updated_at=NOW()`,
    [account.sub, account.email, encrypted, tokens.scope]);
  });
  tokenCache.clear();
}
export async function disconnectDrive() {
  await query("UPDATE google_drive_connection SET encrypted_refresh_token=NULL,updated_at=NOW() WHERE id='primary'");
  tokenCache.clear();
  // Do not revoke the shared Google OAuth grant: Calendar/Tasks may use it too.
}
async function ensureFolder(client: pg.PoolClient, token: string) {
  const connection = (await client.query<Connection>("SELECT * FROM google_drive_connection WHERE id='primary' FOR UPDATE")).rows[0];
  if (!connection?.encrypted_refresh_token) throw driveError('Reconnect Google Drive before uploading.', 409);
  if (connection.folder_id) {
    const folder = await getDriveFile(token, connection.folder_id).catch(error => {
      if (error.status !== 404) throw error;
      return null;
    });
    if (folder && !folder.trashed && folder.mimeType === DRIVE_FOLDER_MIME) return folder.id;
    throw driveError('The saved Marina root folder is unavailable. Restore that folder in Drive before uploading.', 409);
  }
  // A deterministic app-property lookup recovers folder creation after a lost response.
  const found = await (await driveRequest(token, `files?${new URLSearchParams({ q: "trashed=false and mimeType='application/vnd.google-apps.folder' and appProperties has { key='marinaResourceRoot' and value='1' }", fields: 'files(id)', pageSize: '1' })}`)).json() as { files: { id: string }[] };
  let id = found.files[0]?.id;
  if (!id) {
    id = await generateDriveId(token);
    await driveRequest(token, 'files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: 'Marina Resources', mimeType: DRIVE_FOLDER_MIME, appProperties: { marinaResourceRoot: '1' } }) });
  }
  await client.query("UPDATE google_drive_connection SET folder_id=$1,updated_at=NOW() WHERE id='primary'", [id]);
  return id;
}

export async function driveRootGuard(token: string) {
  const root = (await driveConnection())?.folder_id;
  if (!root) throw driveError('The Marina Drive root is not set up. Upload a resource to create it first.', 409);
  return createDriveAncestryGuard(root, id => getDriveFile(token, id));
}
export async function resourceDriveFolder(target: ResourceTarget) {
  const token = await driveToken();
  return transaction(async client => ensureResourceFolder(client, token, await ensureFolder(client, token), target));
}
type DriveUpload = { file_id: string; encrypted_session: string | null };
async function uploadRecord(id: string) {
  return (await query<DriveUpload>('SELECT file_id,encrypted_session FROM resource_drive_uploads WHERE upload_id=$1', [id])).rows[0];
}
export async function prepareDriveUpload(id: string) {
  const intent = await getUploadIntent(id);
  assertUploadOpen(intent);
  if (intent.storage_provider !== 'drive') throw driveError('This upload uses a different storage provider.', 409);
  if (intent.state === 'completed') return { offset: Number(intent.size), complete: true, chunk_bytes: DRIVE_CHUNK_BYTES };
  const token = await driveToken();
  // Reserve the immutable Drive ID before any upload. Never create a duplicate
  // when the provider or database response is lost.
  await transaction(async client => {
    if (!(await client.query('SELECT id FROM resource_uploads WHERE id=$1 FOR UPDATE', [id])).rows.length) throw driveError('Upload no longer exists.', 404);
    if (!(await client.query('SELECT upload_id FROM resource_drive_uploads WHERE upload_id=$1', [id])).rows.length) {
      await client.query('INSERT INTO resource_drive_uploads(upload_id,file_id) VALUES ($1,$2)', [id, await generateDriveId(token)]);
    }
  });
  let record = await uploadRecord(id);
  if (!record) throw driveError('Upload no longer exists.', 404);
  const existing = await getDriveFile(token, record.file_id).catch(error => { if (error.status !== 404) throw error; return null; });
  if (existing) {
    await finalizeDriveUpload(id, existing);
    return { offset: Number(intent.size), complete: true, chunk_bytes: DRIVE_CHUNK_BYTES };
  }
  if (record.encrypted_session) {
    try { return { offset: await sendDriveChunk(token, decryptGoogleRefreshToken(record.encrypted_session), Number(intent.size)), complete: false, chunk_bytes: DRIVE_CHUNK_BYTES }; }
    catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      await query('UPDATE resource_drive_uploads SET encrypted_session=NULL WHERE upload_id=$1 AND encrypted_session=$2', [id, record.encrypted_session]);
    }
  }
  await transaction(async client => {
    const locked = (await client.query<DriveUpload>('SELECT * FROM resource_drive_uploads WHERE upload_id=$1 FOR UPDATE', [id])).rows[0];
    if (!locked) throw driveError('Upload no longer exists.', 404);
    if (locked.encrypted_session) return;
    const folder = await ensureResourceFolder(client, token, await ensureFolder(client, token), intent);
    const session = await createDriveSession(token, locked.file_id, folder.folder_id, { ...intent, size: Number(intent.size) });
    await client.query('UPDATE resource_drive_uploads SET encrypted_session=$2 WHERE upload_id=$1', [id, encryptGoogleRefreshToken(session)]);
  });
  record = await uploadRecord(id);
  if (!record?.encrypted_session) throw driveError('Upload session expired. Resume the upload.', 409);
  return { offset: await sendDriveChunk(token, decryptGoogleRefreshToken(record.encrypted_session!), Number(intent.size)), complete: false, chunk_bytes: DRIVE_CHUNK_BYTES };
}
export async function receiveDriveChunk(id: string, offset: number, bytes: Buffer) {
  const intent = await getUploadIntent(id);
  assertUploadOpen(intent);
  if (intent.storage_provider !== 'drive') throw driveError('This upload uses a different storage provider.', 409);
  if (intent.state === 'completed') return { offset: Number(intent.size), complete: true };
  const record = await uploadRecord(id);
  if (!record?.encrypted_session) throw driveError('Resume the upload before sending another chunk.', 409);
  const next = await sendDriveChunk(await driveToken(), decryptGoogleRefreshToken(record.encrypted_session), Number(intent.size), offset, bytes);
  if (next === Number(intent.size)) await finalizeDriveUpload(id);
  return { offset: next, complete: next === Number(intent.size) };
}
export async function finalizeDriveUpload(id: string, metadata?: DriveFile) {
  const intent = await getUploadIntent(id);
  assertUploadOpen(intent);
  if (intent.storage_provider !== 'drive') throw driveError('This upload uses a different storage provider.', 409);
  if (intent.state === 'completed') return { id, already_saved: true };
  const record = await uploadRecord(id);
  if (!record) throw driveError('File transfer has not completed yet.', 409);
  const file = metadata ?? await getDriveFile(await driveToken(), record.file_id).catch(error => {
    if (error.status === 404) throw driveError('File transfer has not completed yet.', 409); throw error;
  });
  if (file.trashed || file.id !== record.file_id || file.appProperties?.marinaUploadId !== id || file.name !== intent.original_name || file.mimeType !== intent.mime_type) throw driveError('Drive file does not match this upload.', 409);
  await (await driveRootGuard(await driveToken()))(file);
  return commitUpload(id, { reference: driveReference(file.id), size: Number(file.size), contentType: file.mimeType }, false,
    async client => { await saveDriveLink(client, id, file); });
}
async function saveDriveLink(client: pg.PoolClient, resourceId: string, file: DriveFile) {
  await client.query(`INSERT INTO resource_drive_files(resource_id,file_id,source_mime,source_version,source_modified_at)
    VALUES ($1,$2,$3,$4,$5)`, [resourceId, file.id, file.mimeType, file.version, file.modifiedTime ?? null]);
}
export async function browseDrive(search?: string, folder?: string, pageToken?: string) {
  const token = await driveToken();
  const root = (await driveConnection())?.folder_id;
  if (!root) return { files: [], next_page_token: undefined };
  const destination = folder || root;
  const ancestry = await (await driveRootGuard(token))(destination);
  if (ancestry.at(-1)?.mimeType !== DRIVE_FOLDER_MIME) throw driveError('Choose a Drive folder.');
  const result = await listDriveFiles(token, search, destination, pageToken);
  const linked = await query<{ file_id: string; resource_id: string }>('SELECT file_id,resource_id FROM resource_drive_files WHERE file_id=ANY($1)', [result.files.map(file => file.id)]);
  return { next_page_token: result.nextPageToken, files: result.files.map(file => {
    let supported = true; try { if (file.mimeType !== DRIVE_FOLDER_MIME) driveDocument(file); } catch { supported = false; }
    return { id: file.id, name: file.name, mime_type: file.mimeType, size: file.size, folder: file.mimeType === DRIVE_FOLDER_MIME,
      supported, resource_id: linked.rows.find(row => row.file_id === file.id)?.resource_id };
  }) };
}
async function documentSize(token: string, file: DriveFile) {
  if (!driveDocument(file).native) return Number(file.size);
  const opened = await openDriveContent(token, file);
  opened.stream.destroy();
  if (!opened.size) throw driveError('This Drive document exports an empty file.');
  return opened.size;
}
export async function importDriveFile(fileId: string, target: ResourceTarget = {}) {
  const token = await driveToken();
  const file = await getDriveFile(token, fileId);
  const ancestry = await (await driveRootGuard(token))(file);
  // The nearest recognized folder supplies ownership for files added in Drive.
  const owner = [...ancestry].reverse().find(item => ['goal','task'].includes(item.appProperties?.marinaEntityType ?? ''));
  if (owner) target = { attach_to_id: owner.appProperties!.marinaEntityId, attach_to_type: owner.appProperties!.marinaEntityType as 'goal' | 'task' };
  await transaction(client => resourceFolderPath(client, target));
  // The user may select a just-uploaded Drive file before its lost completion
  // response is recovered. Converge on that upload's existing resource ID.
  const uploadId = file.appProperties?.marinaUploadId;
  if (uploadId) {
    const pending = await query<{ id: string }>(`SELECT u.id FROM resource_uploads u JOIN resource_drive_uploads d ON d.upload_id=u.id
      WHERE u.id=$1 AND d.file_id=$2 AND (u.state='completed' OR (u.state='uploading' AND u.expires_at>NOW()))`, [uploadId, file.id]);
    if (pending.rows.length) {
      const saved = await finalizeDriveUpload(pending.rows[0].id, file);
      await transaction(client => linkDirectoryResource(client, saved.id, target));
      return saved;
    }
  }
  const doc = driveDocument(file);
  const size = await documentSize(token, file);
  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`marina-drive-file:${file.id}`]);
    const existing = (await client.query<{ resource_id: string }>('SELECT resource_id FROM resource_drive_files WHERE file_id=$1', [file.id])).rows[0];
    if (existing) {
      await linkDirectoryResource(client, existing.resource_id, target);
      return { id: existing.resource_id, already_saved: true };
    }
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    await client.query(`INSERT INTO resources(id,title,url,type,info,file_path,original_name,mime_type,file_size,file_validation,created_at,updated_at)
      VALUES ($1,$2,$3,'document','',$4,$5,$6,$7,'pending',$8,$8)`, [id, file.name, `/api/resources/blob/${id}`, driveReference(file.id), doc.name, doc.mime, size, now]);
    await saveDriveLink(client, id, file);
    if (target.attach_to_id) await client.query(`INSERT INTO edges(id,source_type,source_id,target_type,target_id,relationship,created_at)
      VALUES ($1,'resource',$2,$3,$4,'attached_to',$5)`, [crypto.randomUUID(), id, target.attach_to_type, target.attach_to_id, now]);
    await enqueueResourceJob(client, id);
    return { id, already_saved: false };
  });
}
/** Directory refresh adds a reference without erasing deliberate links elsewhere. */
async function linkDirectoryResource(client: pg.PoolClient, resourceId: string, target: ResourceTarget) {
  if (!target.attach_to_id) return;
  await resourceFolderPath(client, target);
  await client.query('SELECT id FROM resources WHERE id=$1 FOR UPDATE', [resourceId]);
  await client.query(`INSERT INTO edges(id,source_type,source_id,target_type,target_id,relationship,created_at)
    SELECT $1,'resource',$2,$3,$4,'attached_to',$5 WHERE NOT EXISTS
    (SELECT 1 FROM edges WHERE source_type='resource' AND source_id=$2 AND target_type=$3 AND target_id=$4 AND relationship='attached_to')`,
    [crypto.randomUUID(), resourceId, target.attach_to_type, target.attach_to_id, new Date().toISOString()]);
}
export async function openDriveStoredFile(reference: string, rangeHeader?: string) {
  const token = await driveToken();
  const file = await getDriveFile(token, driveFileId(reference));
  await (await driveRootGuard(token))(file);
  const doc = driveDocument(file);
  // Native exports have no stable byte size until exported; return the whole
  // bounded PDF with HTTP 200 instead of inventing a byte range.
  const { parseFileRange } = await import('./fileStorage.js');
  const range = !doc.native ? parseFileRange(rangeHeader, Number(file.size)) : null;
  return openDriveContent(token, file, range ?? undefined);
}

async function invalidateDriveIndex(client: pg.PoolClient, resourceId: string) {
  await client.query("UPDATE embeddings SET is_stale=true WHERE (entity_type='resource' AND entity_id=$1) OR (entity_type='resource_chunk' AND entity_id IN (SELECT id FROM resource_chunks WHERE resource_id=$1))", [resourceId]);
}
export async function syncDriveResource(resourceId: string) {
  const link = (await query<{ file_id: string; source_version: string; available: boolean }>(
    "SELECT d.file_id,d.source_version,d.available FROM resource_drive_files d JOIN resources r ON r.id=d.resource_id WHERE d.resource_id=$1 AND r.file_path LIKE 'gdrive://%'", [resourceId])).rows[0];
  if (!link) return;
  let file: DriveFile; let size: number; let doc: ReturnType<typeof driveDocument>;
  try {
    const token = await driveToken(); file = await getDriveFile(token, link.file_id);
    await (await driveRootGuard(token))(file); doc = driveDocument(file);
    if (file.version === link.source_version && link.available) {
      await query('UPDATE resource_drive_files SET checked_at=NOW(),last_error=NULL WHERE resource_id=$1', [resourceId]); return;
    }
    size = await documentSize(token, file);
  } catch (error) {
    const status = (error as { status?: number }).status;
    const unavailable = status === 404 || status === 403 || status === 400;
    await transaction(async client => {
      await client.query('SELECT id FROM resources WHERE id=$1 FOR UPDATE', [resourceId]);
      await client.query('UPDATE resource_drive_files SET checked_at=NOW(),available=CASE WHEN $2 THEN false ELSE available END,last_error=$3 WHERE resource_id=$1',
        [resourceId, unavailable, unavailable ? 'Source unavailable or unsupported in Google Drive. Check access and retry sync.' : 'Drive could not be checked. Retry sync shortly.']);
      if (unavailable) {
        await invalidateDriveIndex(client, resourceId);
        await client.query("UPDATE resource_processing_jobs SET version=version+1,status='failed',error_code='drive_unavailable',error='Source unavailable in Google Drive. Restore access, then sync.',lease_token=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE resource_id=$1", [resourceId]);
      }
    });
    if (!unavailable) throw error;
    return;
  }
  await transaction(async client => {
    if (!(await client.query('SELECT id FROM resources WHERE id=$1 FOR UPDATE', [resourceId])).rows.length) return;
    const current = (await client.query<{ source_version: string; available: boolean }>('SELECT source_version,available FROM resource_drive_files WHERE resource_id=$1 FOR UPDATE', [resourceId])).rows[0];
    if (!current || (current.source_version === file.version && current.available)) return;
    // A slower concurrent metadata request must never roll the index backward.
    if (/^\d+$/.test(file.version) && /^\d+$/.test(current.source_version) && BigInt(file.version) < BigInt(current.source_version)) return;
    await client.query('UPDATE resource_drive_files SET source_version=$2,source_modified_at=$3,source_mime=$4,available=true,last_error=NULL,checked_at=NOW() WHERE resource_id=$1', [resourceId, file.version, file.modifiedTime ?? null, file.mimeType]);
    await client.query("UPDATE resources SET original_name=$2,mime_type=$3,file_size=$4,file_validation='pending',updated_at=$5 WHERE id=$1", [resourceId, doc.name, doc.mime, size, new Date().toISOString()]);
    await invalidateDriveIndex(client, resourceId);
    const job = (await client.query<{ id: string; version: number }>(`UPDATE resource_processing_jobs SET version=version+1,status='queued',stage='extract',attempts=0,error=NULL,error_code=NULL,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NOW(),updated_at=NOW() WHERE resource_id=$1 RETURNING id,version`, [resourceId])).rows[0];
    if (!job) await enqueueResourceJob(client, resourceId);
    else {
      await client.query('DELETE FROM resource_outbox WHERE job_id=$1', [job.id]);
      await client.query('INSERT INTO resource_outbox(id,job_id,version) VALUES ($1,$2,$3)', [crypto.randomUUID(), job.id, job.version]);
    }
  });
}
export async function reconcileDriveResources(limit = 10, force = false) {
  if (!await driveSchemaReady() || !(await driveConnection())?.encrypted_refresh_token) return 0;
  const { rows } = await query<{ resource_id: string }>(`SELECT d.resource_id FROM resource_drive_files d JOIN resources r ON r.id=d.resource_id
    WHERE r.file_path LIKE 'gdrive://%' AND ($2::boolean OR d.checked_at < NOW()-INTERVAL '2 minutes') ORDER BY d.checked_at LIMIT $1`, [limit, force]);
  let checked = 0; let failed = 0;
  for (const row of rows) {
    try { await syncDriveResource(row.resource_id); checked++; }
    catch { failed++; } // Per-file errors are persisted; other jobs must still run.
  }
  if (rows.length) await query("UPDATE google_drive_connection SET last_error=$1 WHERE id='primary'",
    [failed ? `${failed} Drive source checks failed. Saved files and previous indexes are preserved; retry sync shortly.` : null]);
  return checked;
}
