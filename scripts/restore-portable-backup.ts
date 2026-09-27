import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { pipeline } from 'stream/promises';
import pg from 'pg';
import { del, put } from '@vercel/blob';
import type * as unzipper from 'unzipper';
import { quoteIdentifier, verifyPortableBackup } from './lib/portableBackup.js';

const { Pool } = pg;
const archivePath = process.argv[2];
const targetUrl = process.env.TARGET_DATABASE_URL;
const storageMode = process.env.RESTORE_STORAGE ?? 'local';

function refuse(message: string): never {
  console.error(`[backup:restore] Refusing to restore: ${message}`);
  process.exit(1);
}

if (!archivePath) refuse('pass the .marina-backup.zip path after --');
if (process.env.CONFIRM_PORTABLE_RESTORE !== '1') {
  refuse('set CONFIRM_PORTABLE_RESTORE=1 after selecting a fresh target database');
}
if (!targetUrl) refuse('TARGET_DATABASE_URL is required');
if (storageMode !== 'local' && storageMode !== 'blob') refuse('RESTORE_STORAGE must be local or blob');
if (storageMode === 'blob' && !process.env.BLOB_READ_WRITE_TOKEN) {
  refuse('BLOB_READ_WRITE_TOKEN is required when RESTORE_STORAGE=blob');
}

function databaseIdentity(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || 'default'}${url.pathname}`;
  } catch {
    return value.replace(/:[^:@/]+@/, ':***@').split('?')[0];
  }
}

if (process.env.DATABASE_URL
  && databaseIdentity(process.env.DATABASE_URL) === databaseIdentity(targetUrl)
  && process.env.ALLOW_RESTORE_OVER_SOURCE !== '1') {
  refuse('TARGET_DATABASE_URL points to DATABASE_URL; use a new database (or explicitly set ALLOW_RESTORE_OVER_SOURCE=1)');
}

function quoteDatabaseIdentifier(value: string): string {
  if (!value || value.includes('\u0000')) throw new Error('Unsafe database identifier');
  return `"${value.replace(/"/g, '""')}"`;
}

function entryMap(directory: unzipper.CentralDirectory): Map<string, unzipper.File> {
  return new Map(directory.files.filter(entry => entry.type === 'File').map(entry => [entry.path, entry]));
}

