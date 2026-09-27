-- Additive migration: existing notes stay open until explicitly finished.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS completed_at TEXT;
INSERT INTO schema_migrations (name) VALUES ('M-025-note-completion') ON CONFLICT (name) DO NOTHING;
