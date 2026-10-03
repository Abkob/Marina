-- Additive plan memory. Existing tasks, goals, resources and calendar stay authoritative.
CREATE TABLE IF NOT EXISTS planning_plans (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  goal_id TEXT REFERENCES goals(id) ON DELETE CASCADE,
  head_version INTEGER NOT NULL DEFAULT 0 CHECK (head_version >= 0),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','revising','current','stale','archived')),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version=1),
  archived_at TIMESTAMPTZ, forgotten_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (num_nonnulls(task_id,goal_id)=1)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_planning_task_root ON planning_plans(task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_planning_goal_root ON planning_plans(goal_id) WHERE goal_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS planning_plan_revisions (
  plan_id TEXT NOT NULL REFERENCES planning_plans(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 0),
  previous_version INTEGER,
  content JSONB NOT NULL CHECK (jsonb_typeof(content)='object' AND octet_length(content::text)<=262144),
  origin TEXT NOT NULL CHECK (origin IN ('user','assistant','system')),
  operation TEXT NOT NULL CHECK (operation IN ('create','edit','archive','restore','forget')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL, facts_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), redacted_at TIMESTAMPTZ,
  PRIMARY KEY (plan_id,version), UNIQUE (plan_id,idempotency_key),
  CHECK ((version=0 AND previous_version IS NULL) OR (version>0 AND previous_version IS NOT NULL AND previous_version=version-1)),
  FOREIGN KEY (plan_id,previous_version) REFERENCES planning_plan_revisions(plan_id,version) DEFERRABLE INITIALLY DEFERRED
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='planning_current_revision_fk' AND conrelid='planning_plans'::regclass) THEN
    ALTER TABLE planning_plans ADD CONSTRAINT planning_current_revision_fk FOREIGN KEY (id,head_version)
      REFERENCES planning_plan_revisions(plan_id,version) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS planning_scenarios (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES planning_plans(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  scope JSONB NOT NULL CHECK (jsonb_typeof(scope)='object'), facts_hash TEXT NOT NULL,
  base_version INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'evaluating'
    CHECK (state IN ('evaluating','ready','partial','conflicted','failed','canceled','superseded')),
  result JSONB CHECK (result IS NULL OR octet_length(result::text)<=65536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(plan_id,base_version) REFERENCES planning_plan_revisions(plan_id,version) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_planning_scenario_request ON planning_scenarios(plan_id,base_version,request_key);
CREATE INDEX IF NOT EXISTS idx_planning_scenario_retention ON planning_scenarios(updated_at,id) WHERE state <> 'evaluating';
INSERT INTO schema_migrations(name) VALUES ('M-031-persistent-plans') ON CONFLICT(name) DO NOTHING;
