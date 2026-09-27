-- Cloud-owned focus sessions. Finished/discarded IDs prevent stale devices from
-- resurrecting a timer or logging the same interval twice.
CREATE TABLE IF NOT EXISTS work_timers (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  routine_id TEXT,
  routine_date TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','stopped','discarded')),
  updated_at TEXT NOT NULL,
  CHECK ((task_id IS NOT NULL) <> (routine_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_timers_one_running ON work_timers(status) WHERE status='running';
INSERT INTO schema_migrations (name) VALUES ('M-026-cloud-work-timer') ON CONFLICT (name) DO NOTHING;
