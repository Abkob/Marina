/** Back up explicitly selected production data, then apply ONLY the additive routine migration. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

const envFile = process.argv[2];
if (!envFile || !fs.existsSync(envFile)) throw new Error('Pass an explicit environment file downloaded from the target Vercel project.');
const targetEnv = dotenv.parse(await fsp.readFile(path.resolve(envFile)));
if (!targetEnv.DATABASE_URL) throw new Error('The selected environment has no DATABASE_URL.');
// Set before dynamic imports; never silently fall back to a local .env or local database.
Object.assign(process.env, targetEnv);
const apply = process.argv.includes('--apply');
if (apply && process.env.CONFIRM_ROUTINES_MIGRATION !== '1') throw new Error('Set CONFIRM_ROUTINES_MIGRATION=1 to authorize the additive migration.');

const { createPortableBackupArchive } = await import('../server/services/portableBackup.js');
const { verifyPortableBackup } = await import('./lib/portableBackup.js');
const { getPool } = await import('../server/db.js');
const destination = path.resolve('backups', `amina-before-routines-${new Date().toISOString().replace(/:/g, '-')}-${crypto.randomBytes(4).toString('hex')}.amina-backup.zip`);
await fsp.mkdir(path.dirname(destination), { recursive: true });

try {
  await createPortableBackupArchive(fs.createWriteStream(destination, { flags: 'wx' }));
  const verified = await verifyPortableBackup(destination);
  console.log(JSON.stringify({ backup: destination, checksums: 'verified', tables: verified.manifest.database.tables.length, rows: verified.manifest.database.total_rows }));
  if (apply) {
    const sql = await fsp.readFile(path.resolve('server/migrations/024-routines.sql'), 'utf8');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('amina-schema-deploy'))");
      // Short transaction protects the comparison from concurrent user changes.
      await client.query('LOCK TABLE goals, tasks, events, work_sessions IN SHARE MODE');
      const fingerprint = async () => {
        const result: Record<string, unknown> = {};
        for (const table of ['goals', 'tasks', 'events', 'work_sessions']) {
          const { rows } = await client.query(`SELECT COUNT(*)::int AS count, md5(COALESCE(string_agg((to_jsonb(t) - 'routine_id')::text, '' ORDER BY id), '')) AS fingerprint FROM ${table} t`);
          result[table] = rows[0];
        }
        return result;
      };
      const before = await fingerprint();
      await client.query(sql);
      const after = await fingerprint();
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Existing data changed during migration; rolling back.');
      await client.query('COMMIT');
      console.log(JSON.stringify({ applied: 'M-024-routines', existing_data: 'unchanged', counts: Object.fromEntries(Object.entries(after).map(([table, value]) => [table, (value as { count: number }).count])) }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
} finally { await getPool().end(); }
