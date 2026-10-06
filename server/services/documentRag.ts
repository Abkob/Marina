import {EMBED_TABLE, EMBED_COLUMN} from '../config/providers.js';
import { query } from '../db.js';
import { embedQuery, EMBED_MODEL, EMBED_DIMENSION } from '../embeddingProvider.js';
import { activeResourceSql } from '../utils/archiveVisibility.js';
import { MAX_RERANK_PASSAGES, rerankPassages } from './nvidiaEvidence.js';
import { resourceScopeSql, type ResourceScope } from './resourceContext.js';
import { filterRootedDriveRows, DRIVE_FILE_ID_SQL } from './driveResourceAccess.js';
import { chunkEvidence } from './chunkEvidence.js';
import {documentExcerpt} from './documentExcerpt.js';
type Passage = { resource_id: string; title: string; chunk_id: string; content: string; page_start: number | null; page_end: number | null; file_id: string | null; checked_at: string | null; last_error: string | null; chunk_metadata?: string };
const visible = `${activeResourceSql('r.id')} AND r.file_validation='valid' AND j.status='ready' AND (d.resource_id IS NULL OR d.available)`;
const joins = `FROM resource_chunks c JOIN resources r ON r.id=c.resource_id
  JOIN resource_processing_jobs j ON j.resource_id=r.id LEFT JOIN resource_drive_files d ON d.resource_id=r.id AND r.file_path LIKE 'gdrive://%'`;
const fields = `r.id AS resource_id,r.title,c.id AS chunk_id,c.content,c.page_start,c.page_end,c.chunk_metadata,${DRIVE_FILE_ID_SQL} AS file_id,d.checked_at,d.last_error`;
export function selectSourceCoverage<T extends { resource_id: string }>(ranked: T[], requested: string[], limit: number): T[] {
  const selected: T[] = [];
  const requestedSet = new Set(requested), represented = new Set<string>();
  // When fewer slots than sources are available, preserve relevance order.
  // The user's selection order must not override semantic/reranker ranking.
  for (const row of ranked) {
    if (requestedSet.has(row.resource_id) && !represented.has(row.resource_id) && selected.length < limit) {
      selected.push(row); represented.add(row.resource_id);
    }
  }
  for (const row of ranked) if (!selected.includes(row) && selected.length < limit) selected.push(row);
  return selected;
}
/** Every returned passage belongs to a ready/visible resource and has source provenance.
 * Ranking identifies candidates, not a guarantee of relevance or exhaustive coverage. */
