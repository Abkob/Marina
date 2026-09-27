import { activeTaskSql, activeEntitySql } from '../utils/archiveVisibility.js';
import { query } from '../db.js';
import {
  embedQuery,
  EMBED_DIMENSION,
  EMBED_MODEL,
} from '../embeddingProvider.js';

export interface EntityCard {
  entity_type: string;
  entity_id: string;
  title: string;
  status?: string;
  priority?: string;
  feel_score?: number | null;
  due_date?: string | null;
  estimated_minutes?: number | null;
  logged_minutes?: number;
  remaining_minutes?: number | null;
  planning_summary?: string | null;
  semantic_summary?: string | null;
  blocker_ids?: string[];
  evidence_facts?: string[];
  goal_id?: string | null;
  milestone_id?: string | null;
  similarity?: number;
  /** Accepted topic names this entity belongs to — manual/accepted signals, not raw similarity. */
  topics?: string[];
  /** Which retrieval lanes surfaced this card: 'sql' | 'graph' | 'vector' | 'topic'. */
  matched_via?: string[];
}

export interface RetrievalResult {
  cards: EntityCard[];
  /** True when vector retrieval was unavailable (Gemini error, pgvector absent, etc.) */
  vector_degraded: boolean;
  /** Human-readable reason for degradation, or null when fully healthy */
  vector_degraded_reason: string | null;
}

interface RetrievalOptions {
  query?: string;
  goalIds?: string[];
  entityTypes?: string[];
  horizonDays?: number;
  limit?: number;
}

// ─── SQL retrieval ────────────────────────────────────────────────────────────

async function sqlRetrieval(opts: RetrievalOptions): Promise<EntityCard[]> {
  const horizon = opts.horizonDays ?? 14;
  const toLocalDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const horizonDate = new Date(now);
  horizonDate.setDate(horizonDate.getDate() + horizon);
  const horizonStr = toLocalDate(horizonDate);
  const todayStr = toLocalDate(now);

  // Three lanes to ensure full coverage (Epic 20):
  // 1. Tasks with due_date within [overdue, horizon] — dated tasks in view
  // 2. In-progress tasks regardless of date — always relevant
  // 3. ALL undated tasks (not just high/medium) — without this, backlog tasks are invisible to AI
  let sql = `
    SELECT t.id, t.title, t.status, t.priority, t.feel_score, t.due_date, t.estimated_minutes,
           t.actual_minutes, t.goal_id, t.milestone_id,
           COALESCE(ws.logged, 0) as logged_minutes,
           es_plan.summary_text as planning_summary,
           es_sem.summary_text as semantic_summary
    FROM tasks t
    LEFT JOIN goals g ON g.id = t.goal_id
    LEFT JOIN (
      SELECT task_id, SUM(minutes) as logged FROM work_sessions
      WHERE minutes IS NOT NULL GROUP BY task_id
    ) ws ON ws.task_id = t.id
    LEFT JOIN entity_summaries es_plan ON es_plan.entity_type='task' AND es_plan.entity_id=t.id AND es_plan.summary_type='planning'
    LEFT JOIN entity_summaries es_sem ON es_sem.entity_type='task' AND es_sem.entity_id=t.id AND es_sem.summary_type='semantic'
    WHERE t.completed = false AND ${activeTaskSql('t.id')}
      AND t.status <> 'done'
      AND (g.archived_at IS NULL OR t.goal_id IS NULL)
      AND (
        (t.due_date IS NOT NULL AND t.due_date <= $1)
        OR t.status IN ('in_progress', 'blocked')
        OR t.due_date IS NULL
      )
  `;
  const params: unknown[] = [horizonStr];

  if (opts.goalIds?.length) {
    params.push(opts.goalIds);
    sql += ` AND t.goal_id = ANY($${params.length})`;
  }

  // Sort: overdue/due-soon first, then by priority; undated tasks come after dated ones
  sql += ` ORDER BY
           (t.due_date IS NULL)::int ASC,
           t.due_date ASC,
           CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC`;

  const { rows } = await query(sql, params);

  return rows.map((r: Record<string, unknown>) => {
    const est = Number(r.estimated_minutes ?? 0);
    const logged = Number(r.logged_minutes ?? 0);
    return {
      entity_type: 'task',
      entity_id: r.id as string,
      title: r.title as string,
      status: r.status as string,
      priority: r.priority as string,
      feel_score: r.feel_score == null ? null : Number(r.feel_score),
      due_date: r.due_date as string | null,
      estimated_minutes: est || null,
      logged_minutes: logged,
      remaining_minutes: est > 0 ? Math.max(0, est - logged) : null,
      planning_summary: (r.planning_summary as string | null) ?? null,
      semantic_summary: (r.semantic_summary as string | null) ?? null,
      goal_id: r.goal_id as string | null,
      milestone_id: r.milestone_id as string | null,
    };
  });
}

