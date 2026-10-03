-- P03.2: invalidate residual-work assumptions when hierarchy composition changes.
CREATE OR REPLACE FUNCTION marina_task_work_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.title,NEW.description,NEW.estimated_minutes,NEW.parent_task_id,NEW.goal_id,NEW.time_rollup_mode)
     IS DISTINCT FROM ROW(OLD.title,OLD.description,OLD.estimated_minutes,OLD.parent_task_id,OLD.goal_id,OLD.time_rollup_mode)
     OR ((OLD.completed OR OLD.status='done') AND NOT (NEW.completed OR NEW.status='done')) THEN
    NEW.work_version := OLD.work_version + 1;
  END IF;
  IF NEW.actual_minutes IS DISTINCT FROM OLD.actual_minutes THEN
    NEW.worklog_version := GREATEST(NEW.worklog_version,OLD.worklog_version+1);
  END IF;
  RETURN NEW;
END $$;

-- Parent forecasts entered under the earlier own-estimate interpretation need review once.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name='M-033-work-hierarchy') THEN
    UPDATE tasks p SET work_version=work_version+1 WHERE EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id=p.id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION marina_task_hierarchy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.parent_task_id IS NOT DISTINCT FROM OLD.parent_task_id THEN RETURN NEW; END IF;
  IF NEW.parent_task_id IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('marina-task-hierarchy'));
  IF NEW.parent_task_id=NEW.id OR EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id,parent_task_id FROM tasks WHERE id=NEW.parent_task_id
      UNION SELECT t.id,t.parent_task_id FROM tasks t JOIN ancestors a ON t.id=a.parent_task_id
    ) SELECT 1 FROM ancestors WHERE id=NEW.id OR NOT EXISTS (SELECT 1 FROM ancestors WHERE parent_task_id IS NULL)
  ) THEN RAISE EXCEPTION 'A task cannot become its own ancestor.' USING ERRCODE='23514',CONSTRAINT='task_hierarchy_acyclic'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS task_hierarchy_guard ON tasks;
CREATE TRIGGER task_hierarchy_guard BEFORE INSERT OR UPDATE OF parent_task_id ON tasks FOR EACH ROW EXECUTE FUNCTION marina_task_hierarchy_guard();

CREATE OR REPLACE FUNCTION marina_task_hierarchy_versions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_parent TEXT; new_parent TEXT;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.title,NEW.description,NEW.parent_task_id,NEW.goal_id,NEW.time_rollup_mode,NEW.estimated_minutes,NEW.completed,NEW.status)
     IS NOT DISTINCT FROM ROW(OLD.title,OLD.description,OLD.parent_task_id,OLD.goal_id,OLD.time_rollup_mode,OLD.estimated_minutes,OLD.completed,OLD.status) THEN RETURN NULL; END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN old_parent:=OLD.parent_task_id; END IF;
  IF TG_OP IN ('UPDATE','INSERT') THEN new_parent:=NEW.parent_task_id; END IF;
  -- UNION visits each ancestor once and terminates even if legacy data contains a cycle.
  WITH RECURSIVE ancestors AS (
    SELECT id,parent_task_id FROM tasks WHERE id=old_parent OR id=new_parent
    UNION SELECT t.id,t.parent_task_id FROM tasks t JOIN ancestors a ON t.id=a.parent_task_id
  ) UPDATE tasks SET work_version=work_version+1 WHERE id IN (SELECT id FROM ancestors);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS task_hierarchy_versions ON tasks;
CREATE TRIGGER task_hierarchy_versions AFTER INSERT OR UPDATE OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION marina_task_hierarchy_versions();
INSERT INTO schema_migrations(name) VALUES ('M-033-work-hierarchy') ON CONFLICT(name) DO NOTHING;
