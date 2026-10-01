import pg from 'pg';

const requiredColumns = {
  resources: ['original_name', 'mime_type', 'file_size', 'file_validation'],
  resource_uploads: ['id', 'request_key', 'pathname', 'original_name', 'mime_type', 'size', 'attach_to_id', 'attach_to_type', 'state', 'created_at', 'expires_at', 'last_checked_at', 'completed_at'],
  resource_processing_jobs: ['id', 'resource_id', 'version', 'stage', 'status', 'attempts', 'error_code', 'error', 'lease_token', 'lease_expires_at', 'next_attempt_at', 'last_dispatched_at', 'created_at', 'updated_at'],
  resource_outbox: ['id', 'job_id', 'version', 'created_at', 'delivered_at', 'attempts', 'last_error'],
};

export async function verifyResourceDeployment(
  env: NodeJS.ProcessEnv,
  createClient = (connectionString: string) => new pg.Client({ connectionString, connectionTimeoutMillis: 10_000, query_timeout: 15_000 }),
) {
  const missing = ['DATABASE_URL', 'BLOB_READ_WRITE_TOKEN', 'INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY'].filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`Resource deployment is not ready: configure ${missing.join(', ')}. The existing deployment must remain active.`);
  const client = createClient(env.DATABASE_URL!);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='10s'");
    const { rows } = await client.query<{ table_name: string; column_name: string }>(
      'SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1)',
      [Object.keys(requiredColumns)],
    );
    const available = new Set(rows.map(row => `${row.table_name}.${row.column_name}`));
    const absent = Object.entries(requiredColumns).flatMap(([table, columns]) => columns.map(column => `${table}.${column}`)).filter(column => !available.has(column));
    if (absent.length) throw new Error('Resource deployment is not ready: apply migration M-028 after verifying a current production backup. See docs/resource-upload-rollout.md.');
  } finally {
    if (connected) await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}