// ─── Graph expansion ──────────────────────────────────────────────────────────

// 50 neighbors keeps graph expansion bounded; the prior 200 was unreviewed default.
const GRAPH_MAX_NEIGHBORS = 50;

// Only traverse relationships that are relevant for planning context.
// Excludes 'references' and 'linked_to' (generic/bidirectional) to avoid irrelevant noise.
const PLANNING_RELATIONSHIPS = [
  'contains', 'subtask_of', 'mentioned_in', 'extracted_to', 'attached_to', 'schedules',
];

async function graphRetrieval(seedEntityIds: string[], depth = 1): Promise<EntityCard[]> {
  if (!seedEntityIds.length) return [];

  let frontier = [...seedEntityIds];
  const visited = new Set(seedEntityIds);
  const neighbors: string[] = [];

  for (let d = 0; d < depth; d++) {
    if (!frontier.length || neighbors.length >= GRAPH_MAX_NEIGHBORS) break;
    const { rows } = await query(
      `SELECT DISTINCT
         CASE WHEN source_id = ANY($1) THEN target_id ELSE source_id END as neighbor_id,
         CASE WHEN source_id = ANY($1) THEN target_type ELSE source_type END as neighbor_type
       FROM edges
       WHERE (source_id = ANY($1) OR target_id = ANY($1))
         AND relationship = ANY($2) AND ${activeEntitySql('source_type', 'source_id')} AND ${activeEntitySql('target_type', 'target_id')}`,
      [frontier, PLANNING_RELATIONSHIPS],
    ) as { rows: { neighbor_id: string; neighbor_type: string }[] };

    const newIds: string[] = [];
    for (const row of rows) {
      if (neighbors.length >= GRAPH_MAX_NEIGHBORS) break;
      if (!visited.has(row.neighbor_id)) {
        visited.add(row.neighbor_id);
        neighbors.push(row.neighbor_id);
        newIds.push(row.neighbor_id);
      }
    }
    frontier = newIds;
  }

  if (!neighbors.length) return [];

  // Fetch task-type neighbors as entity cards (main use case for planning context)
  const { rows: taskRows } = await query(
    `SELECT t.id, t.title, t.status, t.priority, t.feel_score, t.due_date, t.estimated_minutes,
            t.actual_minutes, t.goal_id, t.milestone_id,
            COALESCE(ws.logged, 0) as logged_minutes,
            es.summary_text as planning_summary
     FROM tasks t
     LEFT JOIN (SELECT task_id, SUM(minutes) as logged FROM work_sessions WHERE minutes IS NOT NULL GROUP BY task_id) ws ON ws.task_id=t.id
     LEFT JOIN entity_summaries es ON es.entity_type='task' AND es.entity_id=t.id AND es.summary_type='planning'
     WHERE t.id = ANY($1) AND t.completed = false AND ${activeTaskSql('t.id')}`,
    [neighbors],
  );

  return taskRows.map((r: Record<string, unknown>) => ({
    entity_type: 'task',
    entity_id: r.id as string,
    title: r.title as string,
    status: r.status as string,
    priority: r.priority as string,
    feel_score: r.feel_score == null ? null : Number(r.feel_score),
    due_date: r.due_date as string | null,
    estimated_minutes: Number(r.estimated_minutes ?? 0) || null,
    logged_minutes: Number(r.logged_minutes ?? 0),
    remaining_minutes: r.estimated_minutes ? Math.max(0, Number(r.estimated_minutes) - Number(r.logged_minutes ?? 0)) : null,
    planning_summary: (r.planning_summary as string | null) ?? null,
    goal_id: r.goal_id as string | null,
    milestone_id: r.milestone_id as string | null,
  }));
}

