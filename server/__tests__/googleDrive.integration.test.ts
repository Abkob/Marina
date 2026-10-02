import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { baseUrl, SKIP_INTEGRATION, startTestServer, stopTestServer } from './setup.js';
import { query } from '../db.js';
import { createUploadIntent, finalizeBlobUpload, reconcileUploads } from '../services/resourceUploads.js';
import { consumeDriveAuthorization, createDriveAuthorization, disconnectDrive, finalizeDriveUpload, importDriveFile, prepareDriveUpload, receiveDriveChunk, reconcileDriveResources, syncDriveResource } from '../services/googleDrive.js';
import { encryptGoogleRefreshToken, verifyGoogleOAuthState } from '../services/googleWorkspaceAuth.js';
import { getResourceProcessing, processResourceJob } from '../services/resourceProcessing.js';
import { searchDocuments } from '../services/documentRag.js';
import { deleteStoredFile } from '../services/fileStorage.js';

const mocks = vi.hoisted(() => ({ get: vi.fn(), request: vi.fn(), generate: vi.fn(), session: vi.fn(), chunk: vi.fn(), open: vi.fn(), refresh: vi.fn(), embed: vi.fn(), embedQuery: vi.fn() }));
vi.mock('../services/googleDriveClient.js', async original => ({ ...await original<typeof import('../services/googleDriveClient.js')>(),
  getDriveFile: (token: string, id: string) => id === 'folder' ? Promise.resolve({id, name:'Marina',version:'1',mimeType:'application/vnd.google-apps.folder'}) : mocks.get(token,id), driveRequest: mocks.request,
  generateDriveId: mocks.generate, createDriveSession: mocks.session, sendDriveChunk: mocks.chunk, openDriveContent: mocks.open }));
vi.mock('../services/googleWorkspaceAuth.js', async original => ({ ...await original<typeof import('../services/googleWorkspaceAuth.js')>(), refreshGoogleAccessToken: mocks.refresh }));
vi.mock('../embeddingProvider.js', async original => ({ ...await original<typeof import('../embeddingProvider.js')>(), embedDocument: mocks.embed, embedQuery: mocks.embedQuery }));

const ids: string[] = [];
const bytes = Buffer.from('Photosynthesis converts sunlight into chemical energy in plants.');
const metadata = (id = 'drive_file') => ({ id, parents:['folder'], name: 'biology.txt', mimeType: 'text/plain', size: String(bytes.length), version: '1' });
const missing = () => Object.assign(new Error('missing'), { status: 404 });
async function intent() {
  const row = await createUploadIntent({ request_key: crypto.randomUUID(), original_name: 'biology.txt', mime_type: 'text/plain', size: bytes.length }, undefined, 'drive');
  ids.push(row.id); return row;
}
async function imported() {
  const result = await importDriveFile('drive_file'); ids.push(result.id); return result.id;
}
async function job(id: string) { return (await query<{ id: string; version: number; status: string }>('SELECT * FROM resource_processing_jobs WHERE resource_id=$1', [id])).rows[0]; }
async function ready(id: string) {
  const record = await job(id);
  await processResourceJob(record.id); await processResourceJob(record.id);
  expect((await getResourceProcessing(id)).status).toBe('ready');
}

