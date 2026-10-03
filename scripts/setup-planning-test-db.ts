import pg from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { PLANNING_TEST_MARKER } from '../audits/planning/databaseFixtures.js';

const url = new URL(process.env.PLANNING_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres');
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Only a local test cluster is allowed');
const admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
await admin.connect();
const name = 'marina_planning_test_p00';
try {
  const result = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [name]);
  if (result.rowCount && result.rows[0].marker !== PLANNING_TEST_MARKER) throw new Error('Existing database is not marked disposable; refusing reuse');
  if (!result.rowCount) {
    await admin.query('CREATE DATABASE marina_planning_test_p00');
    await admin.query("COMMENT ON DATABASE marina_planning_test_p00 IS 'marina:p00:disposable'");
  }
  url.pathname = `/${name}`;
  await mkdir('tmp', { recursive: true });
  await writeFile('tmp/planning-test.env', `DATABASE_URL_TEST=${JSON.stringify(url.href)}\nPLANNING_TEST_DB=1\n`);
  console.log(JSON.stringify({ ready: true, database: name, local: true, marker_verified: true }));
} finally { await admin.end(); }
