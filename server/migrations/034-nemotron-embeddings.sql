-- Add an isolated profile. Existing Gemini vectors are retained for rollback.
CREATE TABLE IF NOT EXISTS nemotron_embeddings (
 id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
 chunk_id TEXT, embedding_scope TEXT NOT NULL, embedding_text TEXT NOT NULL,
 embedding_2048 TEXT, embedding_model TEXT NOT NULL DEFAULT 'nvidia/nemotron-3-embed-1b'
   CHECK (embedding_model='nvidia/nemotron-3-embed-1b'),
 embedding_dimension INTEGER NOT NULL DEFAULT 2048 CHECK (embedding_dimension=2048),
 embedding_generation TEXT NOT NULL DEFAULT 'nemotron-byte-windows-mean-v1'
   CHECK (embedding_generation='nemotron-byte-windows-mean-v1'),
 content_hash TEXT NOT NULL, is_stale BOOLEAN NOT NULL DEFAULT false,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(entity_type,entity_id,embedding_scope)
);
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector') THEN
  IF (SELECT format_type(a.atttypid,a.atttypmod) FROM pg_attribute a WHERE a.attrelid='nemotron_embeddings'::regclass AND a.attname='embedding_2048') IS DISTINCT FROM 'halfvec(2048)' THEN
   ALTER TABLE nemotron_embeddings ALTER COLUMN embedding_2048 TYPE halfvec(2048) USING embedding_2048::halfvec(2048);
  END IF;
  CREATE INDEX IF NOT EXISTS nemotron_embeddings_hnsw_idx ON nemotron_embeddings USING hnsw(embedding_2048 halfvec_cosine_ops) WHERE embedding_2048 IS NOT NULL AND NOT is_stale;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS nemotron_embeddings_entity_idx ON nemotron_embeddings(entity_type,entity_id);

-- Propagate old-runtime invalidations during a shadow rebuild; never update Gemini from Nemotron.
CREATE OR REPLACE FUNCTION marina_nemotron_legacy_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM nemotron_embeddings WHERE entity_type=OLD.entity_type AND entity_id=OLD.entity_id AND embedding_scope=OLD.embedding_scope;
 ELSE
  IF NEW.is_stale OR NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
   UPDATE nemotron_embeddings SET is_stale=true WHERE entity_type=NEW.entity_type AND entity_id=NEW.entity_id;
  END IF;
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS nemotron_legacy_invalidation ON embeddings;
CREATE TRIGGER nemotron_legacy_invalidation AFTER UPDATE OR DELETE ON embeddings FOR EACH ROW EXECUTE FUNCTION marina_nemotron_legacy_invalidation();

-- New entities may have no Gemini row: invalidate/delete from the authoritative source too.
CREATE OR REPLACE FUNCTION marina_nemotron_source_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fields text[];
BEGIN
 -- Only content used by buildEmbeddingText can invalidate its vector. Runtime
 -- work/version/timestamp bookkeeping must not repeatedly hide unchanged work.
 IF TG_OP='UPDATE' THEN
  fields=CASE TG_ARGV[0]
   WHEN 'task' THEN ARRAY['title','description','goal_id','milestone_id','due_date','estimated_minutes','status','priority','kind']
   WHEN 'goal' THEN ARRAY['title','description','category','status','progress','deadline']
   WHEN 'resource' THEN ARRAY['title','type','description','info','read_state','estimated_minutes','url']
   WHEN 'resource_chunk' THEN ARRAY['resource_id','chunk_index','content','heading','page_start','page_end']
   WHEN 'note' THEN ARRAY['title','date_str','content']
   WHEN 'journal_entry' THEN ARRAY['entry_date','summary','mood','energy_level','raw_text']
   WHEN 'meeting' THEN ARRAY['title','scheduled_at','notes','summary']
   WHEN 'milestone' THEN ARRAY['title','goal_id']
  END;
  IF NOT EXISTS(SELECT 1 FROM unnest(fields) AS key WHERE to_jsonb(NEW)->key IS DISTINCT FROM to_jsonb(OLD)->key) THEN RETURN NULL; END IF;
 END IF;
 IF TG_ARGV[0]='milestone' THEN
  IF TG_OP<>'INSERT' THEN UPDATE nemotron_embeddings SET is_stale=true WHERE entity_type='goal' AND entity_id=OLD.goal_id; END IF;
  IF TG_OP<>'DELETE' THEN UPDATE nemotron_embeddings SET is_stale=true WHERE entity_type='goal' AND entity_id=NEW.goal_id; END IF;
 END IF;
 IF TG_OP='INSERT' THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' THEN
  DELETE FROM nemotron_embeddings WHERE entity_type=TG_ARGV[0] AND entity_id=OLD.id;
 ELSE
  UPDATE nemotron_embeddings SET is_stale=true WHERE entity_type=TG_ARGV[0] AND entity_id=OLD.id;
  IF TG_ARGV[0]='resource' THEN
   UPDATE nemotron_embeddings SET is_stale=true WHERE entity_type='resource_chunk' AND entity_id IN(SELECT id FROM resource_chunks WHERE resource_id=OLD.id);
  ELSIF TG_ARGV[0]='goal' AND to_jsonb(NEW)->'title' IS DISTINCT FROM to_jsonb(OLD)->'title' THEN
   UPDATE nemotron_embeddings SET is_stale=true WHERE entity_type='task' AND entity_id IN(SELECT id FROM tasks WHERE goal_id=OLD.id);
  ELSIF TG_ARGV[0]='milestone' AND to_jsonb(NEW)->'title' IS DISTINCT FROM to_jsonb(OLD)->'title' THEN
   UPDATE nemotron_embeddings SET is_stale=true WHERE entity_type='task' AND entity_id IN(SELECT id FROM tasks WHERE milestone_id=OLD.id);
  END IF;
 END IF;
 RETURN NULL;
END $$;
DO $$
DECLARE item text[]; source text; kind text;
BEGIN
 FOREACH item SLICE 1 IN ARRAY ARRAY[
  ARRAY['tasks','task'],ARRAY['goals','goal'],ARRAY['resources','resource'],
  ARRAY['notes','note'],ARRAY['journal_entries','journal_entry'],ARRAY['meetings','meeting'],
  ARRAY['resource_chunks','resource_chunk'],ARRAY['goal_milestones','milestone']
 ] LOOP
  source=item[1];kind=item[2];
  EXECUTE format('DROP TRIGGER IF EXISTS nemotron_source_invalidation ON %I',source);
  EXECUTE format('CREATE TRIGGER nemotron_source_invalidation AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION marina_nemotron_source_invalidation(%L)',source,kind);
 END LOOP;
END $$;
INSERT INTO schema_migrations(name) VALUES ('M-034-nemotron-embeddings') ON CONFLICT DO NOTHING;
