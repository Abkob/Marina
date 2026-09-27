import { Router } from 'express';
import { execFile, execFileSync } from 'child_process';
import crypto from 'crypto';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PassThrough } from 'stream';
import { BlobNotFoundError, del, head, issueSignedToken, list, presignUrl, put } from '@vercel/blob';
import { LEGACY_BACKUP_PREFIX, legacyBackupName, marinaBackupName } from '../utils/brandCompatibility.js';
import { canUseLocalPersistence, isBlobStorageConfigured, isVercelRuntime } from '../runtime.js';
import { createPortableBackupArchive } from '../services/portableBackup.js';

const execFileAsync = promisify(execFile);
const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Project-root /backups — the same directory manual pg_dump backups live in.
export const BACKUPS_DIR = path.resolve(__dirname, '..', '..', 'backups');
const KEEP_LAST = Number(process.env.MARINA_BACKUP_KEEP ?? 14);
const PORTABLE_PREFIX = 'marina/backups/portable/';

// pg_dump discovery: explicit env override, then known install paths (verified
// on disk), then bare 'pg_dump' only as a last resort (PATH may not have it).
function findPgDump(): string | null {
  if (process.env.PG_DUMP_PATH && fs.existsSync(process.env.PG_DUMP_PATH)) return process.env.PG_DUMP_PATH;
  for (const v of ['18', '17', '16', '15']) {
    const p = `C:\\Program Files\\PostgreSQL\\${v}\\bin\\pg_dump.exe`;
    if (fs.existsSync(p)) return p;
  }
  try {
    // Verify bare pg_dump actually resolves before trusting it
    execFileSync('pg_dump', ['--version'], { timeout: 5000, stdio: 'ignore' });
    return 'pg_dump';
  } catch {
    return null;
  }
}

function dbUrl(): string {
  return process.env.DATABASE_URL ?? 'postgresql://postgres:pgadmin@localhost:5433/marina';
}

const SAFE_NAME = /^[a-zA-Z0-9._-]+\.dump$/;
const SAFE_PORTABLE_NAME = /^marina-complete-[a-zA-Z0-9._-]+\.marina-backup\.zip$/;

function newPortableName(): string {
  const stamp = new Date().toISOString().replace(/[:]/g, '-');
  return `marina-complete-${stamp}-${crypto.randomBytes(4).toString('hex')}.marina-backup.zip`;
}

function portablePath(name: string): string {
  if (!SAFE_PORTABLE_NAME.test(name)) throw Object.assign(new Error('invalid portable backup name'), { status: 400 });
  return `${PORTABLE_PREFIX}${name}`;
}

function localPortablePath(name: string): string {
  portablePath(name);
  const full = path.resolve(BACKUPS_DIR, name);
  if (path.dirname(full) !== BACKUPS_DIR) throw Object.assign(new Error('invalid portable backup path'), { status: 400 });
  return full;
}

function existingLocalPortablePath(name: string): string {
  const current = localPortablePath(name);
  return fs.existsSync(current) ? current : path.join(BACKUPS_DIR, legacyBackupName(name));
}

export async function existingCloudPortablePath(name: string): Promise<string> {
  const current = portablePath(name);
  try { await head(current); return current; }
  catch (error) {
    if (!(error instanceof BlobNotFoundError)) throw error;
    const legacy = `${LEGACY_BACKUP_PREFIX}${legacyBackupName(name)}`;
    await head(legacy);
    return legacy;
  }
}

async function fileSha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function signedPortableUrl(name: string): Promise<{ url: string; expires_at: string }> {
  if (!isBlobStorageConfigured()) throw Object.assign(new Error('Private Blob storage is not configured'), { status: 503 });
  const pathname = await existingCloudPortablePath(name);
  const validUntil = Date.now() + 10 * 60_000;
  const signedToken = await issueSignedToken({ pathname, operations: ['get'], validUntil });
  const { presignedUrl } = await presignUrl(signedToken, {
    operation: 'get',
    pathname,
    validUntil,
    access: 'private',
    useCache: false,
  });
  return { url: presignedUrl, expires_at: new Date(validUntil).toISOString() };
}

