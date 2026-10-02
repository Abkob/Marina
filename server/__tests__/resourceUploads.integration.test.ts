import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { createPortableBackupArchive } from '../services/portableBackup.js';
import { verifyPortableBackup } from '../../scripts/lib/portableBackup.js';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { baseUrl, SKIP_INTEGRATION, startTestServer, stopTestServer } from './setup.js';
import { query } from '../db.js';
import { createUploadIntent, finalizeBlobUpload, registerLegacyBlob, reconcileUploads } from '../services/resourceUploads.js';
import { getResourceProcessing, processResourceJob, reclaimResourceJobs, retryResourceProcessing, resourceRetryAt } from '../services/resourceProcessing.js';
import { dispatchResourceEvents, reconcileResourceDispatch, resourceInngest } from '../services/resourceDispatch.js';
import { textPdf } from './fixtures/uploadPdf.js';
import { encryptedPdf } from './fixtures/encryptedPdf.js';
import path from 'node:path';
import * as pdfText from '../services/pdfText.js';

const mocks = vi.hoisted(() => ({ objects: new Map<string, { bytes: Uint8Array; contentType: string; url: string; pathname: string }>(), head: vi.fn(), get: vi.fn(), del: vi.fn(), embed: vi.fn() }));
vi.mock('@vercel/blob', async importOriginal => ({ ...await importOriginal<typeof import('@vercel/blob')>(), head: mocks.head, get: mocks.get, del: mocks.del }));
vi.mock('../embeddingProvider.js', async importOriginal => ({ ...await importOriginal<typeof import('../embeddingProvider.js')>(), embedDocument: mocks.embed }));

