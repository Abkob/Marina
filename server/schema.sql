-- ─────────────────────────────────────────────────────────────────────────────
-- Amina OS — PostgreSQL schema
-- Run once on a fresh database, or idempotently with IF NOT EXISTS / DO NOTHING
-- ─────────────────────────────────────────────────────────────────────────────

-- pgvector (graceful — app runs without it, vector search disabled)
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector not installed — semantic search disabled. Install from https://github.com/pgvector/pgvector';
END $$;

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

-- ─── Goals ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goals (
  id              TEXT PRIMARY KEY,
  title           TEXT    NOT NULL DEFAULT '',
  description     TEXT    NOT NULL DEFAULT '',
  category        TEXT    NOT NULL DEFAULT '',
  status          TEXT    NOT NULL DEFAULT 'Safe',
  progress        REAL    NOT NULL DEFAULT 0,
  deadline        TEXT,
  overdue         BOOLEAN NOT NULL DEFAULT false,
  activity_level  INTEGER NOT NULL DEFAULT 1,
  archived_at     TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

-- ─── Tasks ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id                   TEXT PRIMARY KEY,
  goal_id              TEXT,
  parent_task_id       TEXT,
  milestone_id         TEXT,
  deadline_id          TEXT,
  title                TEXT    NOT NULL DEFAULT '',
  description          TEXT    NOT NULL DEFAULT '',
  status               TEXT    NOT NULL DEFAULT 'todo',
  priority             TEXT    NOT NULL DEFAULT 'medium',
  kind                 TEXT    NOT NULL DEFAULT 'manual',
  critical_path_status TEXT,
  tags_json            TEXT    NOT NULL DEFAULT '[]',
  due_date             TEXT,
  start_date           TEXT,
  estimated_duration   TEXT,
  estimated_minutes    INTEGER,
  time_rollup_mode     TEXT    NOT NULL DEFAULT 'additive' CHECK (time_rollup_mode IN ('additive','inclusive')),
  actual_minutes       INTEGER,
  weight_percent       REAL,
  feel_score           INTEGER CHECK (feel_score BETWEEN 0 AND 100),
  completed            BOOLEAN NOT NULL DEFAULT false,
  position             INTEGER NOT NULL DEFAULT 0,
  last_activity_at     TEXT,
  completion_note      TEXT    NOT NULL DEFAULT '',
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  FOREIGN KEY (goal_id)        REFERENCES goals(id)          ON DELETE SET NULL,
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id)          ON DELETE CASCADE
);

-- ─── Goal deadlines ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goal_deadlines (
  id         TEXT PRIMARY KEY,
  goal_id    TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  date       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#ef4444',
  created_at TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
);

-- ─── Goal milestones ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goal_milestones (
  id          TEXT PRIMARY KEY,
  goal_id     TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  due_date    TEXT,
  color       TEXT NOT NULL DEFAULT '#6366f1',
  position    INTEGER NOT NULL DEFAULT 0,
  completed   BOOLEAN NOT NULL DEFAULT false,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
);

-- ─── Meetings ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meetings (
  id           TEXT PRIMARY KEY,
  goal_id      TEXT,
  milestone_id TEXT,
  title        TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  location     TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  summary      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE SET NULL
);

-- ─── Calendar events ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id                     TEXT PRIMARY KEY,
  title                  TEXT NOT NULL DEFAULT '',
  type                   TEXT NOT NULL DEFAULT 'focus',
  day_index              INTEGER NOT NULL DEFAULT 0,
  start_hour             REAL NOT NULL DEFAULT 9,
  duration_hours         REAL NOT NULL DEFAULT 1,
  time_str               TEXT NOT NULL DEFAULT '',
  description            TEXT NOT NULL DEFAULT '',
  week_start             TEXT,
  connected_resource_json TEXT,
  locked                 BOOLEAN NOT NULL DEFAULT false,
  source                 TEXT NOT NULL DEFAULT 'manual',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- ─── Event ↔ task links ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_task_links (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  planned_minutes INTEGER,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id)  REFERENCES tasks(id)  ON DELETE CASCADE,
  UNIQUE(event_id, task_id)
);