describe.skipIf(SKIP_INTEGRATION)('Drive resource persistence and retrieval (real PostgreSQL)', () => {
  beforeAll(async () => {
    vi.stubEnv('GOOGLE_TOKEN_ENCRYPTION_KEY', 'test-encryption-key'.repeat(3));
    vi.stubEnv('GOOGLE_OAUTH_STATE_SECRET', 'test-state-key'.repeat(3));
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client'); vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
    await startTestServer();
  });
  beforeEach(async () => {
    vi.resetAllMocks();
    mocks.refresh.mockResolvedValue('test-access');
    mocks.request.mockImplementation(async () => new Response(JSON.stringify({files:[{id:'library'}]}),{status:200}));
    mocks.get.mockImplementation(async (_token, id) => id === 'folder' ? { id, mimeType: 'application/vnd.google-apps.folder' } : metadata(id));
    mocks.generate.mockResolvedValue('reserved_file');
    mocks.session.mockResolvedValue('https://www.googleapis.com/upload/drive/v3/files?upload_id=test');
    mocks.chunk.mockResolvedValue(0);
    mocks.open.mockImplementation(async () => ({ stream: Readable.from(bytes), size: bytes.length, contentType: 'text/plain', statusCode: 200 }));
    mocks.embed.mockResolvedValue([1, ...Array(3071).fill(0)]); mocks.embedQuery.mockResolvedValue([1, ...Array(3071).fill(0)]);
    await query(`INSERT INTO google_drive_connection(id,account_id,account_email,encrypted_refresh_token,scopes,folder_id)
      VALUES ('primary','test-account','test@example.test',$1,'drive','folder')`, [encryptGoogleRefreshToken(crypto.randomUUID())]);
  });
  afterEach(async () => {
    await query("DELETE FROM embeddings WHERE entity_type='resource_chunk' AND entity_id IN (SELECT id FROM resource_chunks WHERE resource_id=ANY($1))", [ids]);
    await query('DELETE FROM resources WHERE id=ANY($1)', [ids]);
    await query('DELETE FROM resource_uploads WHERE id=ANY($1)', [ids]);
    await query('DELETE FROM google_drive_connection'); await query('DELETE FROM google_drive_oauth_states');
    ids.length = 0;
  });
  afterAll(async () => { await stopTestServer(); vi.unstubAllEnvs(); });

  it('stores an import exactly once under ten simultaneous requests', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => importDriveFile('drive_file')));
    ids.push(results[0].id); expect(new Set(results.map(r => r.id)).size).toBe(1);
    expect(results.filter(r => !r.already_saved)).toHaveLength(1);
    expect((await query('SELECT id FROM resource_outbox WHERE job_id=$1', [(await job(ids[0])).id])).rowCount).toBe(1);
  });
  it('stores only a private Drive reference and queues indexing', async () => {
    const id = await imported();
    const row = (await query('SELECT * FROM resources WHERE id=$1', [id])).rows[0];
    expect(row).toMatchObject({ file_path: 'gdrive://drive_file', file_validation: 'pending', url: `/api/resources/blob/${id}` });
    expect((await job(id)).status).toBe('queued'); expect(mocks.open).not.toHaveBeenCalled();
  });
  it('rejects imports outside the saved Marina root before creating a resource or job', async () => {
    mocks.get.mockResolvedValue({...metadata(),parents:[]});
    await expect(importDriveFile('outside')).rejects.toMatchObject({status:403});
    expect((await query("SELECT resource_id FROM resource_drive_files WHERE file_id='outside'")).rows).toEqual([]);
  });
  it('adds a saved reference when an existing file is discovered inside a goal folder, without duplicating it', async () => {
    const id=await imported(); const goalId=crypto.randomUUID();
    await query('INSERT INTO goals(id,title,created_at,updated_at) VALUES($1,$2,$3,$3)',[goalId,'Synthetic folder goal',new Date().toISOString()]);
    try {
      mocks.get.mockImplementation(async (_token,fileId)=>fileId==='goalFolder'?{id:fileId,name:'Synthetic folder goal',mimeType:'application/vnd.google-apps.folder',parents:['folder'],appProperties:{marinaEntityType:'goal',marinaEntityId:goalId}}:{...metadata(),parents:['goalFolder']});
      expect((await importDriveFile('drive_file')).id).toBe(id);
      await importDriveFile('drive_file');
      expect((await query("SELECT id FROM edges WHERE source_id=$1 AND target_id=$2 AND relationship='attached_to'",[id,goalId])).rows).toHaveLength(1);
    } finally {await query('DELETE FROM edges WHERE target_id=$1',[goalId]);await query('DELETE FROM goals WHERE id=$1',[goalId]);}
  });
  it('removes a moved-outside file from retrieval even if its content version did not change', async () => {
    const id = await imported(); await ready(id);
    mocks.get.mockResolvedValue({...metadata(),parents:[]});
    expect((await searchDocuments('Photosynthesis',[id])).evidence).toEqual([]);
    await syncDriveResource(id);
    expect((await query('SELECT available FROM resource_drive_files WHERE resource_id=$1',[id])).rows[0].available).toBe(false);
    expect((await query('SELECT id FROM resources WHERE id=$1',[id])).rows).toHaveLength(1);
  });
  it('still checks the original ancestry when synchronization metadata is missing',async()=>{
    const id=await imported(); await ready(id);
    await query('DELETE FROM resource_drive_files WHERE resource_id=$1',[id]);
    mocks.get.mockResolvedValue({...metadata(),parents:[]});
    expect((await searchDocuments('Photosynthesis',[id])).evidence).toEqual([]);
  });
  it('reserves one file identity and one encrypted upload session across concurrent preparation', async () => {
    const row = await intent();
    mocks.get.mockImplementation(async (_t, id) => { if (id === 'folder') return { id, mimeType: 'application/vnd.google-apps.folder' }; throw missing(); });
    const results = await Promise.all(Array.from({ length: 5 }, () => prepareDriveUpload(row.id)));
    expect(results.every(r => r.offset === 0 && !r.complete)).toBe(true);
    expect(mocks.generate).toHaveBeenCalledTimes(1); expect(mocks.session).toHaveBeenCalledTimes(1);
    const saved = (await query('SELECT * FROM resource_drive_uploads WHERE upload_id=$1', [row.id])).rows[0];
    expect(saved.file_id).toBe('reserved_file'); expect(saved.encrypted_session).not.toContain('googleapis');
  });
  it('recovers a lost completion response without transferring a second file', async () => {
    const row = await intent();
    await query('INSERT INTO resource_drive_uploads(upload_id,file_id) VALUES ($1,$2)', [row.id, 'reserved_file']);
    mocks.get.mockResolvedValue({ ...metadata('reserved_file'), appProperties: { marinaUploadId: row.id } });
    expect(await prepareDriveUpload(row.id)).toMatchObject({ complete: true, offset: bytes.length });
    expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.chunk).not.toHaveBeenCalled();
    expect((await job(row.id)).status).toBe('queued');
    mocks.get.mockRejectedValue(new Error('network unavailable'));
    expect(await finalizeDriveUpload(row.id)).toMatchObject({ already_saved: true });
  });
  it.each(['name', 'mimeType', 'size', 'id', 'appProperties'])('rejects mismatched upload metadata: %s', async field => {
    const row = await intent();
    await query('INSERT INTO resource_drive_uploads(upload_id,file_id) VALUES ($1,$2)', [row.id, 'reserved_file']);
    mocks.get.mockResolvedValue({ ...metadata('reserved_file'), appProperties: { marinaUploadId: row.id }, [field]: field === 'appProperties' ? {} : 'wrong' });
    await expect(finalizeDriveUpload(row.id)).rejects.toThrow(/match/);
    expect((await query('SELECT id FROM resources WHERE id=$1', [row.id])).rowCount).toBe(0);
  });
  it('rejects provider confusion before any storage request', async () => {
    const row = await intent(); await expect(finalizeBlobUpload(row.id)).rejects.toMatchObject({ status: 409 });
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('coalesces Drive imports with a pending upload completion for the same original', async () => {
    const row = await intent();
    await query('INSERT INTO resource_drive_uploads(upload_id,file_id) VALUES ($1,$2)', [row.id, 'reserved_file']);
    mocks.get.mockResolvedValue({ ...metadata('reserved_file'), appProperties: { marinaUploadId: row.id } });
    const results = await Promise.all([importDriveFile('reserved_file'), finalizeDriveUpload(row.id), importDriveFile('reserved_file')]);
    expect(new Set(results.map(r => r.id))).toEqual(new Set([row.id]));
    expect((await query('SELECT resource_id FROM resource_drive_files WHERE file_id=$1', ['reserved_file'])).rowCount).toBe(1);
  });
  it('recovers expired sessions while keeping the same reserved Drive file ID', async () => {
    const row = await intent();
    await query('INSERT INTO resource_drive_uploads(upload_id,file_id,encrypted_session) VALUES ($1,$2,$3)', [row.id, 'reserved_file', encryptGoogleRefreshToken('https://www.googleapis.com/upload/drive/v3/files?upload_id=old')]);
    mocks.get.mockImplementation(async (_t, id) => { if (id === 'folder') return { id, mimeType: 'application/vnd.google-apps.folder' }; throw missing(); });
    mocks.chunk.mockRejectedValueOnce(missing()).mockResolvedValue(0);
    expect(await prepareDriveUpload(row.id)).toMatchObject({ offset: 0 });
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.session.mock.calls[0][1]).toBe('reserved_file');
  });
  it('reconciles a completed transfer whose browser never acknowledged the save', async () => {
    const row = await intent();
    await query('INSERT INTO resource_drive_uploads(upload_id,file_id) VALUES ($1,$2)', [row.id, 'reserved_file']);
    mocks.get.mockResolvedValue({ ...metadata('reserved_file'), appProperties: { marinaUploadId: row.id } });
    await reconcileUploads(); expect((await job(row.id)).status).toBe('queued');
  });
  it('consumes OAuth state once and rejects replay', async () => {
    const url = await createDriveAuthorization('/?view=resources');
    const state = verifyGoogleOAuthState(new URL(url).searchParams.get('state')!);
    expect(state.purpose).toBe('drive'); expect(new URL(url).searchParams.get('scope')).toContain('drive.readonly');
    await consumeDriveAuthorization(state.nonce);
    await expect(consumeDriveAuthorization(state.nonce)).rejects.toMatchObject({ status: 400 });
  });
  it('rejects expired OAuth state and disconnected uploads', async () => {
    await query("INSERT INTO google_drive_oauth_states(nonce,expires_at) VALUES ('expired',NOW()-INTERVAL '1 second')");
    await expect(consumeDriveAuthorization('expired')).rejects.toMatchObject({ status: 400 });
    await disconnectDrive(); const row = await intent();
    await expect(prepareDriveUpload(row.id)).rejects.toMatchObject({ status: 409 });
  });
  it('extracts, embeds, and retrieves a ready passage with a source citation', async () => {
    const id = await imported();
    expect((await searchDocuments('photosynthesis', [id])).evidence).toHaveLength(0);
    await ready(id);
    const result = await searchDocuments('photosynthesis', [id]);
    expect(result.vector_degraded).toBe(false);
    expect(result.evidence[0]).toMatchObject({ resource_id: id, source_url: 'https://drive.google.com/file/d/drive_file/view', passage: expect.stringContaining('Photosynthesis') });
    expect(result.evidence[0].chunk_id).toBeTruthy();
  });
  it('serves lexical evidence when the embedding provider is unavailable', async () => {
    const id = await imported(); await ready(id); mocks.embedQuery.mockRejectedValue(new Error('provider down'));
    const result = await searchDocuments('photosynthesis', [id]);
    expect(result.vector_degraded).toBe(true); expect(result.evidence).toHaveLength(1);
  });
  it('invalidates old passages immediately after a detected edit and queues a new generation', async () => {
    const id = await imported(); await ready(id); const before = await job(id);
    mocks.get.mockResolvedValue({ ...metadata(), version: '2' }); await syncDriveResource(id);
    expect(await job(id)).toMatchObject({ status: 'queued', stage: 'extract', version: before.version + 1 });
    expect((await searchDocuments('photosynthesis', [id])).evidence).toHaveLength(0);
    expect((await query('SELECT is_stale FROM embeddings WHERE entity_id IN (SELECT id FROM resource_chunks WHERE resource_id=$1)', [id])).rows.every(r => r.is_stale)).toBe(true);
  });
  it.each([403, 404, 400])('excludes inaccessible/unsupported Drive files (%s) and recovers restored access', async status => {
    const id = await imported(); await ready(id);
    mocks.get.mockRejectedValue(Object.assign(new Error('source unavailable'), { status }));
    await syncDriveResource(id);
    expect((await searchDocuments('photosynthesis', [id])).evidence).toHaveLength(0);
    expect(await job(id)).toMatchObject({ status: 'failed', error_code: 'drive_unavailable' });
    mocks.get.mockResolvedValue(metadata()); await syncDriveResource(id);
    expect((await job(id)).status).toBe('queued'); await ready(id);
  });
  it('preserves the previous index on transient Google failure and exposes the check failure', async () => {
    const id = await imported(); await ready(id);
    mocks.get.mockRejectedValue(Object.assign(new Error('busy'), { status: 503 }));
    await expect(syncDriveResource(id)).rejects.toMatchObject({ status: 503 });
    expect((await query('SELECT available,last_error FROM resource_drive_files WHERE resource_id=$1', [id])).rows[0]).toMatchObject({ available: true, last_error: expect.stringContaining('could not be checked') });
    // Keep the index for recovery, but do not release content without current ancestry proof.
    await expect(searchDocuments('photosynthesis', [id])).rejects.toMatchObject({status:503});
  });
  it('continues the recovery batch after a source check fails and makes the failure visible', async () => {
    await imported(); const other = await importDriveFile('other_file'); ids.push(other.id);
    mocks.get.mockImplementation(async (_t, id) => { if (id === 'drive_file') throw Object.assign(new Error('temporary failure'), { status: 503 }); return metadata(id); });
    expect(await reconcileDriveResources(10, true)).toBe(1);
    expect((await query("SELECT last_error FROM google_drive_connection WHERE id='primary'")).rows[0].last_error).toContain('1 Drive source checks failed');
  });
  it('does not publish chunks if the Drive version changes during download', async () => {
    const id = await imported();
    mocks.get.mockResolvedValueOnce(metadata()).mockResolvedValue({ ...metadata(), version: '2' });
    await processResourceJob((await job(id)).id);
    expect((await query('SELECT id FROM resource_chunks WHERE resource_id=$1', [id])).rowCount).toBe(0);
    expect((await job(id)).status).toBe('queued');
  });
  it('keeps Drive originals when a library resource is deleted', async () => {
    const id = await imported(); await deleteStoredFile('gdrive://drive_file');
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await query('DELETE FROM resources WHERE id=$1', [id]);
    expect((await query('SELECT * FROM resource_drive_files WHERE resource_id=$1', [id])).rowCount).toBe(0);
  });
  it('rejects invalid search and import input through the authenticated API surface', async () => {
    for (const [route, body] of [['search', { query: '' }], ['search', { query: 'ok', resource_ids: ['bad'] }], ['import', { file_id: '../secret' }]]) {
      const response = await fetch(`${baseUrl}/api/google-drive/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
  });
  it('requires a prepared upload session before accepting bytes', async () => {
    const row = await intent(); await expect(receiveDriveChunk(row.id, 0, bytes)).rejects.toMatchObject({ status: 409 });
    expect(mocks.chunk).not.toHaveBeenCalled();
  });
});
