import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { del, put } from '@vercel/blob';

const { Pool } = pg;
const apply = process.env.CONFIRM_STORAGE_MIGRATION === '1';
const privateBlob = /^https:\/\/[a-z0-9-]+\.private\.blob\.vercel-storage\.com\//i;

if (!process.env.DATABASE_URL) {
  console.error('[storage] DATABASE_URL is required');
  process.exit(1);
}
if (apply && !process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('[storage] BLOB_READ_WRITE_TOKEN is required when CONFIRM_STORAGE_MIGRATION=1');
  process.exit(1);
}

function safeName(value: string): string {
  return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180) || 'file.bin';
}

function contentType(name: string, stored?: string | null): string {
  if (stored) return stored;
  const map: Record<string, string> = {
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  };
  return map[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

type StoredRow = { kind: 'resource' | 'task_note_file'; id: string; name: string; mime_type: string | null; file_path: string };
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });

try {
  const { rows } = await pool.query<StoredRow>(`
    SELECT 'resource'::text AS kind, id, COALESCE(title, id) AS name, NULL::text AS mime_type, file_path
      FROM resources WHERE file_path IS NOT NULL
    UNION ALL
    SELECT 'task_note_file'::text AS kind, id, name, mime_type, file_path
      FROM task_note_files WHERE file_path IS NOT NULL
    ORDER BY kind, id
  `);
  const pending = rows.filter(row => !privateBlob.test(row.file_path));
  const missing = pending.filter(row => !fs.existsSync(row.file_path));
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    already_private_blob: rows.length - pending.length,
    pending_local_files: pending.length,
    missing_local_files: missing.map(row => ({ kind: row.kind, id: row.id })),
  }, null, 2));

  if (!apply) {
    console.log('[storage] Dry run only. Set CONFIRM_STORAGE_MIGRATION=1 after verifying this list and the target DATABASE_URL.');
  } else if (missing.length) {
    throw new Error('Migration stopped because one or more referenced local files are missing');
  } else {
    let migrated = 0;
    for (const row of pending) {
      const filename = safeName(row.name + (path.extname(row.name) ? '' : path.extname(row.file_path)));
      const blob = await put(`marina/migrated/${row.kind}/${row.id}-${filename}`, fs.createReadStream(row.file_path), {
        access: 'private',
        addRandomSuffix: true,
        contentType: contentType(filename, row.mime_type),
      });
      try {
        let updated;
        if (row.kind === 'resource') {
          updated = await pool.query('UPDATE resources SET file_path=$1, url=$2 WHERE id=$3 AND file_path=$4', [blob.url, `/api/resources/blob/${row.id}`, row.id, row.file_path]);
        } else {
          updated = await pool.query('UPDATE task_note_files SET file_path=$1 WHERE id=$2 AND file_path=$3', [blob.url, row.id, row.file_path]);
        }
        if (updated.rowCount !== 1) throw new Error(`Database row changed during migration (${row.kind}:${row.id})`);
        migrated++;
      } catch (err) {
        await del(blob.url).catch(() => undefined);
        throw err;
      }
    }
    console.log(JSON.stringify({ ok: true, migrated, local_files_deleted: 0 }));
  }
} catch (err) {
  console.error('[storage] migration failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
