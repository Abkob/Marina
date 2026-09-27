import * as archiver from 'archiver';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Transform, type Readable, type Writable } from 'stream';
import { finished } from 'stream/promises';
import QueryStream from 'pg-query-stream';
import type pg from 'pg';
import { getPool } from '../db.js';
import { openStoredFile } from './fileStorage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '..', 'schema.sql');
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const NON_PORTABLE_SECRET_TABLES = new Set(['google_sync_connections', 'google_sync_links']);

export const PORTABLE_BACKUP_FORMAT = 'marina-portable-backup' as const;
export const PORTABLE_BACKUP_VERSION = 1;

export interface PortableBackupTable {
  name: string;
  primary_key: string[];
  row_count: number;
  archive_path: string;
  bytes: number;
  sha256: string;
}

export interface PortableBackupFile {
  kind: 'resource' | 'task_note_file';
  id: string;
  original_name: string;
  mime_type: string | null;
  archive_path: string;
  bytes: number;
  sha256: string;
}

export interface PortableBackupManifest {
  format: typeof PORTABLE_BACKUP_FORMAT;
  version: number;
  complete: true;
  created_at: string;
  application: 'Marina OS';
  database: {
    name: string;
    postgres_version: string;
    snapshot: string;
    schema: { archive_path: string; bytes: number; sha256: string };
    tables: PortableBackupTable[];
    total_rows: number;
  };
  files: PortableBackupFile[];
  total_files: number;
  total_file_bytes: number;
}

interface StoredFileRow {
  kind: PortableBackupFile['kind'];
  id: string;
  original_name: string;
  mime_type: string | null;
  file_path: string;
  archive_path: string;
}

interface TableDefinition {
  name: string;
  primaryKey: string[];
}

export interface PortableBackupResult {
  manifest: PortableBackupManifest;
  bytes: number;
}

function quoteIdentifier(value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error(`Unsafe database identifier in backup: ${value}`);
  return `"${value.replace(/"/g, '""')}"`;
}

export function safeBackupFilename(value: string, fallback = 'file.bin'): string {
  const base = path.basename(value).normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 160);
  return base || fallback;
}

function extensionFromReference(reference: string): string {
  try {
    const pathname = new URL(reference).pathname;
    return path.extname(pathname).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 16);
  } catch {
    return path.extname(reference).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 16);
  }
}

function archiveFilePath(row: Omit<StoredFileRow, 'archive_path'>): string {
  const id = safeBackupFilename(row.id, 'unknown-id');
  let name = safeBackupFilename(row.original_name, `${row.kind}-${id}.bin`);
  if (!path.extname(name)) name += extensionFromReference(row.file_path);
  return `files/${row.kind === 'resource' ? 'resources' : 'task-note-files'}/${id}/${name}`;
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readmeText(createdAt: string): string {
  return `Marina OS complete portable backup\n+
Created: ${createdAt}\n+
This ZIP contains:\n+
- database/schema.sql: the PostgreSQL/pgvector schema\n+
- database/tables/*.jsonl: every row from every public application table\n+
- files/: every Resource and task-note attachment referenced by the database\n+
- manifest.json: counts and SHA-256 checksums for verification\n+
The database export was taken in one PostgreSQL REPEATABLE READ, READ ONLY\n+
transaction. File references inside the exported resources and task_note_files\n+
rows use backup:// paths that point to the corresponding files in this ZIP.\n+
Keep this archive private: it contains the full workspace and may contain\n+
personal text and documents.\n+
Google OAuth tokens and remote sync IDs are intentionally excluded. Reconnect\n+
Google after a restore so credentials never travel inside a portable backup.\n+
Verify without changing a database:\n+
  npm run backup:verify -- <path-to-this-zip>\n+
Restore only into a fresh target database after reading README.md:\n+
  $env:TARGET_DATABASE_URL='<fresh-target-url>'\n+
  $env:CONFIRM_PORTABLE_RESTORE='1'\n+
  npm run backup:restore -- <path-to-this-zip>\n+
The restore command verifies all checksums before making changes.\n`;
}

async function appendEntry(
  archive: archiver.Archiver,
  name: string,
  source: Buffer | string | Readable,
  date: Date,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = typeof source === 'object' && !Buffer.isBuffer(source) && 'once' in source ? source : null;
    const cleanup = () => {
      archive.off('entry', onEntry);
      archive.off('error', onError);
      stream?.off('error', onError);
    };
    const onEntry = (entry: archiver.EntryData) => {
      if (entry.name !== name) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    archive.on('entry', onEntry);
    archive.on('error', onError);
    stream?.on('error', onError);
    archive.append(source, { name, date });
  });
}

