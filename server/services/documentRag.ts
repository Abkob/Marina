import { query } from '../db.js';
import { embedQuery, EMBED_MODEL, EMBED_DIMENSION } from '../embeddingProvider.js';
import { activeResourceSql } from '../utils/archiveVisibility.js';
type Passage = { resource_id: string; title: string; chunk_id: string; content: string; page_start: number | null; page_end: number | null; file_id: string | null; checked_at: string | null; last_error: string | null };
const visible = `${activeResourceSql('r.id')} AND r.file_validation='valid' AND j.status='ready' AND (d.resource_id IS NULL OR d.available)`;
const joins = `FROM resource_chunks c JOIN resources r ON r.id=c.resource_id
  JOIN resource_processing_jobs j ON j.resource_id=r.id LEFT JOIN resource_drive_files d ON d.resource_id=r.id AND r.file_path LIKE 'gdrive://%'`;
const fields = 'r.id AS resource_id,r.title,c.id AS chunk_id,c.content,c.page_start,c.page_end,d.file_id,d.checked_at,d.last_error';
/** Every returned passage is persisted, belongs to a ready/visible resource,
 * and carries an immutable resource/chunk identity and source link. */
export async function searchDocuments(text: string, resourceIds: string[] = [], limit = 8) {
  const bounded = Math.max(1, Math.min(12, Math.trunc(limit) || 8));
  const scope = resourceIds.length ? 'AND r.id=ANY($2::text[])' : '';
  const queryText = text.trim().slice(0, 2000);
  if (!queryText) return { evidence: [], vector_degraded: false, resources: [] };
  const lexical = await query<Passage>(`SELECT ${fields} ${joins}
    WHERE ${visible} ${scope} AND to_tsvector('simple',c.content) @@ plainto_tsquery('simple',$1)
    ORDER BY ts_rank_cd(to_tsvector('simple',c.content),plainto_tsquery('simple',$1)) DESC,c.id LIMIT ${bounded * 3}`,
  resourceIds.length ? [queryText, resourceIds] : [queryText]);
  let vector: Passage[] = []; let degraded = false;
  try {
    const values = await embedQuery(queryText);
    const result = await query<Passage>(`SELECT ${fields} ${joins}
      JOIN embeddings e ON e.entity_type='resource_chunk' AND e.entity_id=c.id
      WHERE ${visible} AND NOT e.is_stale AND e.embedding_3072 IS NOT NULL
        AND e.embedding_model=$2 AND e.embedding_dimension=$3 ${resourceIds.length ? 'AND r.id=ANY($4::text[])' : ''}
      ORDER BY e.embedding_3072 <=> $1::halfvec LIMIT ${bounded * 3}`,
    [`[${values.join(',')}]`, EMBED_MODEL, EMBED_DIMENSION, ...(resourceIds.length ? [resourceIds] : [])]);
    vector = result.rows;
  } catch { degraded = true; }
  const merged = new Map<string, { row: Passage; score: number }>();
  for (const lane of [lexical.rows, vector]) lane.forEach((row, index) => {
    const entry = merged.get(row.chunk_id) ?? { row, score: 0 };
    entry.score += 1 / (60 + index + 1); merged.set(row.chunk_id, entry);
  });
  const resources = resourceIds.length ? (await query(`SELECT r.id,r.title,COALESCE(j.status,'not_started') AS status,j.error
    FROM resources r LEFT JOIN resource_processing_jobs j ON j.resource_id=r.id WHERE r.id=ANY($1) AND ${activeResourceSql('r.id')}`, [resourceIds])).rows : [];
  return { evidence: [...merged.values()].sort((a,b) => b.score-a.score).slice(0,bounded).map(({ row }) => ({
    resource_id: row.resource_id, title: row.title, chunk_id: row.chunk_id, passage: row.content.slice(0, 2400),
    page_start: row.page_start, page_end: row.page_end, source_url: row.file_id ? `https://drive.google.com/file/d/${row.file_id}/view` : `/api/resources/blob/${row.resource_id}`,
    last_source_check: row.last_error ? null : row.checked_at, source_check_error: row.last_error,
  })), vector_degraded: degraded, resources, missing_resource_ids: resourceIds.filter(id => !resources.some(row => row.id === id)) };
}