-- ─── Work sessions ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_sessions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT,
  resource_id TEXT,
  goal_id     TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  minutes     INTEGER,
  notes       TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

-- ─── Task notes (inline journal thread per task) ─────────────────────────────
CREATE TABLE IF NOT EXISTS task_notes (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- ─── Task note attachments ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_note_files (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  size       INTEGER NOT NULL,
  file_path  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (note_id) REFERENCES task_notes(id) ON DELETE CASCADE
);

-- ─── Brain dump notes ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notes (
  id                       TEXT PRIMARY KEY,
  title                    TEXT NOT NULL DEFAULT '',
  content                  TEXT NOT NULL DEFAULT '',
  type                     TEXT NOT NULL DEFAULT 'capture',
  date_str                 TEXT NOT NULL DEFAULT '',
  suggested_action_text    TEXT,
  suggested_action_applied BOOLEAN NOT NULL DEFAULT false,
  suggested_action_ignored BOOLEAN NOT NULL DEFAULT false,
  extracted_tasks_json     TEXT NOT NULL DEFAULT '[]',
  relevant_docs_json       TEXT NOT NULL DEFAULT '[]',
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

-- ─── Resources ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resources (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL DEFAULT '',
  url               TEXT,
  type              TEXT NOT NULL DEFAULT 'link',
  info              TEXT NOT NULL DEFAULT '',
  description       TEXT,
  read_state        TEXT NOT NULL DEFAULT 'Unread',
  next_action       TEXT NOT NULL DEFAULT '',
  tags_json         TEXT NOT NULL DEFAULT '[]',
  estimated_minutes INTEGER,
  actual_minutes    INTEGER,
  file_path         TEXT,
  external_id       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT
);

-- ─── Resource chunks (for large PDFs / semantic chunking) ─────────────────────
CREATE TABLE IF NOT EXISTS resource_chunks (
  id           TEXT PRIMARY KEY,
  resource_id  TEXT NOT NULL,
  chunk_index  INTEGER NOT NULL,
  heading      TEXT,
  content      TEXT NOT NULL,
  page_start   INTEGER,
  page_end     INTEGER,
  token_count  INTEGER,
  content_hash TEXT,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
);

-- ─── Resource logs (progress notes + key insights) ───────────────────────────
CREATE TABLE IF NOT EXISTS resource_logs (
  id          TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  is_insight  BOOLEAN NOT NULL DEFAULT false,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
);

-- Research knowledge layer. Papers remain resources (and reuse resource_chunks /
-- embeddings); these tables add scholarly metadata and claim-level provenance.
CREATE TABLE IF NOT EXISTS research_papers (
  id             TEXT PRIMARY KEY,
  resource_id    TEXT NOT NULL UNIQUE,
  doi            TEXT,
  authors_json   TEXT NOT NULL DEFAULT '[]',
  publication_year INTEGER,
  venue          TEXT,
  abstract       TEXT,
  ingestion_status TEXT NOT NULL DEFAULT 'indexed',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS research_claims (
  id              TEXT PRIMARY KEY,
  paper_id        TEXT NOT NULL,
  claim_type      TEXT NOT NULL DEFAULT 'finding',
  claim_text      TEXT NOT NULL,
  source_chunk_id TEXT,
  page_start      INTEGER,
  page_end        INTEGER,
  confidence      REAL NOT NULL DEFAULT 0.0,
  verification_status TEXT NOT NULL DEFAULT 'unreviewed',
  created_by      TEXT NOT NULL DEFAULT 'ai',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (paper_id) REFERENCES research_papers(id) ON DELETE CASCADE,
  FOREIGN KEY (source_chunk_id) REFERENCES resource_chunks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_research_claims_paper ON research_claims(paper_id);
CREATE INDEX IF NOT EXISTS idx_research_claims_chunk ON research_claims(source_chunk_id);

-- ─── Graph edges ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS edges (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  relationship TEXT NOT NULL,
  strength     REAL NOT NULL DEFAULT 1.0,
  confidence   REAL NOT NULL DEFAULT 1.0,
  metadata     TEXT,
  created_by   TEXT NOT NULL DEFAULT 'manual',
  created_at   TEXT NOT NULL,
  UNIQUE(source_type, source_id, target_type, target_id, relationship)
);

-- ─── Tags ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tags (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#6B7280'
);

CREATE TABLE IF NOT EXISTS entity_tags (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  tag_id      TEXT NOT NULL,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE,
  UNIQUE(entity_type, entity_id, tag_id)
);

-- ─── Entity aliases (fuzzy name resolution for journal ingestion) ─────────────
CREATE TABLE IF NOT EXISTS entity_aliases (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  alias       TEXT NOT NULL,
  created_by  TEXT NOT NULL DEFAULT 'ai',
  created_at  TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, alias)
);

-- ─── Daily scores ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_scores (
  id              TEXT PRIMARY KEY,
  date            TEXT NOT NULL UNIQUE,
  score           REAL NOT NULL DEFAULT 0,
  mood            INTEGER NOT NULL DEFAULT 3,
  energy          INTEGER NOT NULL DEFAULT 3,
  focus           INTEGER NOT NULL DEFAULT 3,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL
);

-- ─── User schedule preferences ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_schedule_prefs (
  id                     TEXT PRIMARY KEY DEFAULT 'default',
  work_days              TEXT    NOT NULL DEFAULT '[1,2,3,4,5]',
  work_start             REAL    NOT NULL DEFAULT 9.0,
  work_end               REAL    NOT NULL DEFAULT 18.0,
  daily_capacity_minutes INTEGER NOT NULL DEFAULT 480,
  deep_work_start        REAL    NOT NULL DEFAULT 9.0,
  deep_work_end          REAL    NOT NULL DEFAULT 12.0,
  buffer_ratio           REAL    NOT NULL DEFAULT 0.15,
  updated_at             TEXT    NOT NULL
);

-- ─── Schedule day overrides ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schedule_day_overrides (
  id                 TEXT PRIMARY KEY,
  date               TEXT NOT NULL UNIQUE,
  available_minutes  INTEGER,
  unavailable_blocks TEXT NOT NULL DEFAULT '[]',
  note               TEXT,
  created_at         TEXT NOT NULL
);

-- ─── Journal entries ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS journal_entries (
  id               TEXT PRIMARY KEY,
  entry_date       TEXT NOT NULL DEFAULT (CURRENT_DATE::TEXT),
  raw_text         TEXT NOT NULL,
  summary          TEXT,
  mood             TEXT,
  energy_level     INTEGER CHECK (energy_level BETWEEN 1 AND 10),
  tags_json        TEXT NOT NULL DEFAULT '[]',
  ingestion_status TEXT NOT NULL DEFAULT 'pending',
  content_hash     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- ─── Journal links (journal entry → any entity) ───────────────────────────────
CREATE TABLE IF NOT EXISTS journal_links (
  id               TEXT PRIMARY KEY,
  journal_entry_id TEXT NOT NULL,
  target_type      TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  relationship     TEXT NOT NULL,
  confidence       REAL NOT NULL DEFAULT 1.0,
  created_by       TEXT NOT NULL DEFAULT 'ai',
  created_at       TEXT NOT NULL,
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE
);

-- ─── Extracted facts (AI-parsed from journals, meetings, resources) ───────────
CREATE TABLE IF NOT EXISTS extracted_facts (
  id          TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  fact_type   TEXT NOT NULL,
  fact_text   TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  confidence  REAL NOT NULL DEFAULT 0.0,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ─── AI action proposals ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_action_proposals (
  id               TEXT PRIMARY KEY,
  source_type      TEXT,
  source_id        TEXT,
  action_type      TEXT NOT NULL,
  action_payload   TEXT NOT NULL DEFAULT '{}',
  confidence       REAL NOT NULL DEFAULT 0.0,
  status           TEXT NOT NULL DEFAULT 'pending',
  explanation      TEXT,
  created_at       TEXT NOT NULL,
  applied_at       TEXT,
  idempotency_key  TEXT
);
-- Dedup index for (action_type, idempotency_key) is created by M-013 below,
-- AFTER the column is guaranteed to exist on legacy databases.

-- ─── Entity summaries (AI-readable summaries, cached per entity) ──────────────
CREATE TABLE IF NOT EXISTS entity_summaries (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  summary_type TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  source_hash  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, summary_type)
);

-- ─── Vector embeddings ───────────────────────────────────────────────────────
-- The legacy embedding column retains the previous 768-dim Nomic vectors for rollback.
-- embedding_3072 is promoted to halfvec(3072), which supports HNSW beyond vector's
-- 2,000-dimension index limit.
CREATE TABLE IF NOT EXISTS embeddings (
  id              TEXT PRIMARY KEY,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  chunk_id        TEXT,
  embedding_scope TEXT NOT NULL,
  embedding_text  TEXT NOT NULL,
  embedding       TEXT,
  embedding_3072  TEXT,
  embedding_model TEXT NOT NULL DEFAULT 'gemini-embedding-2',
  content_hash    TEXT NOT NULL,
  is_stale        BOOLEAN NOT NULL DEFAULT false,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, embedding_scope, content_hash)
);

-- When pgvector is available: promote the TEXT column to vector(768)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    BEGIN
      ALTER TABLE embeddings ALTER COLUMN embedding TYPE vector(768)
        USING CASE WHEN embedding IS NULL THEN NULL ELSE embedding::vector END;
    EXCEPTION WHEN others THEN
      NULL; -- already vector type or incompatible data — skip
    END;
  END IF;
END $$;

-- ─── Embedding jobs queue ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS embedding_jobs (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  chunk_id    TEXT,
  action      TEXT NOT NULL DEFAULT 'upsert',
  priority    INTEGER NOT NULL DEFAULT 5,
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  TEXT NOT NULL,
  processed_at TEXT
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tasks_goal        ON tasks(goal_id);
CREATE INDEX IF NOT EXISTS idx_tasks_milestone   ON tasks(milestone_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent      ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date    ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_status      ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_completed   ON tasks(completed);

CREATE INDEX IF NOT EXISTS idx_milestones_goal   ON goal_milestones(goal_id);
CREATE INDEX IF NOT EXISTS idx_deadlines_goal    ON goal_deadlines(goal_id);
CREATE INDEX IF NOT EXISTS idx_meetings_time     ON meetings(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_events_day        ON events(day_index, start_hour);

CREATE INDEX IF NOT EXISTS idx_work_sessions_task     ON work_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_task_notes_task        ON task_notes(task_id);
CREATE INDEX IF NOT EXISTS idx_task_note_files_note   ON task_note_files(note_id);
CREATE INDEX IF NOT EXISTS idx_resource_logs_resource ON resource_logs(resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_chunks_res    ON resource_chunks(resource_id);

CREATE INDEX IF NOT EXISTS idx_edges_source       ON edges(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target       ON edges(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relationship ON edges(relationship);

CREATE INDEX IF NOT EXISTS idx_entity_tags_entity ON entity_tags(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_aliases     ON entity_aliases(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_journal_date       ON journal_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_links_entry ON journal_links(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_extracted_facts_src ON extracted_facts(source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_embeddings_entity  ON embeddings(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_embedding_jobs_status ON embedding_jobs(status, priority, created_at);

-- HNSW index for fast cosine similarity search (only when pgvector is installed)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'embeddings_hnsw_idx') THEN
      EXECUTE 'CREATE INDEX embeddings_hnsw_idx ON embeddings USING hnsw (embedding vector_cosine_ops)';
    END IF;
  END IF;
END $$;

-- Fast entity_summaries lookup by entity (used by context builder on every AI call)
CREATE INDEX IF NOT EXISTS idx_entity_summaries_entity
  ON entity_summaries(entity_type, entity_id);

-- Reverse lookup: which journal entries mention this entity? (used by retrieval + graph)
CREATE INDEX IF NOT EXISTS idx_journal_links_target
  ON journal_links(target_type, target_id);

-- ─── Migrations (idempotent — safe to run on every startup) ──────────────────

-- M-001: rename payload → action_payload in ai_action_proposals
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_action_proposals' AND column_name = 'payload'
  ) THEN
    ALTER TABLE ai_action_proposals RENAME COLUMN payload TO action_payload;
  END IF;
END $$;

-- M-002: add embedding_dimension column
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS embedding_dimension INTEGER NOT NULL DEFAULT 3072;

-- M-003: entity_summaries — model and version tracking
ALTER TABLE entity_summaries ADD COLUMN IF NOT EXISTS summary_model TEXT NOT NULL DEFAULT 'glm-5.2:cloud';
ALTER TABLE entity_summaries ADD COLUMN IF NOT EXISTS summary_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE entity_summaries ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;

-- M-004: work_sessions — journal deduplication
ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS journal_entry_id TEXT;

-- M-005: journal_entries — retry tracking
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS ingestion_attempts INTEGER NOT NULL DEFAULT 0;

-- M-006: embedding_jobs — exponential backoff support
ALTER TABLE embedding_jobs ADD COLUMN IF NOT EXISTS next_attempt_at TEXT;

-- M-006b: embedding_jobs — crash recovery via lease expiry
ALTER TABLE embedding_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TEXT;

-- M-007: edges — confidence score
ALTER TABLE edges ADD COLUMN IF NOT EXISTS confidence REAL NOT NULL DEFAULT 1.0;

-- M-008: resource_chunks — page metadata
ALTER TABLE resource_chunks ADD COLUMN IF NOT EXISTS chunk_metadata TEXT;

-- M-009: indexes for new columns
CREATE INDEX IF NOT EXISTS idx_work_sessions_journal ON work_sessions(journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_embedding_jobs_queue ON embedding_jobs(status, priority DESC, created_at ASC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_proposals_status ON ai_action_proposals(status, confidence DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_journal_entries_status ON journal_entries(ingestion_status, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date_active ON tasks(due_date) WHERE completed = false;

-- M-011: Gemini Embedding 2 at 3072 dimensions.
-- Keep the old vector(768) column and index until the new corpus is verified.
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS embedding_3072 TEXT;
ALTER TABLE embeddings ALTER COLUMN embedding_model SET DEFAULT 'gemini-embedding-2';
ALTER TABLE embeddings ALTER COLUMN embedding_dimension SET DEFAULT 3072;

DO $$
DECLARE
  current_type TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    SELECT format_type(a.atttypid, a.atttypmod)
      INTO current_type
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'embeddings'
        AND a.attname = 'embedding_3072'
        AND a.attnum > 0
        AND NOT a.attisdropped;

    IF current_type IS DISTINCT FROM 'halfvec(3072)' THEN
      ALTER TABLE embeddings ALTER COLUMN embedding_3072 TYPE halfvec(3072)
        USING CASE
          WHEN embedding_3072 IS NULL THEN NULL
          ELSE embedding_3072::halfvec(3072)
        END;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
     AND NOT EXISTS (
       SELECT 1 FROM pg_indexes WHERE indexname = 'embeddings_hnsw_3072_idx'
     ) THEN
    EXECUTE 'CREATE INDEX embeddings_hnsw_3072_idx
             ON embeddings USING hnsw (embedding_3072 halfvec_cosine_ops)
             WHERE embedding_3072 IS NOT NULL';
  END IF;
END $$;

-- M-010: idempotency constraints for journal ingestion
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'journal_links' AND constraint_name = 'uq_journal_link_entity'
  ) THEN
    ALTER TABLE journal_links ADD CONSTRAINT uq_journal_link_entity
      UNIQUE (journal_entry_id, target_type, target_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'extracted_facts' AND constraint_name = 'uq_extracted_fact_text'
  ) THEN
    ALTER TABLE extracted_facts ADD CONSTRAINT uq_extracted_fact_text
      UNIQUE (source_id, source_type, fact_text);
  END IF;
END $$;

-- M-012: user_schedule_prefs — IANA timezone for local-date scheduling
ALTER TABLE user_schedule_prefs ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Beirut';

-- M-013a: extracted_facts — human review flag
ALTER TABLE extracted_facts ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;

-- M-013: proposal idempotency key
ALTER TABLE ai_action_proposals ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
-- Partial unique index created separately below (idempotent guard)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_proposals_idem') THEN
    EXECUTE $idx$
      CREATE UNIQUE INDEX idx_proposals_idem
        ON ai_action_proposals (action_type, idempotency_key)
        WHERE status = 'pending' AND idempotency_key IS NOT NULL
    $idx$;
  END IF;
END $$;

-- ─── Chat sessions (Epic 42 — durable conversation runtime) ──────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  model      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived   BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);

-- ─── Schema migrations registry ──────────────────────────────────────────────
-- Records which named migrations have been applied. Idempotent on re-run.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
);

-- M-014: FK constraints for tasks.milestone_id and tasks.deadline_id
-- NOT VALID: apply to new rows only, preserves existing data during live upgrade.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_milestone_id_fkey') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_milestone_id_fkey
      FOREIGN KEY (milestone_id) REFERENCES goal_milestones(id) ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_deadline_id_fkey') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_deadline_id_fkey
      FOREIGN KEY (deadline_id) REFERENCES goal_deadlines(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

-- M-015: FK constraints for work_sessions.goal_id and work_sessions.resource_id
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_sessions_goal_id_fkey') THEN
    ALTER TABLE work_sessions ADD CONSTRAINT work_sessions_goal_id_fkey
      FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_sessions_resource_id_fkey') THEN
    ALTER TABLE work_sessions ADD CONSTRAINT work_sessions_resource_id_fkey
      FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_sessions_journal_fkey') THEN
    ALTER TABLE work_sessions ADD CONSTRAINT work_sessions_journal_fkey
      FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

-- M-016: Unique active embedding job per entity prevents double-queuing.
-- The partial index covers only pending rows so completed/failed jobs don't block re-queues.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_embedding_jobs_unique_pending') THEN
    EXECUTE $idx$
      CREATE UNIQUE INDEX idx_embedding_jobs_unique_pending
        ON embedding_jobs (entity_type, entity_id, COALESCE(chunk_id, ''), action)
        WHERE status = 'pending'
    $idx$;
  END IF;
END $$;

-- M-017: journal_entries — AI-extracted tags live in their own column so
-- ingestion never overwrites the user's manual tags_json.
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS ai_tags_json TEXT NOT NULL DEFAULT '[]';

-- M-018: Semantic topics, memberships, and explainable suggestions (Epics 41/44/48/49).
-- Manual assertions are authoritative: source='manual' rows are never touched by
-- AI candidate generation; AI output enters as status='suggested' and becomes
-- canonical only on explicit acceptance.
CREATE TABLE IF NOT EXISTS topics (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  color          TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','merged')),
  merged_into_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  created_by     TEXT NOT NULL DEFAULT 'manual' CHECK (created_by IN ('manual','ai')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_name_active ON topics (LOWER(name)) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS topic_aliases (
  id         TEXT PRIMARY KEY,
  topic_id   TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  alias      TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'manual' CHECK (created_by IN ('manual','ai')),
  created_at TEXT NOT NULL,
  UNIQUE (topic_id, alias)
);

CREATE TABLE IF NOT EXISTS suggestion_runs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'cluster_candidates',
  model         TEXT,
  embedding_model TEXT,
  params_json   TEXT NOT NULL DEFAULT '{}',
  stats_json    TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  error         TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);

CREATE TABLE IF NOT EXISTS topic_memberships (
  id             TEXT PRIMARY KEY,
  topic_id       TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('goal','task','milestone','resource','meeting','journal_entry','note')),
  entity_id      TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','imported','ai_suggested','ai_accepted')),
  status         TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('suggested','accepted','rejected','superseded')),
  confidence     REAL NOT NULL DEFAULT 1.0,
  -- Explainability: evidence_json holds the signals that produced this row
  -- (cosine scores, graph paths, alias matches, co-citations), reason_codes
  -- is a compact machine-readable list ('embedding_similarity','graph_neighbor',...)
  evidence_json  TEXT NOT NULL DEFAULT '{}',
  reason_codes   TEXT NOT NULL DEFAULT '[]',
  suggestion_run_id TEXT REFERENCES suggestion_runs(id) ON DELETE SET NULL,
  decided_at     TEXT,
  decided_by     TEXT CHECK (decided_by IN ('user','policy') OR decided_by IS NULL),
  row_version    INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (topic_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_topic_memberships_entity ON topic_memberships(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_topic_memberships_status ON topic_memberships(status) WHERE status = 'suggested';

-- M-019: chat_messages carry structured metadata (actions with proposal ids,
-- feasibility, citations) so reloading a conversation restores its cards.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS metadata_json TEXT;

-- M-022: append-only agent execution ledger. Agent runs are durable summaries;
-- events are the ordered audit trail used by the UI and Obsidian projection.
CREATE TABLE IF NOT EXISTS agent_runs (
  id                 TEXT PRIMARY KEY,
  source             TEXT NOT NULL DEFAULT 'copilot',
  agent_kind         TEXT NOT NULL DEFAULT 'semantic_planner',
  session_id         TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  user_message       TEXT NOT NULL DEFAULT '',
  intent             TEXT,
  intent_confidence  REAL CHECK (intent_confidence BETWEEN 0 AND 1 OR intent_confidence IS NULL),
  model              TEXT,
  status             TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','cancelled')),
  summary            TEXT,
  error              TEXT,
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  metadata_json      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_events (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence      INTEGER NOT NULL,
  event_type    TEXT NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT,
  status        TEXT NOT NULL DEFAULT 'recorded',
  data_json     TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_events(run_id, sequence);

-- M-020: journal entries created from a Capture note remember their source so
-- re-logging the same note UPDATES the entry (and re-ingests) instead of
-- creating a duplicate.
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS source_note_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_source_note
  ON journal_entries (source_note_id) WHERE source_note_id IS NOT NULL;

-- M-021: Real date-based planning (replaces vague Q1/Q2-style deadlines).
-- Semantics: start_date = may begin; target_date = would like to finish;
-- hard_deadline = must be done; scheduling_enabled = Amina may place it on the
-- calendar (only ever acts when a date AND a duration exist).
ALTER TABLE goals ADD COLUMN IF NOT EXISTS start_date TEXT;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS target_date TEXT;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS hard_deadline TEXT;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS deadline_type TEXT CHECK (deadline_type IN ('soft','hard','estimated') OR deadline_type IS NULL);
ALTER TABLE goals ADD COLUMN IF NOT EXISTS deadline_confidence TEXT CHECK (deadline_confidence IN ('low','medium','high') OR deadline_confidence IS NULL);
ALTER TABLE goals ADD COLUMN IF NOT EXISTS scheduling_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS estimated_minutes INTEGER;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS plan_status TEXT NOT NULL DEFAULT 'in_progress'
  CHECK (plan_status IN ('not_started','planned','in_progress','paused','blocked','completed'));

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_date TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS hard_deadline TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline_type TEXT CHECK (deadline_type IN ('soft','hard','estimated') OR deadline_type IS NULL);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline_confidence TEXT CHECK (deadline_confidence IN ('low','medium','high') OR deadline_confidence IS NULL);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scheduling_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS flexibility TEXT CHECK (flexibility IN ('flexible','fixed','urgent') OR flexibility IS NULL);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS can_split BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS min_session_minutes INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS feel_score INTEGER CHECK (feel_score BETWEEN 0 AND 100);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS time_rollup_mode TEXT NOT NULL DEFAULT 'additive'
  CHECK (time_rollup_mode IN ('additive','inclusive'));

ALTER TABLE goal_milestones ADD COLUMN IF NOT EXISTS start_date TEXT;
ALTER TABLE goal_milestones ADD COLUMN IF NOT EXISTS hard_deadline TEXT;
ALTER TABLE goal_milestones ADD COLUMN IF NOT EXISTS scheduling_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE goal_milestones ADD COLUMN IF NOT EXISTS plan_status TEXT NOT NULL DEFAULT 'planned'
  CHECK (plan_status IN ('not_started','planned','in_progress','paused','blocked','completed'));

-- Backfill: legacy goal.deadline strings that are real ISO dates become
-- target_date; vague ones (Q3 2024, Oct 15…) are left behind and no longer
-- drive planning.
UPDATE goals SET target_date = deadline
  WHERE target_date IS NULL AND deadline ~ '^\d{4}-\d{2}-\d{2}$';
-- Tasks' legacy due_date acts as target_date where none is set.
UPDATE tasks SET target_date = due_date
  WHERE target_date IS NULL AND due_date ~ '^\d{4}-\d{2}-\d{2}$';

-- Journal end-of-day rollup marker (capture wall → journal book)
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS source TEXT;

-- M-023: Durable, encrypted Google Tasks + Calendar synchronization.
-- The connection contains only encrypted OAuth refresh-token material and
-- sync health. Remote IDs live in a generic link table so Amina's canonical
-- goal/task/event rows stay provider-agnostic.
CREATE TABLE IF NOT EXISTS google_sync_connections (
  id                      TEXT PRIMARY KEY DEFAULT 'primary',
  account_email           TEXT,
  encrypted_refresh_token TEXT NOT NULL,
  calendar_id             TEXT,
  calendar_name           TEXT NOT NULL DEFAULT 'Amina Schedule',
  initial_sync_complete   BOOLEAN NOT NULL DEFAULT false,
  auto_sync_enabled       BOOLEAN NOT NULL DEFAULT true,
  last_synced_at          TEXT,
  last_error              TEXT,
  sync_lease_until        TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS google_sync_links (
  id                     TEXT PRIMARY KEY,
  connection_id          TEXT NOT NULL DEFAULT 'primary' REFERENCES google_sync_connections(id) ON DELETE CASCADE,
  entity_type            TEXT NOT NULL CHECK (entity_type IN ('goal','task','event','meeting','task_day','system')),
  entity_id              TEXT NOT NULL,
  remote_type            TEXT NOT NULL CHECK (remote_type IN ('task_list','task','calendar_event')),
  remote_container_id    TEXT,
  remote_id              TEXT NOT NULL,
  remote_etag            TEXT,
  remote_updated_at      TEXT,
  local_updated_at       TEXT,
  sync_status            TEXT NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced','conflict','remote_deleted','error')),
  conflict_json          TEXT,
  last_synced_at         TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (connection_id, remote_type, entity_type, entity_id),
  UNIQUE (connection_id, remote_type, remote_container_id, remote_id)
);
CREATE INDEX IF NOT EXISTS idx_google_sync_links_remote
  ON google_sync_links(connection_id, remote_type, remote_container_id, remote_id);
CREATE INDEX IF NOT EXISTS idx_google_sync_links_status
  ON google_sync_links(connection_id, sync_status);

-- Backfill existing migrations so the registry reflects current state
INSERT INTO schema_migrations (name) VALUES
  ('M-001-rename-payload'),
  ('M-002-embedding-dimension'),
  ('M-003-entity-summaries-tracking'),
  ('M-004-work-sessions-journal-id'),
  ('M-005-journal-ingestion-attempts'),
  ('M-006-embedding-jobs-backoff'),
  ('M-006b-embedding-jobs-lease'),
  ('M-007-edges-confidence'),
  ('M-008-resource-chunks-metadata'),
  ('M-009-indexes'),
  ('M-010-idempotency-constraints'),
  ('M-011-gemini-embedding-3072'),
  ('M-012-schedule-prefs-timezone'),
  ('M-013-proposal-idempotency-key'),
  ('M-013a-extracted-facts-needs-review'),
  ('M-014-task-fk-constraints'),
  ('M-015-work-session-fk-constraints'),
  ('M-016-unique-pending-embedding-job'),
  ('M-017-journal-ai-tags-column'),
  ('M-018-semantic-topics'),
  ('M-019-chat-message-metadata'),
  ('M-020-journal-source-note'),
  ('M-021-real-date-planning'),
  ('M-023-google-workspace-sync')
ON CONFLICT (name) DO NOTHING;

-- M-024: Routines. Production rollout uses migrations/024-routines.sql only.
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
