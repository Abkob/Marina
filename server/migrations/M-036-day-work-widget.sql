-- Additive only. Existing schedule-only credentials retain their authority.
ALTER TABLE schedule_shortcut_keys ADD COLUMN IF NOT EXISTS focus_control BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS day_work_picks (
  date TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(date,task_id)
);
CREATE TABLE IF NOT EXISTS day_work_commands (
  id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