// ─── Vector retrieval ─────────────────────────────────────────────────────────

interface VectorRetrievalResult {
  cards: (EntityCard & { similarity: number })[];
  degraded: boolean;
  degraded_reason: string | null;
}

async function vectorRetrieval(
  queryText: string,
  entityTypes: string[],
  limit: number,
): Promise<VectorRetrievalResult> {
  try {
    const vec = await embedQuery(queryText);
    const vectorStr = `[${vec.join(',')}]`;

    let sql = `
      SELECT e.entity_type, e.entity_id, 1 - (e.embedding_3072 <=> $1::halfvec) as similarity,
             es.summary_text as planning_summary
      FROM embeddings e
      LEFT JOIN entity_summaries es ON es.entity_type=e.entity_type AND es.entity_id=e.entity_id AND es.summary_type='planning'
      WHERE e.is_stale = false AND ${activeEntitySql('e.entity_type', 'e.entity_id')}
        AND e.embedding_3072 IS NOT NULL
        AND e.embedding_model = $2
        AND e.embedding_dimension = $3
    `;
    const params: unknown[] = [vectorStr, EMBED_MODEL, EMBED_DIMENSION];

    if (entityTypes.length) {
      params.push(entityTypes);
      sql += ` AND e.entity_type = ANY($${params.length})`;
    }

    sql += ` ORDER BY e.embedding_3072 <=> $1::halfvec LIMIT $${params.length + 1}`;
    params.push(limit);

    const { rows } = await query(sql, params);

    const cards = rows.map((r: Record<string, unknown>) => ({
      entity_type: r.entity_type as string,
      entity_id: r.entity_id as string,
      title: '', // Hydrated from SQL results by RRF caller
      similarity: Number(r.similarity),
      planning_summary: (r.planning_summary as string | null) ?? null,
    }));

    return { cards, degraded: false, degraded_reason: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn('[retrieval] Vector retrieval degraded:', reason);
    return { cards: [], degraded: true, degraded_reason: reason };
  }
}

// ─── Reciprocal Rank Fusion ───────────────────────────────────────────────────

function reciprocalRankFusion(resultLists: EntityCard[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of resultLists) {
    list.forEach((item, rank) => {
      const key = `${item.entity_type}:${item.entity_id}`;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

// ─── Enrich cards with blockers and evidence facts ────────────────────────────

async function enrichCards(cards: EntityCard[]): Promise<EntityCard[]> {
  if (!cards.length) return cards;
  const taskIds = cards.filter(c => c.entity_type === 'task').map(c => c.entity_id);
  if (!taskIds.length) return cards;

  const { rows: blockerEdges } = await query(
    `SELECT target_id as task_id, source_id as blocker_id FROM edges
     WHERE relationship='blocks' AND ${activeTaskSql('source_id')} AND target_id = ANY($1) AND source_type='task'`,
    [taskIds],
  ) as { rows: { task_id: string; blocker_id: string }[] };

  const { rows: facts } = await query(
    `SELECT target_id as entity_id, fact_text FROM extracted_facts
     WHERE target_type='task' AND target_id = ANY($1)
       AND fact_type IN ('risk','blocker','decision') AND status='active'
     ORDER BY confidence DESC`,
    [taskIds],
  ) as { rows: { entity_id: string; fact_text: string }[] };

  const blockerMap = new Map<string, string[]>();
  for (const e of blockerEdges) {
    if (!blockerMap.has(e.task_id)) blockerMap.set(e.task_id, []);
    blockerMap.get(e.task_id)!.push(e.blocker_id);
  }

  const factMap = new Map<string, string[]>();
  for (const f of facts) {
    if (!factMap.has(f.entity_id)) factMap.set(f.entity_id, []);
    factMap.get(f.entity_id)!.push(f.fact_text);
  }

  return cards.map(c => ({
    ...c,
    blocker_ids: blockerMap.get(c.entity_id) ?? [],
    evidence_facts: factMap.get(c.entity_id)?.slice(0, 2) ?? [],
  }));
}

// ─── Topic retrieval lane ─────────────────────────────────────────────────────
// When the user's query names a topic (by name or alias), that topic's ACCEPTED
// members are strong candidates: they carry manual/accepted authority, which
// outranks raw embedding similarity.

async function topicRetrieval(queryText: string): Promise<EntityCard[]> {
  try {
    const q = queryText.toLowerCase();
    const { rows: topicRows } = await query<{ id: string; name: string }>(
      `SELECT DISTINCT tp.id, tp.name
       FROM topics tp
       LEFT JOIN topic_aliases ta ON ta.topic_id = tp.id
       WHERE tp.status = 'active'
         AND ($1 LIKE '%' || LOWER(tp.name) || '%' OR ($1 LIKE '%' || ta.alias || '%' AND LENGTH(ta.alias) >= 3))`,
      [q],
    );
    if (!topicRows.length) return [];
    const { rows: members } = await query<{ entity_type: string; entity_id: string; topic_name: string }>(
      `SELECT tm.entity_type, tm.entity_id, tp.name AS topic_name
       FROM topic_memberships tm
       JOIN topics tp ON tp.id = tm.topic_id
       WHERE tm.topic_id = ANY($1) AND tm.status = 'accepted' AND ${activeEntitySql('tm.entity_type', 'tm.entity_id')}
       ORDER BY (tm.source = 'manual') DESC, tm.confidence DESC
       LIMIT 40`,
      [topicRows.map(t => t.id)],
    );
    return members.map(m => ({
      entity_type: m.entity_type,
      entity_id: m.entity_id,
      title: '', // hydrated later like vector-only results
      topics: [m.topic_name],
    }));
  } catch {
    // topics tables may not exist on a partially migrated DB — degrade silently
    return [];
  }
}

/** Attaches accepted topic names to the final card set so the model sees cluster context. */
async function annotateTopics(cards: EntityCard[]): Promise<void> {
  if (!cards.length) return;
  try {
    const keys = cards.map(c => `${c.entity_type}:${c.entity_id}`);
    const { rows } = await query<{ entity_type: string; entity_id: string; name: string }>(
      `SELECT tm.entity_type, tm.entity_id, tp.name
       FROM topic_memberships tm
       JOIN topics tp ON tp.id = tm.topic_id AND tp.status = 'active'
       WHERE tm.status = 'accepted' AND (tm.entity_type || ':' || tm.entity_id) = ANY($1)`,
      [keys],
    );
    const byKey = new Map<string, string[]>();
    for (const r of rows) {
      const k = `${r.entity_type}:${r.entity_id}`;
      byKey.set(k, [...(byKey.get(k) ?? []), r.name]);
    }
    for (const c of cards) {
      const names = byKey.get(`${c.entity_type}:${c.entity_id}`);
      if (names?.length) c.topics = names;
    }
  } catch { /* pre-migration DB — annotations are optional */ }
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function buildRetrievalContext(opts: RetrievalOptions): Promise<RetrievalResult> {
  const limit = opts.limit ?? 30;
  const entityTypes = opts.entityTypes ?? ['task', 'milestone'];

  const [sqlResults, vectorResult, topicResults] = await Promise.all([
    sqlRetrieval(opts),
    opts.query
      ? vectorRetrieval(opts.query, entityTypes, Math.ceil(limit * 0.5))
      : Promise.resolve({ cards: [], degraded: false, degraded_reason: null }),
    opts.query ? topicRetrieval(opts.query) : Promise.resolve([]),
  ]);

  const vectorResults = vectorResult.cards;
  const sqlSeeds = sqlResults.map(c => c.entity_id);
  const graphResults = sqlSeeds.length ? await graphRetrieval(sqlSeeds, 1) : [];

  // RRF over all signals. The topic lane appears twice: accepted/manual
  // memberships carry more authority than any single similarity lane.
  const scores = reciprocalRankFusion([sqlResults, graphResults, vectorResults, topicResults, topicResults]);

  // Lane provenance: record which lanes surfaced each entity so downstream
  // consumers (chat citations) can explain WHY something was in context.
  const lanesByKey = new Map<string, Set<string>>();
  const laneLists: Array<[string, EntityCard[]]> = [
    ['sql', sqlResults], ['graph', graphResults], ['vector', vectorResults], ['topic', topicResults],
  ];
  for (const [lane, list] of laneLists) {
    for (const c of list) {
      const key = `${c.entity_type}:${c.entity_id}`;
      if (!lanesByKey.has(key)) lanesByKey.set(key, new Set());
      lanesByKey.get(key)!.add(lane);
    }
  }

  // Build deduped candidate list keyed by entity_type:entity_id
  const allById = new Map<string, EntityCard>();
  for (const c of [...sqlResults, ...graphResults, ...vectorResults, ...topicResults]) {
    const key = `${c.entity_type}:${c.entity_id}`;
    if (!allById.has(key)) allById.set(key, c);
    // similarity lives on the vector-lane card; carry it onto the kept card
    if (c.similarity !== undefined && allById.get(key)!.similarity === undefined) {
      allById.get(key)!.similarity = c.similarity;
    }
  }
  for (const [key, card] of allById) {
    card.matched_via = [...(lanesByKey.get(key) ?? [])];
  }

  // Sort by RRF score, cap at limit
  const sorted = [...allById.values()]
    .map(c => ({ card: c, score: scores.get(`${c.entity_type}:${c.entity_id}`) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.card);

  // Hydrate any vector/topic-lane results that have no title (those lanes return title:'')
  const untitledTasks = sorted.filter(c => !c.title && c.entity_type === 'task');
  if (untitledTasks.length) {
    const ids = untitledTasks.map(c => c.entity_id);
    const { rows: hydrated } = await query<{ id: string; title: string; status: string; priority: string }>(
      `SELECT id, title, status, priority FROM tasks WHERE id = ANY($1) AND ${activeTaskSql()}`,
      [ids],
    );
    const hydrationMap = new Map(hydrated.map(r => [r.id, r]));
    for (const card of sorted) {
      if (!card.title && card.entity_type === 'task') {
        const h = hydrationMap.get(card.entity_id);
        if (h) {
          card.title = h.title;
          if (!card.status) card.status = h.status;
          if (!card.priority) card.priority = h.priority;
        }
      }
    }
  }
  // Non-task types from the topic lane: hydrate titles from their own tables
  const TITLE_TABLES: Record<string, { table: string; col: string }> = {
    goal: { table: 'goals', col: 'title' },
    milestone: { table: 'goal_milestones', col: 'title' },
    resource: { table: 'resources', col: 'title' },
    meeting: { table: 'meetings', col: 'title' },
    note: { table: 'notes', col: 'title' },
    journal_entry: { table: 'journal_entries', col: 'entry_date' },
  };
  for (const [etype, spec] of Object.entries(TITLE_TABLES)) {
    const untitled = sorted.filter(c => !c.title && c.entity_type === etype);
    if (!untitled.length) continue;
    const { rows: hydrated } = await query<{ id: string; title: string }>(
      `SELECT id, ${spec.col} AS title FROM ${spec.table} WHERE id = ANY($1)`,
      [untitled.map(c => c.entity_id)],
    );
    const hmap = new Map(hydrated.map(r => [r.id, r.title]));
    for (const card of untitled) card.title = hmap.get(card.entity_id) ?? card.title;
  }

  // Budget trim: keep cards until total planning_summary chars exceed 20,000.
  // Always include at least 1 card regardless of summary length.
  const SUMMARY_BUDGET = 20_000;
  let budgetUsed = 0;
  const budgeted: EntityCard[] = [];
  for (const card of sorted) {
    const len = card.planning_summary?.length ?? 0;
    if (budgeted.length > 0 && budgetUsed + len > SUMMARY_BUDGET) break;
    budgeted.push(card);
    budgetUsed += len;
  }

  const enriched = await enrichCards(budgeted);
  await annotateTopics(enriched);
  return {
    cards: enriched,
    vector_degraded: vectorResult.degraded,
    vector_degraded_reason: vectorResult.degraded_reason,
  };
}
