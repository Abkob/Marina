import { query } from '../db.js';
import { searchDocuments } from './documentRag.js';
import type { ResourceScope } from './resourceContext.js';

export interface ResearchEvidence {
  paper_id: string; resource_id: string; title: string; chunk_id: string; heading: string | null; passage: string;
  page_start: number | null; page_end: number | null; score: number; source_url?: string;
}
/** Use the same filtered hybrid index; SQL ranks before the candidate limit, regardless of library size. */
export async function searchResearchEvidence(text: string, limit = 8, scope: ResourceScope = {}): Promise<ResearchEvidence[]> {
  const result = await searchDocuments(text, [], Math.min(12,limit), undefined, scope, { researchOnly: true });
  if (!result.evidence.length) return [];
  const ids = [...new Set(result.evidence.map(row => row.resource_id))];
  const papers = (await query<{ id: string; resource_id: string }>('SELECT id,resource_id FROM research_papers WHERE resource_id=ANY($1::text[]) ORDER BY id', [ids])).rows;
  return result.evidence.flatMap(row => {
    const paper = papers.find(item => item.resource_id === row.resource_id);
    return paper ? [{ ...row, paper_id: paper.id, score: row.retrieval_score, heading: row.heading }] : [];
  });
}
