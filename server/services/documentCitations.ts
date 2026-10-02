import { z } from 'zod';

const sourceSchema = z.object({ resource_id: z.string().min(1).max(100), title: z.string().max(1000),
  source_url: z.string().refine(url => /^https:\/\/drive\.google\.com\/file\/d\/[\w-]+\/view$/.test(url) || /^\/api\/resources\/blob\/[\w-]+$/.test(url)),
  page_start: z.number().int().positive().nullable().optional(), page_end: z.number().int().positive().nullable().optional(),
});
export type DocumentCitation = { entity_type: 'resource'; entity_id: string; title: string; matched_via: string[]; source_url: string; page_start: number | null; page_end: number | null };

export function documentEvidenceWarning(tool: string, data: unknown): string | null {
  if (tool !== 'inspect_document_page' || !data || typeof data !== 'object' || !('vision_unavailable' in data) || data.vision_unavailable !== true) return null;
  const source = sourceSchema.safeParse(data);
  if (!source.success) return null;
  const page = source.data.page_start ? `, p. ${source.data.page_start}` : '';
  return `Visual analysis was unavailable for [this source${page}](${source.data.source_url}). Only OCR text was read; chart shapes, colors and relationships were not verified.`;
}

/** Only successful evidence reads supply source links; discovery alone is not evidence. */
export function documentCitations(tool: string, data: unknown): DocumentCitation[] {
  if (!data || typeof data !== 'object') return [];
  const value = data as Record<string, unknown>;
  let candidates: unknown[] = [];
  if (tool === 'search_documents' && Array.isArray(value.evidence)) candidates = value.evidence;
  if (tool === 'read_document' && Array.isArray(value.passages)) candidates = value.passages.map(row => ({ ...value, ...(row && typeof row === 'object' ? row : {}) }));
  if (tool === 'inspect_document_page' && [value.analysis, value.text].some(text => typeof text === 'string' && text.trim())) candidates = [value];
  return candidates.slice(0, 20).flatMap(candidate => {
    const parsed = sourceSchema.safeParse(candidate);
    if (!parsed.success) return [];
    const row = parsed.data;
    return [{ entity_type: 'resource' as const, entity_id: row.resource_id, title: row.title, source_url: row.source_url,
      page_start: row.page_start ?? null, page_end: row.page_end ?? null, matched_via: [documentEvidenceWarning(tool, data) ? 'OCR fallback' : tool === 'inspect_document_page' ? 'page inspected' : 'text read'] }];
  });
}
