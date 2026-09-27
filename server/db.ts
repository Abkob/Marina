import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { attachDatabasePool } from '@vercel/functions';
import { isProduction, isVercelRuntime } from './runtime.js';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test-mode safety guard: integration tests must use DATABASE_URL_TEST
// pointing at a database whose name contains 'test' to prevent accidental
// writes to the live marina database.
// The guard runs lazily on first DB use so unit-test imports don't fail.
function resolveConnectionString(): string {
  const isTest = process.env.NODE_ENV === 'test';
  if (isTest) {
    const testUrl = process.env.DATABASE_URL_TEST;
    if (!testUrl) {
      throw new Error(
        '[db] Integration tests require DATABASE_URL_TEST env var. ' +
        'Set it to a test database URL (e.g. postgresql://...@localhost:5433/marina_test). ' +
        'Do NOT point it at the live marina database.',
      );
    }
    // Enforce that the database name contains 'test' to prevent accidental live DB usage
    const dbName = testUrl.split('/').pop()?.split('?')[0] ?? '';
    if (!dbName.includes('test')) {
      throw new Error(
        `[db] DATABASE_URL_TEST database name must contain "test" (got: "${dbName}"). ` +
        'This guard prevents integration tests from running against the live database.',
      );
    }
    return testUrl;
  }
  const configured = process.env.DATABASE_URL;
  if (!configured && (isProduction || isVercelRuntime)) {
    throw new Error('[db] DATABASE_URL is required outside local development');
  }
  return configured ?? 'postgresql://postgres:pgadmin@localhost:5433/marina';
}

// Lazy pool: only created on first use so unit tests that import server modules
// but never call query/transaction/initSchema don't trigger the DB guard.
let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: resolveConnectionString(),
      // A serverless instance must not reserve 20 connections. Fluid Compute
      // may run many concurrent requests and many warm instances at once.
      max: Number(process.env.DATABASE_POOL_MAX ?? (isVercelRuntime ? 3 : 20)),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    if (isVercelRuntime) attachDatabasePool(_pool);
    _pool.on('error', (err) => {
      console.error('[db] Unexpected pool error:', err);
    });
  }
  return _pool;
}

// Keep named export for code that imports `pool` directly.
// Methods must run with the REAL pool as `this`, and writes must land on the
// real pool too — otherwise internal state mutations (e.g. `this.ending = true`
// inside pool.end()) hit the empty proxy target and end() hangs forever.
export const pool = new Proxy({} as pg.Pool, {
  get(_target, prop) {
    const real = getPool() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
  set(_target, prop, value) {
    (getPool() as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
});

// Run the schema on startup (idempotent — all CREATE IF NOT EXISTS)
export async function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const client = await getPool().connect();
  try {
    await client.query(sql);
    console.log('[db] Schema applied');
  } finally {
    client.release();
  }
}

// ─── Core query helper ────────────────────────────────────────────────────────

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(sql, params);
}

// ─── Transaction helper ───────────────────────────────────────────────────────

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Dynamic UPDATE builder ────────────────────────────────────────────────────
// Returns the SET clause and values array for positional params starting at $offset+1

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function buildUpdate(
  updates: Record<string, unknown>,
  offset = 0,
): { sets: string; vals: unknown[] } {
  const entries = Object.entries(updates).filter(([col]) => SAFE_IDENTIFIER.test(col));
  const sets = entries.map(([col], i) => `${col} = $${i + 1 + offset}`).join(', ');
  const vals = entries.map(([, v]) => v);
  return { sets, vals };
}

// ─── Sanitize: strip undefined → null (pg handles booleans natively) ──────────

export function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v === undefined ? null : v;
  }
  return out;
}

// ─── Row coercions (booleans come back from pg as JS booleans already) ────────

export function rowToGoal(row: Record<string, unknown>) {
  return row;
}

export function rowToTask(row: Record<string, unknown>) {
  return row;
}
