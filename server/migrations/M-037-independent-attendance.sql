-- Existing timers retain their meaning until an explicit switch separates focus.
ALTER TABLE work_timers ADD COLUMN IF NOT EXISTS attendance_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE work_timers ADD COLUMN IF NOT EXISTS focus_ended_at TEXT;