async function listPortableBackups() {
  if (!isVercelRuntime) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    return fs.readdirSync(BACKUPS_DIR)
      .filter(name => SAFE_PORTABLE_NAME.test(marinaBackupName(name)))
      .map(name => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, name));
        return { name: marinaBackupName(name), bytes: stat.size, created_at: stat.mtime.toISOString(), storage: 'local' as const };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  if (!isBlobStorageConfigured()) return [];
  const backups: Array<{ name: string; bytes: number; created_at: string; storage: 'private_blob' }> = [];
  for (const prefix of [PORTABLE_PREFIX, LEGACY_BACKUP_PREFIX]) {
   let cursor: string | undefined;
   do {
    const page = await list({ prefix, cursor, limit: 1000 });
    for (const blob of page.blobs) {
      const name = marinaBackupName(path.posix.basename(blob.pathname));
      if (SAFE_PORTABLE_NAME.test(name) && !backups.some(backup => backup.name === name)) {
        backups.push({ name, bytes: blob.size, created_at: blob.uploadedAt.toISOString(), storage: 'private_blob' });
      }
    }
    cursor = page.hasMore ? page.cursor : undefined;
   } while (cursor);
  }
  return backups.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function createLocalPortableBackup(name: string) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const finalPath = localPortablePath(name);
  const partialPath = `${finalPath}.partial`;
  const output = fs.createWriteStream(partialPath, { flags: 'wx' });
  try {
    const result = await createPortableBackupArchive(output);
    fs.renameSync(partialPath, finalPath);
    return {
      filename: name,
      bytes: fs.statSync(finalPath).size,
      sha256: await fileSha256(finalPath),
      table_count: result.manifest.database.tables.length,
      row_count: result.manifest.database.total_rows,
      file_count: result.manifest.total_files,
      file_bytes: result.manifest.total_file_bytes,
      storage: 'local' as const,
      download_url: `/api/backups/portable/${encodeURIComponent(name)}/download`,
      expires_at: null,
    };
  } catch (error) {
    try { fs.unlinkSync(partialPath); } catch { /* no partial archive to remove */ }
    throw error;
  }
}

async function createCloudPortableBackup(name: string) {
  if (!isBlobStorageConfigured()) {
    throw Object.assign(new Error('Create a private Vercel Blob store before downloading a complete cloud backup'), { status: 503 });
  }
  const pathname = portablePath(name);
  const archiveStream = new PassThrough();
  const upload = put(pathname, archiveStream, {
    access: 'private',
    addRandomSuffix: false,
    contentType: 'application/zip',
    cacheControlMaxAge: 60,
    multipart: true,
  }).catch(error => {
    archiveStream.destroy(error as Error);
    throw error;
  });
  const [result, blob] = await Promise.all([
    createPortableBackupArchive(archiveStream),
    upload,
  ]);
  const signed = await signedPortableUrl(name);
  return {
    filename: name,
    bytes: result.bytes,
    sha256: null,
    etag: blob.etag,
    table_count: result.manifest.database.tables.length,
    row_count: result.manifest.database.total_rows,
    file_count: result.manifest.total_files,
    file_bytes: result.manifest.total_file_bytes,
    storage: 'private_blob' as const,
    download_url: signed.url,
    expires_at: signed.expires_at,
  };
}

export async function createBackup(reason: string): Promise<{ file: string; bytes: number }> {
  if (!canUseLocalPersistence()) throw Object.assign(new Error('Local pg_dump backups are unavailable on Vercel; use managed database backups.'), { status: 409 });
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const pgDump = findPgDump();
  if (!pgDump) throw new Error('pg_dump not found — set PG_DUMP_PATH in .env');
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = `marina_${stamp}_${reason}.dump`;
  const full = path.join(BACKUPS_DIR, file);
  await execFileAsync(pgDump, ['-d', dbUrl(), '-F', 'c', '-f', full], { timeout: 120_000 });
  const bytes = fs.statSync(full).size;
  if (bytes < 1024) {
    fs.unlinkSync(full);
    throw new Error('Backup produced an implausibly small file — aborted and removed.');
  }
  return { file, bytes };
}