async function getTableDefinitions(client: pg.PoolClient): Promise<TableDefinition[]> {
  const { rows } = await client.query<{ name: string; primary_key: string[] | null }>(`
    SELECT c.relname AS name,
           COALESCE((
             SELECT json_agg(a.attname ORDER BY key_columns.ordinality)
             FROM pg_index i
             CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
             JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key_columns.attnum
             WHERE i.indrelid=c.oid AND i.indisprimary
           ), '[]'::json) AS primary_key
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind IN ('r', 'p')
     ORDER BY c.relname
  `);
  return rows.map(row => ({ name: row.name, primaryKey: row.primary_key ?? [] }));
}

async function getStoredFiles(client: pg.PoolClient): Promise<StoredFileRow[]> {
  const { rows } = await client.query<Omit<StoredFileRow, 'archive_path'>>(`
    SELECT 'resource'::text AS kind,
           id,
           COALESCE(NULLIF(title, ''), id) AS original_name,
           NULL::text AS mime_type,
           file_path
      FROM resources
     WHERE file_path IS NOT NULL
    UNION ALL
    SELECT 'task_note_file'::text AS kind,
           id,
           name AS original_name,
           mime_type,
           file_path
      FROM task_note_files
     WHERE file_path IS NOT NULL
    ORDER BY kind, id
  `);
  return rows.map(row => ({ ...row, archive_path: archiveFilePath(row) }));
}

function portableRow(tableName: string, raw: string, fileRows: Map<string, StoredFileRow>): string {
  if (tableName !== 'resources' && tableName !== 'task_note_files') return raw;
  const row = JSON.parse(raw) as Record<string, unknown>;
  const kind = tableName === 'resources' ? 'resource' : 'task_note_file';
  const file = fileRows.get(`${kind}:${String(row.id)}`);
  if (file && row.file_path) row.file_path = `backup://${file.archive_path}`;
  return JSON.stringify(row);
}

