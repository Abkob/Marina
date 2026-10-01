import pg from 'pg';

const requiredColumns = {
  resources: ['original_name', 'mime_type', 'file_size', 'file_validation'],
  resource_uploads: ['id', 'request_key', 'pathname', 'original_name', 'mime_type', 'size', 'attach_to_id', 'attach_to_type', 'state', 'created_at', 'expires_at', 'last_checked_at', 'completed_at', 'storage_provider'],
  resource_processing_jobs: ['id', 'resource_id', 'version', 'stage', 'status', 'attempts', 'error_code', 'error', 'lease_token', 'lease_expires_at', 'next_attempt_at', 'last_dispatched_at', 'created_at', 'updated_at'],
  resource_outbox: ['id', 'job_id', 'version', 'created_at', 'delivered_at', 'attempts', 'last_error'],
  google_drive_connection: ['id', 'account_id', 'account_email', 'encrypted_refresh_token', 'scopes', 'folder_id', 'last_error'],
  google_drive_oauth_states: ['nonce', 'expires_at'],
  resource_drive_uploads: ['upload_id', 'file_id', 'encrypted_session'],
  resource_drive_files: ['resource_id', 'file_id', 'source_mime', 'source_version', 'source_modified_at', 'checked_at', 'available', 'last_error'],
};

export async function verifyResourceDeployment(
  env: NodeJS.ProcessEnv,
  createClient = (connectionString: string) => new pg.Client({ connectionString, connectionTimeoutMillis: 10_000, query_timeout: 15_000 }),
) {
  const missing = ['DATABASE_URL', 'BLOB_READ_WRITE_TOKEN', 'INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_TOKEN_ENCRYPTION_KEY', 'APP_URL'].filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`Resource deployment is not ready: configure ${missing.join(', ')}. The existing deployment must remain active.`);
  if (env.GOOGLE_TOKEN_ENCRYPTION_KEY!.length < 32) throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEY must be at least 32 characters.');
  if ((env.GOOGLE_OAUTH_STATE_SECRET ?? env.MARINA_SESSION_SECRET ?? env.AMINA_SESSION_SECRET ?? '').length < 32) throw new Error('GOOGLE_OAUTH_STATE_SECRET must be at least 32 characters.');
  if (new URL(env.APP_URL!).protocol !== 'https:') throw new Error('APP_URL must use HTTPS for production Google authorization.');
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
    if (absent.length) throw new Error('Resource deployment is not ready: apply migrations M-028 and M-029 after verifying a current production backup. See docs/google-drive-resources.md.');
  } finally {
    if (connected) await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}
