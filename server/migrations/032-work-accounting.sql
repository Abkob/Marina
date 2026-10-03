-- P03.1: forecasts are explicit, versioned judgments; reservations are not progress.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS work_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS worklog_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remaining_forecast_minutes INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remaining_forecast_work_version INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remaining_forecast_log_version INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remaining_forecast_updated_at TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS forecast_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_task_links ADD COLUMN IF NOT EXISTS work_version INTEGER;

-- Preserve existing accepted reservations on first upgrade. Never revalidate stale links on rerun.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name='M-032-work-accounting') THEN
    UPDATE event_task_links link SET work_version=t.work_version FROM tasks t WHERE t.id=link.task_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION marina_task_work_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.title,NEW.description,NEW.estimated_minutes,NEW.parent_task_id,NEW.goal_id)
     IS DISTINCT FROM ROW(OLD.title,OLD.description,OLD.estimated_minutes,OLD.parent_task_id,OLD.goal_id)
     OR ((OLD.completed OR OLD.status='done') AND NOT (NEW.completed OR NEW.status='done')) THEN
    NEW.work_version := OLD.work_version + 1;
  END IF;
  IF NEW.actual_minutes IS DISTINCT FROM OLD.actual_minutes THEN
    NEW.worklog_version := GREATEST(NEW.worklog_version,OLD.worklog_version+1);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS task_work_version ON tasks;
CREATE TRIGGER task_work_version BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION marina_task_work_version();

CREATE OR REPLACE FUNCTION marina_session_work_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.task_id,NEW.minutes) IS NOT DISTINCT FROM ROW(OLD.task_id,OLD.minutes) THEN RETURN NEW; END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.task_id IS NOT NULL THEN
    UPDATE tasks SET worklog_version=worklog_version+1 WHERE id=OLD.task_id;
  END IF;
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND NEW.task_id IS DISTINCT FROM OLD.task_id) THEN
    UPDATE tasks SET worklog_version=worklog_version+1 WHERE id=NEW.task_id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS session_work_version ON work_sessions;
CREATE TRIGGER session_work_version AFTER INSERT OR UPDATE OR DELETE ON work_sessions FOR EACH ROW EXECUTE FUNCTION marina_session_work_version();

CREATE OR REPLACE FUNCTION marina_link_work_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT work_version INTO NEW.work_version FROM tasks WHERE id=NEW.task_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS link_work_version ON event_task_links;
CREATE TRIGGER link_work_version BEFORE INSERT OR UPDATE OF planned_minutes,task_id ON event_task_links
  FOR EACH ROW EXECUTE FUNCTION marina_link_work_version();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='task_remaining_forecast_bounds') THEN
    ALTER TABLE tasks ADD CONSTRAINT task_remaining_forecast_bounds CHECK (remaining_forecast_minutes BETWEEN 0 AND 60000000);
  END IF;
END $$;
INSERT INTO schema_migrations(name) VALUES ('M-032-work-accounting') ON CONFLICT(name) DO NOTHING;