async function existingRows(client: pg.PoolClient): Promise<number> {
  const { rows } = await client.query<{ name: string }>(`
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind IN ('r', 'p')
  `);
  let total = 0;
  for (const row of rows) {
    if (!/^[a-z_][a-z0-9_]*$/.test(row.name)) continue;
    const count = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM public.${quoteIdentifier(row.name)}`);
    total += Number(count.rows[0]?.count ?? 0);
  }
  return total;
}

async function copyFileLocally(entry: unzipper.File, root: string, archiveFilePath: string): Promise<string> {
  const relative = archiveFilePath.replace(/^files\//, '');
  const destination = path.resolve(root, relative);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (!destination.startsWith(rootPrefix)) throw new Error(`Unsafe restore file path: ${archiveFilePath}`);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try {
    await pipeline(entry.stream(), fs.createWriteStream(destination, { flags: 'wx' }));
  } catch (error) {
    await fsp.unlink(destination).catch(() => undefined);
    throw error;
  }
  return destination;
}

const uploadedDuringRestore: string[] = [];
const localFilesCreatedDuringRestore: string[] = [];

try {
  console.log('[backup:restore] Verifying every checksum before connecting to the target database...');
  const verified = await verifyPortableBackup(archivePath);
  const { manifest, directory } = verified;
  const entries = entryMap(directory);
  const schema = (await entries.get(manifest.database.schema.archive_path)!.buffer()).toString('utf8');
  const pool = new Pool({ connectionString: targetUrl, max: 1, connectionTimeoutMillis: 10_000 });
  const client = await pool.connect();
  const restoredRoot = path.resolve(
    process.env.RESTORE_FILES_DIR
      ?? path.join('server', 'uploads', `restored-${manifest.created_at.replace(/[:.]/g, '-')}`),
  );
  let transactionOpen = false;

  try {
    const beforeRows = await existingRows(client);
    if (beforeRows > 0 && process.env.CONFIRM_REPLACE_TARGET !== '1') {
      throw new Error(`Target database already contains ${beforeRows} rows; use a fresh database or explicitly set CONFIRM_REPLACE_TARGET=1`);
    }

    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext('marina-portable-restore'))");
    await client.query(schema);

    const tableNames = manifest.database.tables.map(table => table.name);
    const tableSet = new Set(tableNames);
    const { rows: foreignKeys } = await client.query<{
      table_name: string;
      constraint_name: string;
      definition: string;
    }>(`
      SELECT c.relname AS table_name,
             con.conname AS constraint_name,
             pg_get_constraintdef(con.oid, true) AS definition
        FROM pg_constraint con
        JOIN pg_class c ON c.oid=con.conrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND con.contype='f'
       ORDER BY c.relname, con.conname
    `);
    for (const key of foreignKeys.filter(key => tableSet.has(key.table_name))) {
      await client.query(
        `ALTER TABLE public.${quoteIdentifier(key.table_name)} DROP CONSTRAINT ${quoteDatabaseIdentifier(key.constraint_name)}`,
      );
    }

    if (tableNames.length) {
      await client.query(`TRUNCATE TABLE ${tableNames.map(name => `public.${quoteIdentifier(name)}`).join(', ')} CASCADE`);
    }

    for (const table of manifest.database.tables) {
      const entry = entries.get(table.archive_path)!;
      const lines = readline.createInterface({ input: entry.stream(), crlfDelay: Infinity });
      let inserted = 0;
      for await (const line of lines) {
        if (!line) continue;
        await client.query(
          `INSERT INTO public.${quoteIdentifier(table.name)} SELECT * FROM json_populate_record(NULL::public.${quoteIdentifier(table.name)}, $1::json)`,
          [line],
        );
        inserted++;
      }
      if (inserted !== table.row_count) throw new Error(`Restore row count changed while loading ${table.name}`);
      console.log(`[backup:restore] ${table.name}: ${inserted} rows`);
    }

    const restoreStamp = manifest.created_at.replace(/[:.]/g, '-');
    for (const file of manifest.files) {
      const entry = entries.get(file.archive_path)!;
      let storedReference: string;
      if (storageMode === 'blob') {
        const blob = await put(`marina/restored/${restoreStamp}/${file.archive_path.replace(/^files\//, '')}`, entry.stream(), {
          access: 'private',
          addRandomSuffix: false,
          contentType: file.mime_type ?? 'application/octet-stream',
          cacheControlMaxAge: 60,
          multipart: true,
        });
        storedReference = blob.url;
        uploadedDuringRestore.push(blob.url);
      } else {
        storedReference = await copyFileLocally(entry, restoredRoot, file.archive_path);
        localFilesCreatedDuringRestore.push(storedReference);
      }
      if (file.kind === 'resource') {
        const updated = await client.query(
          'UPDATE resources SET file_path=$1, url=$2 WHERE id=$3',
          [storedReference, `/api/resources/blob/${file.id}`, file.id],
        );
        if (updated.rowCount !== 1) throw new Error(`Resource file row not found during restore: ${file.id}`);
      } else {
        const updated = await client.query('UPDATE task_note_files SET file_path=$1 WHERE id=$2', [storedReference, file.id]);
        if (updated.rowCount !== 1) throw new Error(`Task-note file row not found during restore: ${file.id}`);
      }
    }

    for (const key of foreignKeys.filter(key => tableSet.has(key.table_name))) {
      await client.query(
        `ALTER TABLE public.${quoteIdentifier(key.table_name)} ADD CONSTRAINT ${quoteDatabaseIdentifier(key.constraint_name)} ${key.definition}`,
      );
    }

    for (const table of manifest.database.tables) {
      const count = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.${quoteIdentifier(table.name)}`,
      );
      const actual = Number(count.rows[0]?.count ?? 0);
      if (actual !== table.row_count) throw new Error(`Final count mismatch for ${table.name}: expected ${table.row_count}, got ${actual}`);
    }

    await client.query('COMMIT');
    transactionOpen = false;
    console.log(JSON.stringify({
      ok: true,
      target_database: databaseIdentity(targetUrl),
      tables: manifest.database.tables.length,
      rows: manifest.database.total_rows,
      files: manifest.total_files,
      storage: storageMode,
      local_files_dir: storageMode === 'local' ? restoredRoot : null,
      checksums: 'verified before restore',
      counts: 'verified before commit',
    }, null, 2));
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    if (uploadedDuringRestore.length) {
      await del(uploadedDuringRestore).catch(() => undefined);
    }
    for (const localFile of localFilesCreatedDuringRestore) {
      await fsp.unlink(localFile).catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
} catch (error) {
  console.error(`[backup:restore] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