async function appendTable(
  archive: archiver.Archiver,
  client: pg.PoolClient,
  table: TableDefinition,
  files: Map<string, StoredFileRow>,
  date: Date,
): Promise<PortableBackupTable> {
  const tableName = quoteIdentifier(table.name);
  const order = table.primaryKey.length
    ? ` ORDER BY ${table.primaryKey.map(quoteIdentifier).join(', ')}`
    : '';
  const queryStream = client.query(new QueryStream(
    `SELECT row_to_json(t)::text AS row_json FROM public.${tableName} AS t${NON_PORTABLE_SECRET_TABLES.has(table.name) ? ' WHERE FALSE' : ''}${order}`,
    [],
    { batchSize: 100 },
  )) as Readable;
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let rowCount = 0;
  const jsonl = new Transform({
    writableObjectMode: true,
    transform(chunk: { row_json: string }, _encoding, callback) {
      try {
        const line = `${portableRow(table.name, chunk.row_json, files)}\n`;
        const buffer = Buffer.from(line);
        rowCount++;
        bytes += buffer.length;
        hash.update(buffer);
        callback(null, buffer);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  queryStream.pipe(jsonl);
  const archivePath = `database/tables/${table.name}.jsonl`;
  await appendEntry(archive, archivePath, jsonl, date);
  return {
    name: table.name,
    primary_key: table.primaryKey,
    row_count: rowCount,
    archive_path: archivePath,
    bytes,
    sha256: hash.digest('hex'),
  };
}

async function appendStoredFile(
  archive: archiver.Archiver,
  row: StoredFileRow,
  date: Date,
): Promise<PortableBackupFile> {
  const opened = await openStoredFile(row.file_path);
  if (!opened) {
    throw new Error(`Complete backup aborted: stored file is missing (${row.kind} ${row.id}, ${row.original_name})`);
  }
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const hashingStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  opened.stream.pipe(hashingStream);
  await appendEntry(archive, row.archive_path, hashingStream, date);
  if (typeof opened.size === 'number' && opened.size !== bytes) {
    throw new Error(`Complete backup aborted: file changed while reading (${row.original_name})`);
  }
  return {
    kind: row.kind,
    id: row.id,
    original_name: row.original_name,
    mime_type: row.mime_type ?? opened.contentType,
    archive_path: row.archive_path,
    bytes,
    sha256: hash.digest('hex'),
  };
}

/**
 * Writes one self-contained ZIP to output. The database portion is read from a
 * single repeatable-read snapshot. A missing or changing attachment fails the
 * whole operation, so a successful archive never silently omits a known file.
 */
export async function createPortableBackupArchive(output: Writable): Promise<PortableBackupResult> {
  const createdAt = new Date().toISOString();
  const entryDate = new Date(createdAt);
  const archive = new archiver.ZipArchive({ zlib: { level: 6 } });
  archive.pipe(output);
  const outputDone = finished(output);
  void outputDone.catch(() => undefined);
  const failOutput = (error: Error) => output.destroy(error);
  const failArchive = (error: Error) => archive.destroy(error);
  archive.on('error', failOutput);
  archive.on('warning', failOutput);
  output.on('error', failArchive);

  const client = await getPool().connect();
  let transactionOpen = false;
  let databaseName = '';
  let postgresVersion = '';
  let snapshot = '';
  let tableResults: PortableBackupTable[] = [];
  let storedFiles: StoredFileRow[] = [];

  try {
    const schema = await fs.readFile(SCHEMA_PATH);
    const schemaEntry = {
      archive_path: 'database/schema.sql',
      bytes: schema.length,
      sha256: sha256(schema),
    };
    await appendEntry(archive, 'README.txt', readmeText(createdAt), entryDate);
    await appendEntry(archive, schemaEntry.archive_path, schema, entryDate);

    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionOpen = true;
    const metadata = await client.query<{
      database_name: string;
      postgres_version: string;
      snapshot: string;
    }>(`
      SELECT current_database() AS database_name,
             current_setting('server_version') AS postgres_version,
             txid_current_snapshot()::text AS snapshot
    `);
    databaseName = metadata.rows[0]?.database_name ?? 'unknown';
    postgresVersion = metadata.rows[0]?.postgres_version ?? 'unknown';
    snapshot = metadata.rows[0]?.snapshot ?? 'unknown';

    const tableDefinitions = await getTableDefinitions(client);
    storedFiles = await getStoredFiles(client);
    const fileMap = new Map(storedFiles.map(row => [`${row.kind}:${row.id}`, row]));
    for (const table of tableDefinitions) {
      tableResults.push(await appendTable(archive, client, table, fileMap, entryDate));
    }
    await client.query('COMMIT');
    transactionOpen = false;

    const fileResults: PortableBackupFile[] = [];
    for (const storedFile of storedFiles) {
      fileResults.push(await appendStoredFile(archive, storedFile, entryDate));
    }

    const manifest: PortableBackupManifest = {
      format: PORTABLE_BACKUP_FORMAT,
      version: PORTABLE_BACKUP_VERSION,
      complete: true,
      created_at: createdAt,
      application: 'Marina OS',
      database: {
        name: databaseName,
        postgres_version: postgresVersion,
        snapshot,
        schema: schemaEntry,
        tables: tableResults,
        total_rows: tableResults.reduce((sum, table) => sum + table.row_count, 0),
      },
      files: fileResults,
      total_files: fileResults.length,
      total_file_bytes: fileResults.reduce((sum, file) => sum + file.bytes, 0),
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await appendEntry(archive, 'manifest.json', manifestText, entryDate);
    await archive.finalize();
    await outputDone;
    return { manifest, bytes: archive.pointer() };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    archive.abort();
    output.destroy(error as Error);
    await outputDone.catch(() => undefined);
    throw error;
  } finally {
    archive.off('error', failOutput);
    archive.off('warning', failOutput);
    output.off('error', failArchive);
    client.release();
  }
}
