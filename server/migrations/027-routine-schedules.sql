-- Additive only. Existing routines and their logs are preserved.
ALTER TABLE routines ADD COLUMN IF NOT EXISTS schedule_history JSONB NOT NULL DEFAULT '[]'::jsonb;
INSERT INTO schema_migrations (name) VALUES ('M-027-routine-schedules') ON CONFLICT (name) DO NOTHING;
