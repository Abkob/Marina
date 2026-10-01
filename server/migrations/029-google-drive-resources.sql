-- Additive: originals remain in Drive; searchable passages/vectors stay in Postgres.
CREATE TABLE IF NOT EXISTS google_drive_connection (
  id TEXT PRIMARY KEY CHECK (id='primary'),
  account_id TEXT NOT NULL,
  account_email TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  scopes TEXT NOT NULL,
  folder_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS google_drive_oauth_states (
  nonce TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE resource_uploads ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'blob';
CREATE TABLE IF NOT EXISTS resource_drive_uploads (
  upload_id TEXT PRIMARY KEY REFERENCES resource_uploads(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL UNIQUE,
  encrypted_session TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS resource_drive_files (
  resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL UNIQUE,
  source_mime TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_modified_at TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  available BOOLEAN NOT NULL DEFAULT true,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_drive_files_checked ON resource_drive_files(checked_at);
CREATE INDEX IF NOT EXISTS idx_resource_chunks_lexical ON resource_chunks USING gin(to_tsvector('simple',content));
INSERT INTO schema_migrations(name) VALUES ('M-029-google-drive-resources') ON CONFLICT(name) DO NOTHING;
