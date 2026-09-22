-- Additive only. Apply this file explicitly; API reads never initialize schema.
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  weekdays JSONB NOT NULL CHECK (jsonb_typeof(weekdays) = 'array'),
  weekly_target INTEGER NOT NULL CHECK (weekly_target BETWEEN 1 AND 7),
  target_count INTEGER NOT NULL CHECK (target_count > 0),
  target_unit TEXT NOT NULL CHECK (target_unit IN ('minutes','problems','pages','sessions')),
  planned_minutes INTEGER NOT NULL CHECK (planned_minutes BETWEEN 1 AND 1440),
  preferred_time TEXT,
  start_date TEXT NOT NULL,
  archived_at TEXT,
  archived_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routine_entries (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE RESTRICT,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','skipped','partial')),
  minutes INTEGER NOT NULL DEFAULT 0 CHECK (minutes >= 0),
  completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (routine_id, date)
);
CREATE INDEX IF NOT EXISTS idx_routine_entries_date ON routine_entries(date);
CREATE INDEX IF NOT EXISTS idx_routines_goal ON routines(goal_id);
ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS routine_id TEXT REFERENCES routines(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_work_sessions_routine ON work_sessions(routine_id) WHERE routine_id IS NOT NULL;
INSERT INTO schema_migrations (name) VALUES ('M-024-routines') ON CONFLICT (name) DO NOTHING;
