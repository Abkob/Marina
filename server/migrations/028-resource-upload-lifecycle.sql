-- Additive only. Apply to production only after a verified current cloud backup.
ALTER TABLE resources ADD COLUMN IF NOT EXISTS original_name TEXT;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS file_size BIGINT;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS file_validation TEXT;

-- The resource ID is reserved before bytes are sent. Completed/deleted intents
-- remain as tombstones so late callbacks cannot recreate a deleted resource.
CREATE TABLE IF NOT EXISTS resource_uploads (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  pathname TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size BIGINT NOT NULL CHECK (size > 0 AND size <= 52428800),
  attach_to_id TEXT,
  attach_to_type TEXT CHECK (attach_to_type IN ('task','goal')),
  state TEXT NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','completed','expired','deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  last_checked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK ((attach_to_id IS NULL) = (attach_to_type IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_resource_uploads_pending ON resource_uploads(state, last_checked_at);

CREATE TABLE IF NOT EXISTS resource_processing_jobs (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE REFERENCES resources(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  stage TEXT NOT NULL DEFAULT 'extract' CHECK (stage IN ('extract','embed')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','no_text','unsupported','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_dispatched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resource_jobs_ready ON resource_processing_jobs(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS resource_outbox (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES resource_processing_jobs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_resource_outbox_pending ON resource_outbox(created_at) WHERE delivered_at IS NULL;
INSERT INTO schema_migrations (name) VALUES ('M-028-resource-upload-lifecycle') ON CONFLICT (name) DO NOTHING;
