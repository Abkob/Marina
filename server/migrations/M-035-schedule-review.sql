-- Additive migration. Apply only after a current verified production backup.
CREATE TABLE IF NOT EXISTS schedule_day_plans (
  date TEXT PRIMARY KEY CHECK (date ~ '^\d{4}-\d{2}-\d{2}$'),
  timezone TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  frozen BOOLEAN NOT NULL DEFAULT FALSE,
  occurrences JSONB NOT NULL CHECK (jsonb_typeof(occurrences)='array')
);
CREATE TABLE IF NOT EXISTS schedule_occurrence_outcomes (
  occurrence_id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('unknown','confirmed','skipped')),
  actual_start TEXT,
  actual_end TEXT,
  session_id TEXT,
  occurrence JSONB NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status<>'confirmed' OR (actual_start IS NOT NULL AND actual_end IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_schedule_outcomes_date ON schedule_occurrence_outcomes(date);
CREATE TABLE IF NOT EXISTS schedule_checkin_commands (
  id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_outcome_history (
  occurrence_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  outcome JSONB NOT NULL,
  PRIMARY KEY (occurrence_id,revision)
);
INSERT INTO schema_migrations(name) VALUES ('M-035-schedule-review') ON CONFLICT DO NOTHING;
ALTER TABLE work_timers ADD COLUMN IF NOT EXISTS schedule_occurrence_id TEXT;
ALTER TABLE work_timers ADD COLUMN IF NOT EXISTS schedule_date TEXT;
ALTER TABLE work_timers ADD COLUMN IF NOT EXISTS schedule_occurrence JSONB;
ALTER TABLE work_timers DROP CONSTRAINT IF EXISTS work_timers_check;
ALTER TABLE work_timers DROP CONSTRAINT IF EXISTS work_timers_activity;
ALTER TABLE work_timers ADD CONSTRAINT work_timers_activity CHECK (num_nonnulls(task_id,routine_id,schedule_occurrence_id)=1);
ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS schedule_occurrence_id TEXT;
ALTER TABLE work_timers DROP CONSTRAINT IF EXISTS work_timers_status_check;
ALTER TABLE work_timers ADD CONSTRAINT work_timers_status_check CHECK (status IN ('running','awaiting_end','stopped','discarded'));
CREATE TABLE IF NOT EXISTS schedule_push_subscriptions (
  id TEXT PRIMARY KEY, subscription JSONB NOT NULL, updated_at TEXT NOT NULL, last_error TEXT
);
CREATE TABLE IF NOT EXISTS schedule_push_deliveries (
  id TEXT PRIMARY KEY, claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sent_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS schedule_shortcut_keys (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ
);
