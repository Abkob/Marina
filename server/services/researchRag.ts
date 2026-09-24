import { query } from '../db.js';
import { activeResourceSql } from '../utils/archiveVisibility.js';

export interface ResearchEvidence {
  paper_id: string;
  resource_id: string;
  title: string;
  chunk_id: string;
  heading: string | null;
  passage: string;
  page_start: number | null;
  page_end: number | null;
  score: number;
}

const terms = (value: string) => [...new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];

/** Citation-safe lexical retrieval. Vector retrieval can be added as another
 * lane; this lane always works and returns only passages actually stored. */
export async function searchResearchEvidence(text: string, limit = 8): Promise<ResearchEvidence[]> {
  const queryTerms = terms(text).slice(0, 20);
  if (!queryTerms.length) return [];
  const { rows } = await query<{
    paper_id: string; resource_id: string; title: string; chunk_id: string;
    heading: string | null; content: string; page_start: number | null; page_end: number | null;
  }>(
    `SELECT rp.id AS paper_id, r.id AS resource_id, r.title, rc.id AS chunk_id,
            rc.heading, rc.content, rc.page_start, rc.page_end
       FROM research_papers rp
       JOIN resources r ON r.id = rp.resource_id
       JOIN resource_chunks rc ON rc.resource_id = r.id
      WHERE ${activeResourceSql('r.id')}
      ORDER BY r.updated_at DESC NULLS LAST, rc.chunk_index ASC
      LIMIT 1000`,
  );

  return rows
    .map(row => {
      const haystack = `${row.title} ${row.heading ?? ''} ${row.content}`.toLowerCase();
      const hits = queryTerms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      const headingHits = queryTerms.reduce((sum, term) => sum + ((row.heading ?? '').toLowerCase().includes(term) ? 1 : 0), 0);
      return {
        paper_id: row.paper_id,
        resource_id: row.resource_id,
        title: row.title,
        chunk_id: row.chunk_id,
        heading: row.heading,
        passage: row.content.slice(0, 1800),
        page_start: row.page_start,
        page_end: row.page_end,
        score: (hits / queryTerms.length) + headingHits * 0.15,
      };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(limit, 25)));
}
