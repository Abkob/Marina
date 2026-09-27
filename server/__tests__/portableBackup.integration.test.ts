import crypto from 'crypto';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPortableBackupArchive } from '../services/portableBackup.js';
import { verifyPortableBackup } from '../../scripts/lib/portableBackup.js';
import { baseUrl, SKIP_INTEGRATION, startTestServer, stopTestServer } from './setup.js';

describe.skipIf(SKIP_INTEGRATION)('complete portable backup (integration)', () => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const goalId = `backup-goal-${suffix}`;
  const taskId = `backup-task-${suffix}`;
  const noteId = `backup-note-${suffix}`;
  const fileId = `backup-file-${suffix}`;
  let tempDir = '';
  let sourceFile = '';
  let archiveFile = '';
  let routeBackupName = '';

  beforeAll(async () => {
    await startTestServer();
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'marina-portable-test-'));
    sourceFile = path.join(tempDir, 'proof.txt');
    archiveFile = path.join(tempDir, 'proof.marina-backup.zip');
    await fsp.writeFile(sourceFile, 'portable backup file proof\n', 'utf8');
    const { query } = await import('../db.js');
    const now = new Date().toISOString();
    await query('INSERT INTO goals (id,title,category,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)', [goalId, 'Portable backup goal', 'Test', 'Safe', now]);
    await query('INSERT INTO tasks (id,goal_id,title,created_at,updated_at) VALUES ($1,$2,$3,$4,$4)', [taskId, goalId, 'Portable backup task', now]);
    await query('INSERT INTO task_notes (id,task_id,content,created_at) VALUES ($1,$2,$3,$4)', [noteId, taskId, 'Portable backup note', now]);
    await query(
      'INSERT INTO task_note_files (id,note_id,name,mime_type,size,file_path,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [fileId, noteId, 'proof.txt', 'text/plain', 27, sourceFile, now],
    );
  });

  afterAll(async () => {
    if (routeBackupName) {
      await fetch(`${baseUrl}/api/backups/portable/${encodeURIComponent(routeBackupName)}`, { method: 'DELETE' }).catch(() => undefined);
    }
    const { query } = await import('../db.js');
    await query('DELETE FROM tasks WHERE id=$1', [taskId]).catch(() => undefined);
    await query('DELETE FROM goals WHERE id=$1', [goalId]).catch(() => undefined);
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true });
    await stopTestServer();
  });

  it('contains every table, portable file references, actual file bytes, and valid checksums', async () => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', chunk => chunks.push(Buffer.from(chunk)));

    const created = await createPortableBackupArchive(output);
    const archive = Buffer.concat(chunks);
    expect(created.bytes).toBe(archive.length);
    await fsp.writeFile(archiveFile, archive);

    const verified = await verifyPortableBackup(archiveFile);
    expect(verified.manifest.complete).toBe(true);
    expect(verified.manifest.database.tables.some(table => table.name === 'goals')).toBe(true);
    const storedFile = verified.manifest.files.find(file => file.id === fileId);
    expect(storedFile).toMatchObject({
      kind: 'task_note_file',
      original_name: 'proof.txt',
      bytes: 27,
    });

    const entryByPath = new Map(verified.directory.files.map(entry => [entry.path, entry]));
    expect((await entryByPath.get(storedFile!.archive_path)!.buffer()).toString('utf8')).toBe('portable backup file proof\n');

    const table = verified.manifest.database.tables.find(item => item.name === 'task_note_files')!;
    const rows = (await entryByPath.get(table.archive_path)!.buffer()).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    const exported = rows.find(row => row.id === fileId);
    expect(exported.file_path).toBe(`backup://${storedFile!.archive_path}`);
  }, 60_000);

  it('creates, lists, downloads, and explicitly deletes a complete backup through the protected API', async () => {
    const createResponse = await fetch(`${baseUrl}/api/backups/portable`, { method: 'POST' });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json() as {
      filename: string;
      file_count: number;
      row_count: number;
      download_url: string;
      storage: string;
    };
    routeBackupName = created.filename;
    expect(created).toMatchObject({ file_count: expect.any(Number), row_count: expect.any(Number), storage: 'local' });

    const listResponse = await fetch(`${baseUrl}/api/backups`);
    expect(listResponse.status).toBe(200);
    const listing = await listResponse.json() as { portable_backups: Array<{ name: string }> };
    expect(listing.portable_backups.some(item => item.name === routeBackupName)).toBe(true);

    const downloadResponse = await fetch(`${baseUrl}${created.download_url}`);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get('content-type')).toMatch(/application\/(zip|octet-stream)/);
    expect((await downloadResponse.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    const deleteResponse = await fetch(`${baseUrl}/api/backups/portable/${encodeURIComponent(routeBackupName)}`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(200);
    routeBackupName = '';
  }, 60_000);
});
