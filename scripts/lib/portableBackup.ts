import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import * as unzipper from 'unzipper';
import { LEGACY_BACKUP_FORMAT } from '../../server/utils/brandCompatibility.js';
import {
  PORTABLE_BACKUP_FORMAT,
  PORTABLE_BACKUP_VERSION,
  type PortableBackupManifest,
} from '../../server/services/portableBackup.js';

const SAFE_ARCHIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\u0000]+$/;
const SAFE_TABLE = /^[a-z_][a-z0-9_]*$/;

export interface VerifiedPortableBackup {
  archive_path: string;
  archive_bytes: number;
  manifest: PortableBackupManifest;
  directory: unzipper.CentralDirectory;
}

function isManifest(value: unknown): value is PortableBackupManifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PortableBackupManifest>;
  return (candidate.format === PORTABLE_BACKUP_FORMAT || candidate.format === LEGACY_BACKUP_FORMAT)
    && candidate.version === PORTABLE_BACKUP_VERSION
    && candidate.complete === true
    && typeof candidate.created_at === 'string'
    && Boolean(candidate.database)
    && Array.isArray(candidate.database?.tables)
    && Array.isArray(candidate.files);
}

async function inspectEntry(entry: unzipper.File): Promise<{ bytes: number; sha256: string; lines: number }> {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let lines = 0;
  for await (const raw of entry.stream()) {
    const chunk = raw as Buffer;
    bytes += chunk.length;
    hash.update(chunk);
    for (const byte of chunk) if (byte === 10) lines++;
  }
  return { bytes, sha256: hash.digest('hex'), lines };
}

export async function verifyPortableBackup(archivePath: string): Promise<VerifiedPortableBackup> {
  const fullPath = path.resolve(archivePath);
  const stat = await fs.stat(fullPath);
  if (!stat.isFile()) throw new Error(`Backup path is not a file: ${fullPath}`);

  const directory = await unzipper.Open.file(fullPath);
  const entries = new Map<string, unzipper.File>();
  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;
    if (!SAFE_ARCHIVE_PATH.test(entry.path)) throw new Error(`Unsafe path inside backup: ${entry.path}`);
    if (entries.has(entry.path)) throw new Error(`Duplicate path inside backup: ${entry.path}`);
    entries.set(entry.path, entry);
  }

  const manifestEntry = entries.get('manifest.json');
  if (!manifestEntry) throw new Error('Backup is incomplete: manifest.json is missing');
  if (manifestEntry.uncompressedSize > 10 * 1024 * 1024) throw new Error('Backup manifest is implausibly large');
  let parsed: unknown;
  try {
    parsed = JSON.parse((await manifestEntry.buffer()).toString('utf8'));
  } catch {
    throw new Error('Backup manifest is not valid JSON');
  }
  if (!isManifest(parsed)) throw new Error('Unsupported or incomplete Marina backup manifest');
  const manifest = parsed;

  const expectedPaths = new Set(['README.txt', 'manifest.json']);
  const expectedEntries: Array<{
    archive_path: string;
    bytes: number;
    sha256: string;
    row_count?: number;
  }> = [manifest.database.schema, ...manifest.database.tables, ...manifest.files];
  for (const expected of expectedEntries) {
    if (!SAFE_ARCHIVE_PATH.test(expected.archive_path)) throw new Error(`Unsafe path in manifest: ${expected.archive_path}`);
    if (expectedPaths.has(expected.archive_path)) throw new Error(`Duplicate path in manifest: ${expected.archive_path}`);
    expectedPaths.add(expected.archive_path);
    const entry = entries.get(expected.archive_path);
    if (!entry) throw new Error(`Backup is incomplete: ${expected.archive_path} is missing`);
    const actual = await inspectEntry(entry);
    if (actual.bytes !== expected.bytes) {
      throw new Error(`Size mismatch for ${expected.archive_path}: expected ${expected.bytes}, got ${actual.bytes}`);
    }
    if (actual.sha256 !== expected.sha256) throw new Error(`Checksum mismatch for ${expected.archive_path}`);
    if (expected.row_count !== undefined && actual.lines !== expected.row_count) {
      throw new Error(`Row-count mismatch for ${expected.archive_path}: expected ${expected.row_count}, got ${actual.lines}`);
    }
  }

  for (const table of manifest.database.tables) {
    if (!SAFE_TABLE.test(table.name)) throw new Error(`Unsafe table name in manifest: ${table.name}`);
    if (table.archive_path !== `database/tables/${table.name}.jsonl`) {
      throw new Error(`Unexpected data path for table ${table.name}`);
    }
  }
  const extra = [...entries.keys()].filter(entry => !expectedPaths.has(entry));
  if (extra.length) throw new Error(`Backup contains unlisted entries: ${extra.join(', ')}`);

  const totalRows = manifest.database.tables.reduce((sum, table) => sum + table.row_count, 0);
  if (manifest.database.total_rows !== totalRows) throw new Error('Manifest total row count is inconsistent');
  const totalFileBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  if (manifest.total_files !== manifest.files.length || manifest.total_file_bytes !== totalFileBytes) {
    throw new Error('Manifest file totals are inconsistent');
  }

  return { archive_path: fullPath, archive_bytes: stat.size, manifest, directory };
}

export function quoteIdentifier(value: string): string {
  if (!SAFE_TABLE.test(value)) throw new Error(`Unsafe database identifier: ${value}`);
  return `"${value.replace(/"/g, '""')}"`;
}