export async function searchDocuments(text: string, resourceIds: string[] = [], limit = 8, rerankModel?: string, resourceScope: ResourceScope = {}, options: { diversifyResources?: boolean; researchOnly?: boolean } = {}) {
  resourceIds = [...new Set(resourceIds)].slice(0, 20);
  const bounded = Math.max(1, Math.min(12, Math.trunc(limit) || 8));
  const scope = resourceIds.length ? 'AND r.id=ANY($2::text[])' : '';
  const research = options.researchOnly ? 'AND EXISTS (SELECT 1 FROM research_papers rp WHERE rp.resource_id=r.id)' : '';
  const queryText = text.trim().slice(0, 2000);
  if (!queryText) return { evidence: [], vector_degraded: false, resources: [] };
  // Reserve candidates per selected source before the global cut, so a long book
  // cannot crowd a second selected document out of both retrieval lanes.
  const perSource = options.diversifyResources ? 2 : Math.max(2, Math.floor(MAX_RERANK_PASSAGES / Math.max(1, resourceIds.length)));
  const laneLimit = Math.max(24, bounded * 3);
  const lexicalScore = "ts_rank_cd(to_tsvector('simple',c.content),plainto_tsquery('simple',$1))";
  const lexicalRank = `${lexicalScore} DESC,c.id`;
  const laneSql = (base: string, order: string, score: string) => resourceIds.length || options.diversifyResources
    ? `SELECT * FROM (${base.replace('SELECT ', `SELECT ${score} AS lane_score,row_number() OVER (PARTITION BY r.id ORDER BY ${order}) AS source_rank,`)} ) candidates WHERE source_rank<=${perSource} ORDER BY source_rank,lane_score DESC,resource_id LIMIT ${MAX_RERANK_PASSAGES}`
    : `${base} ORDER BY ${order} LIMIT ${laneLimit}`;
  const lexicalValues: unknown[] = resourceIds.length ? [queryText, resourceIds] : [queryText];
  const lexicalScope = resourceScopeSql(resourceScope, lexicalValues);
  const lexical = await query<Passage>(laneSql(`SELECT ${fields} ${joins}
    WHERE ${visible} ${scope} ${lexicalScope} ${research} AND to_tsvector('simple',c.content) @@ plainto_tsquery('simple',$1)
    `, lexicalRank, lexicalScore),
  lexicalValues);
  let vector: Passage[] = []; let degraded = false;
  try {
    const values = await embedQuery(queryText);
    const vectorValues: unknown[] = [`[${values.join(',')}]`, EMBED_MODEL, EMBED_DIMENSION, ...(resourceIds.length ? [resourceIds] : [])];
    const vectorScope = resourceScopeSql(resourceScope, vectorValues);
    const result = await query<Passage>(laneSql(`SELECT ${fields} ${joins}
      JOIN ${EMBED_TABLE} e ON e.entity_type='resource_chunk' AND e.entity_id=c.id
      WHERE ${visible} ${research} AND NOT e.is_stale AND e.${EMBED_COLUMN} IS NOT NULL
        AND e.embedding_model=$2 AND e.embedding_dimension=$3 ${resourceIds.length ? 'AND r.id=ANY($4::text[])' : ''} ${vectorScope}
      `, `e.${EMBED_COLUMN} <=> $1::halfvec,c.id`, `-(e.${EMBED_COLUMN} <=> $1::halfvec)`),
    vectorValues);
    vector = result.rows;
  } catch { degraded = true; }
  const merged = new Map<string, { row: Passage; score: number }>();
  for (const lane of [lexical.rows, vector]) lane.forEach((row, index) => {
    const entry = merged.get(row.chunk_id) ?? { row, score: 0 };
    entry.score += 1 / (60 + index + 1); merged.set(row.chunk_id, entry);
  });
  const statusValues: unknown[] = [resourceIds];
  const statusScope = resourceScopeSql(resourceScope, statusValues);
  const resources = resourceIds.length ? await filterRootedDriveRows((await query(`SELECT r.id,r.title,${DRIVE_FILE_ID_SQL} AS file_id,COALESCE(j.status,'not_started') AS status,j.error
    FROM resources r LEFT JOIN resource_processing_jobs j ON j.resource_id=r.id LEFT JOIN resource_drive_files d ON d.resource_id=r.id AND r.file_path LIKE 'gdrive://%'
    WHERE r.id=ANY($1) AND ${activeResourceSql('r.id')} AND (d.resource_id IS NULL OR d.available) ${statusScope}`, statusValues)).rows) : [];
  const candidates = await filterRootedDriveRows(selectSourceCoverage([...merged.values()].sort((a,b) => b.score-a.score).map(entry => entry.row), resourceIds, MAX_RERANK_PASSAGES));
  const excerpts = candidates.map(row=>({...row,...documentExcerpt(row.content,queryText)}));
  const reranked = await rerankPassages(queryText, excerpts, rerankModel);
  const selected = selectSourceCoverage(reranked.rows, options.diversifyResources ? [...new Set(reranked.rows.map(row => row.resource_id))] : resourceIds, bounded);
  return { evidence: selected.map(row => ({
    resource_id: row.resource_id, title: row.title, chunk_id: row.chunk_id, passage: row.content.slice(0, 2400),
    passage_coverage:row.passage_coverage,passage_start_char:row.passage_start_char,passage_end_char:row.passage_end_char,source_content_chars:row.source_content_chars,
    retrieval_score: merged.get(row.chunk_id)?.score ?? 0,
    page_start: row.page_start, page_end: row.page_end, source_url: row.file_id ? `https://drive.google.com/file/d/${row.file_id}/view` : `/api/resources/blob/${row.resource_id}`,
    last_source_check: row.last_error ? null : row.checked_at, source_check_error: row.last_error,
    ...chunkEvidence(row.chunk_metadata),
  })), vector_degraded: degraded, reranking: reranked.status,
    requested_scope: resourceScope,
    coverage: { exhaustive: false, candidates: candidates.length, returned: selected.length,
      resource_ids_without_evidence: resourceIds.filter(id => !selected.some(row => row.resource_id === id)) },
    resources, missing_resource_ids: resourceIds.filter(id => !resources.some(row => row.id === id)) };
}