const ids: string[] = [];
const localFiles = new Set<string>();
const goalId = 'reject-upload-test-attachment';
async function post(url: string, body: unknown) {
  return fetch(`${baseUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function storedGet(reference: string) {
  const object = [...mocks.objects.values()].find(o => o.url === reference);
  if (!object) return null;
  return { statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(object.bytes); controller.close(); } }),
    blob: { ...object, size: object.bytes.length, etag: 'test-object' } };
}
async function intent(name = 'notes.txt', bytes: Uint8Array = Buffer.from('Small research note for indexing.'), attachment = false) {
  const input = { request_key: crypto.randomUUID(), original_name: name, mime_type: name.endsWith('.pdf') ? 'application/pdf' : name.endsWith('.png') ? 'image/png' : 'text/plain',
    size: bytes.length, ...(attachment ? { attach_to_id: goalId, attach_to_type: 'goal' as const } : {}) };
  const record = await createUploadIntent(input);
  ids.push(record.id);
  const object = { bytes, contentType: input.mime_type, pathname: record.pathname, url: `https://test.private.blob.vercel-storage.com/${record.pathname}` };
  mocks.objects.set(record.pathname, object);
  return { record, object, input };
}
async function saved(name?: string, bytes?: Uint8Array) {
  const fixture = await intent(name, bytes);
  await finalizeBlobUpload(fixture.record.id);
  const job = (await query('SELECT * FROM resource_processing_jobs WHERE resource_id=$1', [fixture.record.id])).rows[0];
  return { ...fixture, jobId: String(job.id) };
}
async function status(jobId: string) { return (await query('SELECT * FROM resource_processing_jobs WHERE id=$1', [jobId])).rows[0]; }
async function counts(id: string) {
  const { rows } = await query(`SELECT (SELECT COUNT(*)::int FROM resources WHERE id=$1) AS resources,
    (SELECT COUNT(*)::int FROM resource_processing_jobs WHERE resource_id=$1) AS jobs,
    (SELECT COUNT(*)::int FROM edges WHERE source_id=$1) AS edges`, [id]);
  return rows[0];
}

describe.skipIf(SKIP_INTEGRATION)('persistent uploads and durable processing (real PostgreSQL)', () => {
  beforeAll(async () => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'unit-test-only-no-network');
    await startTestServer();
    await query('INSERT INTO goals (id,title,created_at,updated_at) VALUES ($1,$2,$3,$3)', [goalId, 'Upload test goal', new Date().toISOString()]);
  });
  beforeEach(() => {
    mocks.objects.clear(); vi.clearAllMocks();
    mocks.head.mockImplementation(async pathname => {
      const object = mocks.objects.get(pathname) ?? [...mocks.objects.values()].find(o => o.url === pathname);
      if (!object) throw Object.assign(new Error('Not found'), { name: 'BlobNotFoundError' });
      return { ...object, size: object.bytes.length };
    });
    mocks.get.mockImplementation(async reference => storedGet(reference));
    mocks.del.mockResolvedValue(undefined);
    mocks.embed.mockImplementation(async () => [1, ...Array(3071).fill(0)]);
  });
  afterEach(async () => {
    await query('DROP TRIGGER IF EXISTS reject_upload_test_edge ON edges');
    await query('DROP FUNCTION IF EXISTS reject_upload_test_edge()');
    await query("DELETE FROM embeddings WHERE entity_type='resource_chunk' AND entity_id IN (SELECT id FROM resource_chunks WHERE resource_id=ANY($1))", [ids]);
    await query("DELETE FROM edges WHERE source_type='resource' AND source_id=ANY($1)", [ids]);
    await query('DELETE FROM resources WHERE id=ANY($1)', [ids]);
    await query('DELETE FROM resource_uploads WHERE id=ANY($1)', [ids]);
    ids.length = 0;
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await query('DELETE FROM goals WHERE id=$1', [goalId]);
    for (const file of localFiles) await fs.unlink(file).catch(() => undefined);
    await stopTestServer(); vi.unstubAllEnvs();
  });

  it('coalesces twenty simultaneous intent requests', async () => {
    const { input, record } = await intent();
    const repeated = await Promise.all(Array.from({ length: 20 }, () => createUploadIntent(input)));
    expect(new Set(repeated.map(row => row.id))).toEqual(new Set([record.id]));
  });
  it('rejects reuse of a request key for different metadata', async () => {
    const { input } = await intent();
    await expect(createUploadIntent({ ...input, original_name: 'other.txt' })).rejects.toMatchObject({ status: 409 });
  });
  it('rolls back intent creation for an invalid attachment target', async () => {
    const { input } = await intent();
    const key = crypto.randomUUID();
    await expect(createUploadIntent({ ...input, request_key: key, attach_to_id: 'missing', attach_to_type: 'goal' })).rejects.toThrow('no longer exists');
    expect((await query('SELECT id FROM resource_uploads WHERE request_key=$1', [key])).rowCount).toBe(0);
  });
  it('coalesces twenty concurrent callback/browser completions into one resource/job/outbox', async () => {
    const { record } = await intent();
    const results = await Promise.all(Array.from({ length: 20 }, () => finalizeBlobUpload(record.id)));
    expect(new Set(results.map(r => r.id))).toEqual(new Set([record.id]));
    expect(await counts(record.id)).toEqual({ resources: 1, jobs: 1, edges: 0 });
    expect((await query('SELECT o.id FROM resource_outbox o JOIN resource_processing_jobs j ON j.id=o.job_id WHERE j.resource_id=$1', [record.id])).rowCount).toBe(1);
  });
  it('acknowledges receipt without downloading or parsing the original', async () => {
    const { record } = await intent();
    await finalizeBlobUpload(record.id);
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.embed).not.toHaveBeenCalled();
    expect((await getResourceProcessing(record.id)).status).toBe('queued');
  });
  it('confirms a previously committed save even if Blob HEAD is unavailable', async () => {
    const { record } = await saved();
    mocks.head.mockRejectedValue(new Error('storage down'));
    expect(await finalizeBlobUpload(record.id)).toMatchObject({ id: record.id, already_saved: true });
  });
  it.each(['size', 'contentType', 'pathname', 'url'])('rejects mismatched object metadata: %s', async field => {
    const { record, object } = await intent();
    mocks.head.mockResolvedValue({ ...object, size: object.bytes.length, [field]: field === 'size' ? 1 : field === 'url' ? 'https://untrusted.example/file.txt' : 'wrong' });
    await expect(finalizeBlobUpload(record.id)).rejects.toThrow(/match/);
    expect((await counts(record.id)).resources).toBe(0); expect(mocks.del).not.toHaveBeenCalled();
  });
  it('rejects a supplied callback object for a different upload', async () => {
    const { record, object } = await intent();
    await expect(finalizeBlobUpload(record.id, { url: object.url, pathname: 'marina/resource/other.txt' })).rejects.toMatchObject({ status: 400 });
  });
  it('atomically rolls back resource, attachment, and job when the attachment insert fails', async () => {
    const { record } = await intent('notes.txt', undefined, true);
    await query(`CREATE FUNCTION reject_upload_test_edge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.target_id='reject-upload-test-attachment' THEN RAISE EXCEPTION 'injected attachment failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER reject_upload_test_edge BEFORE INSERT ON edges FOR EACH ROW EXECUTE FUNCTION reject_upload_test_edge();`);
    await expect(finalizeBlobUpload(record.id)).rejects.toThrow('injected attachment failure');
    expect(await counts(record.id)).toEqual({ resources: 0, jobs: 0, edges: 0 });
    expect(mocks.del).not.toHaveBeenCalled();
    await query('DROP TRIGGER reject_upload_test_edge ON edges');
    await finalizeBlobUpload(record.id);
    expect(await counts(record.id)).toEqual({ resources: 1, jobs: 1, edges: 1 });
  });
  it('returns a retryable incomplete-transfer result without deleting anything', async () => {
    const { record } = await intent(); mocks.objects.clear();
    await expect(finalizeBlobUpload(record.id)).rejects.toMatchObject({ status: 409 });
    expect(mocks.del).not.toHaveBeenCalled();
  });
  it('preserves the file in the library when its target was deleted during transfer', async () => {
    const { record, input, object } = await intent();
    const target = crypto.randomUUID();
    await query('INSERT INTO goals (id,title,created_at,updated_at) VALUES ($1,$2,$3,$3)', [target, 'Temporary attachment', new Date().toISOString()]);
    const attached = await createUploadIntent({ ...input, request_key: crypto.randomUUID(), attach_to_id: target, attach_to_type: 'goal' });
    ids.push(attached.id);
    mocks.objects.set(attached.pathname, { ...object, pathname: attached.pathname, url: object.url.replace(record.id, attached.id) });
    await query('DELETE FROM goals WHERE id=$1', [target]);
    await finalizeBlobUpload(attached.id);
    expect(await counts(attached.id)).toEqual({ resources: 1, edges: 0, jobs: 1 });
    expect((await query('SELECT info FROM resources WHERE id=$1', [attached.id])).rows[0].info).toContain('attachment target was removed');
  });
  it('recovers a transfer whose browser never registered it', async () => {
    const { record } = await intent();
    await reconcileUploads();
    expect((await counts(record.id)).resources).toBe(1);
  });
  it('expires stale intents without deleting unreferenced objects', async () => {
    const { record } = await intent();
    await query("UPDATE resource_uploads SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [record.id]);
    await reconcileUploads();
    expect((await query('SELECT state FROM resource_uploads WHERE id=$1', [record.id])).rows[0].state).toBe('expired');
    expect(mocks.del).not.toHaveBeenCalled();
  });
  it('keeps legacy completion idempotent', async () => {
    const bytes = Buffer.from('legacy original');
    const pathname = `marina/resource/${crypto.randomUUID()}-legacy.txt`;
    const object = { bytes, pathname, contentType: 'text/plain', url: `https://test.private.blob.vercel-storage.com/${pathname}` };
    mocks.objects.set(pathname, object);
    const input = { original_name: 'legacy.txt', mime_type: 'text/plain', size: bytes.length, blob: object };
    const results = await Promise.all([registerLegacyBlob(input), registerLegacyBlob(input)]);
    ids.push(results[0].id); expect(results[1].id).toBe(results[0].id);
  });
  it('a callback arriving after deletion cannot recreate the resource', async () => {
    const { record } = await saved();
    expect((await fetch(`${baseUrl}/api/resources/${record.id}`, { method: 'DELETE' })).status).toBe(200);
    await expect(finalizeBlobUpload(record.id)).rejects.toMatchObject({ status: 410 });
    expect((await counts(record.id)).resources).toBe(0);
  });
  it('deleting a legacy duplicate preserves an original still referenced by another resource', async () => {
    const { record, object } = await saved();
    const duplicate = crypto.randomUUID(); ids.push(duplicate);
    await query('INSERT INTO resources (id,title,type,file_path,created_at) VALUES ($1,$2,$3,$4,$5)', [duplicate, 'Old duplicate', 'document', object.url, new Date().toISOString()]);
    await fetch(`${baseUrl}/api/resources/${record.id}`, { method: 'DELETE' });
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('processes a short text through validation, chunks, embeddings, and ready status', async () => {
    const { record, jobId } = await saved('notes.txt', Buffer.from('Short note.'));
    await processResourceJob(jobId); await processResourceJob(jobId);
    expect(await getResourceProcessing(record.id)).toMatchObject({ status: 'ready', file_validation: 'valid', chunks: 1, embedded: 1 });
    expect(mocks.embed).toHaveBeenCalledTimes(1);
  });
  it('only one of two simultaneous workers claims a document', async () => {
    const { jobId } = await saved();
    expect((await Promise.all([processResourceJob(jobId), processResourceJob(jobId)])).filter(Boolean)).toHaveLength(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
  it('persists no-text state for a whitespace-only document', async () => {
    const { record, jobId } = await saved('notes.txt', Buffer.from(' \n\n '));
    await processResourceJob(jobId);
    expect(await getResourceProcessing(record.id)).toMatchObject({ status: 'no_text', chunks: 0, file_validation: 'valid' });
  });
  it('preserves images and explicitly reports that OCR is not enabled', async () => {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
    const { record, jobId } = await saved('scan.png', bytes);
    await processResourceJob(jobId);
    expect(await getResourceProcessing(record.id)).toMatchObject({ status: 'unsupported', error_code: 'ocr_required', file_validation: 'valid' });
  });
  it('rejects forged PDF bytes while retaining the original for recovery', async () => {
    const { record, jobId } = await saved('forged.pdf', Buffer.from('<html>not a PDF</html>'));
    await processResourceJob(jobId);
    expect(await getResourceProcessing(record.id)).toMatchObject({ status: 'failed', error_code: 'invalid_file', file_validation: 'invalid' });
    expect((await fetch(`${baseUrl}/api/resources/blob/${record.id}`)).status).toBe(422);
    expect(mocks.del).not.toHaveBeenCalled();
  });
  it('keeps the previous good chunks after a corrupt PDF fails to parse', async () => {
    const { record, jobId } = await saved('broken.pdf', Buffer.from('%PDF-1.7\ninvalid document'));
    await query('INSERT INTO resource_chunks (id,resource_id,chunk_index,content,content_hash,created_at) VALUES ($1,$2,0,$3,$4,$5)',
      [crypto.randomUUID(), record.id, 'Prior good extracted content', 'prior-hash', new Date().toISOString()]);
    await processResourceJob(jobId);
    expect(await getResourceProcessing(record.id)).toMatchObject({ status: 'failed', error_code: 'corrupt_pdf', chunks: 1, file_validation: 'valid' });
  });
  it('extracts an actual PDF and keeps exact page citations', async () => {
    const { record, jobId } = await saved('research.pdf', textPdf('Research notes for page one.'));
    await processResourceJob(jobId); await processResourceJob(jobId);
    expect((await getResourceProcessing(record.id)).status).toBe('ready');
    expect((await query('SELECT content,page_start,page_end FROM resource_chunks WHERE resource_id=$1', [record.id])).rows[0]).toMatchObject({ page_start: 1, page_end: 1 });
  });
  it('recognizes a valid PDF with no extractable text', async () => {
    const { record, jobId } = await saved('scan.pdf', textPdf());
    await processResourceJob(jobId);
    expect(await getResourceProcessing(record.id)).toMatchObject({ status: 'no_text', error_code: 'no_text', file_validation: 'valid' });
  });
  it('indexes PDF text containing NUL glyphs without changing the original or page citations', async () => {
    const bytes = textPdf('Algebra page');
    const parsed = await pdfText.extractPdfPages(new Uint8Array(bytes));
    // Some embedded PDF fonts produce NUL glyphs even when the binary PDF is
    // valid. Reproduce that parser output against real PostgreSQL.
    parsed.pages[0].text = 'Algebra\u0000page';
    const { record, jobId, object } = await saved('null-glyph.pdf', bytes);
    const extract = vi.spyOn(pdfText, 'extractPdfPages').mockResolvedValueOnce(parsed);
    try { await processResourceJob(jobId); } finally { extract.mockRestore(); }
    expect(await getResourceProcessing(record.id)).toMatchObject({ status: 'queued', stage: 'embed', chunks: 1 });
    const chunk = (await query('SELECT content,page_start,page_end FROM resource_chunks WHERE resource_id=$1', [record.id])).rows[0];
    expect(chunk.content).toContain('Algebra');
    expect(chunk.content).toContain('page');
    expect(chunk.content).not.toContain('\u0000');
    expect(chunk).toMatchObject({ page_start: 1, page_end: 1 });
    expect(object.bytes).toEqual(bytes);
    await processResourceJob(jobId);
    expect(await getResourceProcessing(record.id)).toMatchObject({ status: 'ready', embedded: 1 });
  });
  it('distinguishes a password-protected PDF from an empty or corrupt PDF', async () => {
    const { record, jobId } = await saved('protected.pdf', Buffer.from(encryptedPdf, 'base64'));
    await processResourceJob(jobId);
    expect(await getResourceProcessing(record.id)).toMatchObject({ status: 'failed', error_code: 'encrypted_pdf', file_validation: 'valid' });
    expect(mocks.del).not.toHaveBeenCalled();
  });
  it('reclaims interrupted work and bounds repeated crashes', async () => {
    const { jobId } = await saved();
    await query("UPDATE resource_processing_jobs SET status='running',attempts=1,lease_expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [jobId]);
    await reclaimResourceJobs(); expect((await status(jobId)).status).toBe('queued');
    await query("UPDATE resource_processing_jobs SET status='running',attempts=3,lease_expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [jobId]);
    await reclaimResourceJobs(); expect((await status(jobId)).status).toBe('failed');
  });
  it('an expired worker cannot overwrite the new worker’s results', async () => {
    const { jobId, record, object } = await saved();
    let release!: () => void; let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    mocks.get.mockImplementationOnce(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return storedGet(object.url); });
    const stale = processResourceJob(jobId); await waiting;
    await query("UPDATE resource_processing_jobs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [jobId]);
    await reclaimResourceJobs(); await processResourceJob(jobId);
    release(); expect(await stale).toBe(false);
    expect(await getResourceProcessing(record.id)).toMatchObject({ status: 'queued', stage: 'embed', chunks: 1 });
  });
  it('deleting a resource during extraction prevents late chunk writes', async () => {
    const { jobId, record, object } = await saved();
    let release!: () => void; let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    mocks.get.mockImplementationOnce(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return storedGet(object.url); });
    const work = processResourceJob(jobId); await waiting;
    await fetch(`${baseUrl}/api/resources/${record.id}`, { method: 'DELETE' });
    release(); await work;
    expect((await query('SELECT id FROM resource_chunks WHERE resource_id=$1', [record.id])).rowCount).toBe(0);
  });
  it('retries embedding failures with backoff, then exposes a terminal failure while the file stays readable', async () => {
    const { record, jobId } = await saved(); await processResourceJob(jobId);
    const version = (await status(jobId)).version as number;
    expect(await resourceRetryAt(jobId, version)).toBeNull();
    mocks.embed.mockRejectedValue(new Error('provider error with secret URL https://private.example/token'));
    for (let attempt = 1; attempt <= 3; attempt++) {
      await processResourceJob(jobId);
      const job = await status(jobId);
      expect(job.attempts).toBe(attempt); expect(String(job.error)).not.toContain('private.example');
      expect(job.status).toBe(attempt === 3 ? 'failed' : 'queued');
      if (attempt < 3) {
        expect(new Date(job.next_attempt_at as string).getTime()).toBeGreaterThan(Date.now());
        expect(await resourceRetryAt(jobId, version)).toBe(new Date(job.next_attempt_at as string).toISOString());
      } else expect(await resourceRetryAt(jobId, version)).toBeNull();
      expect(await resourceRetryAt(jobId, version - 1)).toBeNull();
      await query('UPDATE resource_processing_jobs SET next_attempt_at=NOW() WHERE id=$1', [jobId]);
    }
    const response = await fetch(`${baseUrl}/api/resources/blob/${record.id}`);
    expect(response.status).toBe(200); expect(await response.text()).toContain('research note');
  });
  it('retry resumes a failed index without retransferring or re-extracting', async () => {
    const { record, jobId } = await saved(); await processResourceJob(jobId);
    await query("UPDATE resource_processing_jobs SET status='failed',attempts=3 WHERE id=$1", [jobId]);
    await retryResourceProcessing(record.id);
    const version = (await status(jobId)).version;
    await retryResourceProcessing(record.id);
    expect((await status(jobId)).version).toBe(version);
    await processResourceJob(jobId);
    expect((await getResourceProcessing(record.id)).status).toBe('ready');
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
  it('ignores an event for an obsolete generation', async () => {
    const { jobId } = await saved();
    expect(await processResourceJob(jobId, 0)).toBe(false);
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('preserves unsent outbox events across delivery failure and recovers lost dispatched work', async () => {
    vi.stubEnv('INNGEST_EVENT_KEY', 'test-key'); vi.stubEnv('INNGEST_SIGNING_KEY', 'test-signing-key');
    const { jobId } = await saved();
    const send = vi.spyOn(resourceInngest, 'send').mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ids: ['event'] });
    await expect(dispatchResourceEvents()).rejects.toThrow('offline');
    expect((await query('SELECT delivered_at,attempts FROM resource_outbox WHERE job_id=$1', [jobId])).rows[0]).toMatchObject({ delivered_at: null, attempts: 1 });
    await dispatchResourceEvents(); expect(send).toHaveBeenCalledTimes(2);
    await query("UPDATE resource_processing_jobs SET last_dispatched_at=NOW()-INTERVAL '3 minutes' WHERE id=$1", [jobId]);
    await reconcileResourceDispatch();
    expect((await query('SELECT id FROM resource_outbox WHERE job_id=$1 AND delivered_at IS NULL', [jobId])).rowCount).toBe(1);
    vi.stubEnv('INNGEST_EVENT_KEY', ''); vi.stubEnv('INNGEST_SIGNING_KEY', '');
  });
  it('local multipart upload is idempotent and serves byte ranges with the original filename', async () => {
    const { record } = await intent('local.txt', Buffer.from('0123456789'));
    const upload = async () => {
      const form = new FormData(); form.append('upload_id', record.id); form.append('file', new Blob(['0123456789'], { type: 'text/plain' }), 'local.txt');
      return fetch(`${baseUrl}/api/resources/upload`, { method: 'POST', body: form });
    };
    expect((await upload()).status).toBe(200); expect((await upload()).status).toBe(200);
    const row = (await query('SELECT file_path FROM resources WHERE id=$1', [record.id])).rows[0]; localFiles.add(String(row.file_path));
    const response = await fetch(`${baseUrl}/api/resources/blob/${record.id}`, { headers: { Range: 'bytes=2-5' } });
    expect(response.status).toBe(206); expect(await response.text()).toBe('2345');
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(response.headers.get('content-disposition')).toContain('local.txt');
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect((await counts(record.id)).resources).toBe(1);
  });
  it('recovers legacy local uploads that predate stored file references', async () => {
    const id = crypto.randomUUID(); ids.push(id);
    const name = `legacy-upload-test-${id}.txt`;
    const file = path.resolve('server/uploads', name); localFiles.add(file);
    await fs.writeFile(file, 'Recover this old local original.');
    await query('INSERT INTO resources (id,title,type,url,created_at) VALUES ($1,$2,$3,$4,$5)', [id, 'Legacy', 'document', `/api/resources/serve/${name}`, new Date().toISOString()]);
    const queued = await retryResourceProcessing(id);
    await processResourceJob(String(queued.id)); await processResourceJob(String(queued.id));
    expect(await getResourceProcessing(id)).toMatchObject({ status: 'ready', mime_type: 'text/plain', file_validation: 'valid' });
    expect((await query('SELECT file_path FROM resources WHERE id=$1', [id])).rows[0].file_path).toBe(file);
  });
  it('rejects unauthenticated completion and forged Blob callbacks', async () => {
    const { record } = await intent();
    vi.stubEnv('MARINA_AUTH_REQUIRED', 'true'); vi.stubEnv('MARINA_ACCESS_PASSWORD', 'test-password'); vi.stubEnv('MARINA_SESSION_SECRET', 'test-session-secret-for-integration');
    try {
      expect((await post(`/api/uploads/resources/${record.id}/complete`, {})).status).toBe(401);
      const callback = await post('/api/uploads/token', { type: 'blob.upload-completed', payload: { blob: {}, tokenPayload: JSON.stringify({ kind: 'resource', uploadId: record.id }) } });
      expect(callback.status).toBeGreaterThanOrEqual(400);
      expect((await counts(record.id)).resources).toBe(0);
    } finally { vi.stubEnv('MARINA_AUTH_REQUIRED', 'false'); }
  });
  it('backs up the original bytes, filename, upload identity, and processing state with verified checksums', async () => {
    const { record } = await saved('backup-proof.txt', Buffer.from('Recoverable original file.'));
    const output = new PassThrough(); const buffers: Buffer[] = [];
    output.on('data', chunk => buffers.push(Buffer.from(chunk)));
    await createPortableBackupArchive(output);
    const destination = 'tmp/upload-lifecycle-test-backup.zip';
    await fs.writeFile(destination, Buffer.concat(buffers));
    const verified = await verifyPortableBackup(destination);
    expect(verified.manifest.complete).toBe(true);
    expect(verified.manifest.files.find(file => file.id === record.id)).toMatchObject({ original_name: 'backup-proof.txt', mime_type: 'text/plain', bytes: 26 });
    for (const table of ['resource_uploads', 'resource_processing_jobs', 'resource_outbox']) {
      expect(verified.manifest.database.tables.some(t => t.name === table && t.row_count > 0)).toBe(true);
    }
    await fs.writeFile('tmp/upload-lifecycle-test-backup-id.txt', record.id);
  });
});