export function rotateBackups(): number {
  if (!canUseLocalPersistence()) return 0;
  if (!fs.existsSync(BACKUPS_DIR)) return 0;
  const files = fs.readdirSync(BACKUPS_DIR)
    .filter(f => SAFE_NAME.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  let removed = 0;
  for (const { f } of files.slice(KEEP_LAST)) {
    try { fs.unlinkSync(path.join(BACKUPS_DIR, f)); removed++; } catch { /* ignore */ }
  }
  return removed;
}

// GET /api/backups — list with sizes and dates, newest first
router.get('/', async (_req, res) => {
  const portableBackups = await listPortableBackups();
  if (!canUseLocalPersistence()) {
    const blobReady = isBlobStorageConfigured();
    return res.json({
      available: false,
      reason: 'Use managed PostgreSQL backups on Vercel',
      backups: [],
      portable_export: {
        available: blobReady,
        reason: blobReady ? null : 'Create a private Vercel Blob store first',
        storage: 'private_blob',
        includes_database: true,
        includes_files: true,
      },
      portable_backups: portableBackups,
    });
  }
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const files = fs.readdirSync(BACKUPS_DIR)
    .filter(f => SAFE_NAME.test(f))
    .map(f => {
      const st = fs.statSync(path.join(BACKUPS_DIR, f));
      return { name: f, bytes: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json({
    dir: BACKUPS_DIR,
    keep_last: KEEP_LAST,
    pg_dump_available: Boolean(findPgDump()),
    backups: files,
    portable_export: {
      available: true,
      reason: null,
      storage: 'local',
      includes_database: true,
      includes_files: true,
    },
    portable_backups: portableBackups,
  });
});

// POST /api/backups/portable — create one verified ZIP containing all public
// application tables plus every Resource/task-note file referenced by them.
router.post('/portable', async (_req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const name = newPortableName();
  const result = isVercelRuntime
    ? await createCloudPortableBackup(name)
    : await createLocalPortableBackup(name);
  res.json({ ok: true, ...result });
});

// GET /api/backups/portable/:name/download — local file response or a short-
// lived redirect that bypasses the Vercel Function 4.5 MB response limit.
router.get('/portable/:name/download', async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const name = req.params.name;
  if (!SAFE_PORTABLE_NAME.test(name)) return res.status(400).json({ error: 'invalid portable backup name' });
  if (isVercelRuntime) {
    const signed = await signedPortableUrl(name);
    return res.redirect(302, signed.url);
  }
  const full = existingLocalPortablePath(name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
  return res.download(full, name);
});

// DELETE /api/backups/portable/:name — explicit only; complete backups are
// never silently rotated because they are the user's disaster-recovery copy.
router.delete('/portable/:name', async (req, res) => {
  const name = req.params.name;
  if (!SAFE_PORTABLE_NAME.test(name)) return res.status(400).json({ error: 'invalid portable backup name' });
  if (isVercelRuntime) {
    if (!isBlobStorageConfigured()) return res.status(503).json({ error: 'Private Blob storage is not configured' });
    await del(await existingCloudPortablePath(name));
  } else {
    const full = existingLocalPortablePath(name);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
    fs.unlinkSync(full);
  }
  res.json({ ok: true });
});

// POST /api/backups — create one now
router.post('/', async (_req, res) => {
  const result = await createBackup('manual');
  const rotated = rotateBackups();
  res.json({ ok: true, ...result, rotated });
});

// DELETE /api/backups/:name
router.delete('/:name', async (req, res) => {
  if (!canUseLocalPersistence()) return res.status(409).json({ error: 'Local backups are unavailable on Vercel' });
  const name = req.params.name;
  if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'invalid backup name' });
  const full = path.join(BACKUPS_DIR, name);
  if (!path.resolve(full).startsWith(BACKUPS_DIR)) return res.status(400).json({ error: 'invalid path' });
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
  fs.unlinkSync(full);
  res.json({ ok: true });
});

// GET /api/backups/:name/download — stream the dump file
router.get('/:name/download', (req, res) => {
  if (!canUseLocalPersistence()) return res.status(409).json({ error: 'Local backups are unavailable on Vercel' });
  const name = req.params.name;
  if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'invalid backup name' });
  const full = path.join(BACKUPS_DIR, name);
  if (!path.resolve(full).startsWith(BACKUPS_DIR) || !fs.existsSync(full)) {
    return res.status(404).json({ error: 'not found' });
  }
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(full).pipe(res);
});

export { router as backupsRouter };
