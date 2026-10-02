import { beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { verifyResourceDeployment } from '../../../scripts/lib/resourceDeployment';

const env = { DATABASE_URL: 'postgresql://test.invalid/marina_test', BLOB_READ_WRITE_TOKEN: 'test-blob', INNGEST_EVENT_KEY: 'test-event', INNGEST_SIGNING_KEY: 'test-signing', GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_TOKEN_ENCRYPTION_KEY: 'e'.repeat(32), GOOGLE_OAUTH_STATE_SECRET: 's'.repeat(32), APP_URL: 'https://marina.test' };
const schema = {
  resource_document_pages: 'resource_id generation page_number source_hash extractor_version native_text evidence status attempts error updated_at',
  resources: 'original_name mime_type file_size file_validation',
  resource_uploads: 'id request_key pathname original_name mime_type size attach_to_id attach_to_type state created_at expires_at last_checked_at completed_at storage_provider',
  resource_processing_jobs: 'id resource_id version stage status attempts error_code error lease_token lease_expires_at next_attempt_at last_dispatched_at created_at updated_at',
  resource_outbox: 'id job_id version created_at delivered_at attempts last_error',
  google_drive_connection: 'id account_id account_email encrypted_refresh_token scopes folder_id last_error',
  google_drive_oauth_states: 'nonce expires_at',
  resource_drive_uploads: 'upload_id file_id encrypted_session',
  resource_drive_files: 'resource_id file_id source_mime source_version source_modified_at checked_at available last_error',
};
const allColumns = Object.entries(schema).flatMap(([table_name, columns]) => columns.split(' ').map(column_name => ({ table_name, column_name })));
let columns = allColumns;
const client = { connect: vi.fn(), query: vi.fn(), end: vi.fn() };
const createClient = vi.fn(() => client as unknown as pg.Client);
beforeEach(() => {
  vi.resetAllMocks(); columns = allColumns;
  client.connect.mockResolvedValue(undefined); client.end.mockResolvedValue(undefined);
  client.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('information_schema.columns') ? columns : [] }));
});

describe('resource deployment readiness', () => {
  it.each(Object.keys(env))('blocks a release without %s before accessing the database', async name => {
    await expect(verifyResourceDeployment({ ...env, [name]: '' }, createClient)).rejects.toThrow(name);
    expect(createClient).not.toHaveBeenCalled();
  });
  it('rejects whitespace credentials and does not accept local development mode as production readiness', async () => {
    await expect(verifyResourceDeployment({ ...env, INNGEST_SIGNING_KEY: '  ', INNGEST_DEV: '1' }, createClient)).rejects.toThrow('INNGEST_SIGNING_KEY');
    expect(createClient).not.toHaveBeenCalled();
  });
  it.each(Object.keys(schema))('blocks a release with missing %s schema', async table => {
    columns = allColumns.filter(column => column.table_name !== table);
    await expect(verifyResourceDeployment(env, createClient)).rejects.toThrow('M-028');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.end).toHaveBeenCalledOnce();
  });
  it('detects partially applied migrations', async () => {
    columns = allColumns.filter(column => column.column_name !== 'lease_token');
    await expect(verifyResourceDeployment(env, createClient)).rejects.toThrow('M-028');
  });
  it('permits a ready schema using only a read-only transaction and no migrations', async () => {
    await expect(verifyResourceDeployment(env, createClient)).resolves.toBeUndefined();
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN READ ONLY', "SET LOCAL statement_timeout='10s'",
      expect.stringContaining('SELECT table_name,column_name FROM information_schema.columns'), 'ROLLBACK',
    ]);
    expect(client.end).toHaveBeenCalledOnce();
  });
  it('fails closed and closes the client when the database is unreachable', async () => {
    client.connect.mockRejectedValue(new Error('unreachable'));
    await expect(verifyResourceDeployment(env, createClient)).rejects.toThrow('unreachable');
    expect(client.query).not.toHaveBeenCalled(); expect(client.end).toHaveBeenCalledOnce();
  });
  it('rolls back and closes the client when schema inspection fails', async () => {
    client.query.mockRejectedValueOnce(new Error('query failed'));
    await expect(verifyResourceDeployment(env, createClient)).rejects.toThrow('query failed');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK'); expect(client.end).toHaveBeenCalledOnce();
  });
});
