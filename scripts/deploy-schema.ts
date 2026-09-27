import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import pg from 'pg';

const { Pool } = pg;

if (process.env.CONFIRM_SCHEMA_APPLY !== '1') {
  console.error('[schema] Refusing to modify a database. Re-run with CONFIRM_SCHEMA_APPLY=1 after creating and verifying a backup.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('[schema] DATABASE_URL is required');
  process.exit(1);
}

const schema = await fs.readFile(path.resolve('server/schema.sql'), 'utf8');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('marina-schema-deploy'))");
    await client.query(schema);
    const { rows } = await client.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM schema_migrations');
    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, seeded: false, migrations_recorded: rows[0]?.count ?? 0 }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
} catch (err) {
  console.error('[schema] apply failed and was rolled back:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
