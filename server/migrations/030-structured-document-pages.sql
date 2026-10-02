-- Additive staging for resumable, versioned page evidence. Original files remain in Drive.
CREATE TABLE IF NOT EXISTS resource_document_pages (
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  source_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  native_text TEXT NOT NULL DEFAULT '',
  evidence JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(resource_id,generation,page_number)
);
CREATE INDEX IF NOT EXISTS idx_document_pages_pending ON resource_document_pages(resource_id,generation,page_number) WHERE status='pending';
INSERT INTO schema_migrations(name) VALUES ('M-030-structured-document-pages') ON CONFLICT(name) DO NOTHING;
