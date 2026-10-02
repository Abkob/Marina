import { z } from 'zod';

const sourceSchema = z.object({ resource_id: z.string().min(1).max(100), title: z.string().max(1000),
  source_url: z.string().refine(url => /^https:\/\/drive\.google\.com\/file\/d\/[\w-]+\/view$/.test(url) || /^\/api\/resources\/blob\/[\w-]+$/.test(url)),
  page_start: z.number().int().positive().nullable().optional(), page_end: z.number().int().positive().nullable().optional(),
});
export type DocumentCitation = { entity_type: 'resource'; entity_id: string; title: string; matched_via: string[]; source_url: string; page_start: number | null; page_end: number | null;
  excerpt?: string; excerpt_kind?: 'text' | 'ocr' | 'visual' | 'structure'; excerpt_truncated?: boolean; source_tool?: string; chunk_id?: string; model?: string; generation?: number };

/** Copy only evidence actually supplied by a successful tool, never model prose. */
function citationExcerpt(tool: string, candidate: unknown): Partial<DocumentCitation> {
  if (!candidate || typeof candidate !== 'object') return {};
  const value = candidate as Record<string, unknown>;
  const raw = tool === 'inspect_document_page' ? value.text ?? value.analysis : value.passage;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  const text = raw.trim();
  const kind = tool !== 'inspect_document_page' ? (['ocr','visual','structure'].includes(String(value.evidence_kind)) ? value.evidence_kind as 'ocr'|'visual'|'structure' : 'text')
    : typeof value.analysis === 'string' && !value.text ? 'visual'
      : value.evidence_type === 'model_extracted_page_structure' ? 'structure' : 'ocr';
  return { excerpt: text.slice(0, 1200), excerpt_kind: kind, excerpt_truncated: text.length > 1200, source_tool: tool,
    ...(typeof value.model === 'string' && value.model.length <= 200 ? { model: value.model } : {}),
    ...(typeof value.generation === 'number' && Number.isSafeInteger(value.generation) ? { generation: value.generation } : {}),
    ...(typeof value.chunk_id === 'string' && value.chunk_id.length <= 100 ? { chunk_id: value.chunk_id } : {}) };
}

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
  if (['search_documents','find_resources','research_search'].includes(tool) && Array.isArray(value.evidence)) candidates = value.evidence;
  if (tool === 'find_resources' && Array.isArray(value.previews)) candidates = [...candidates, ...value.previews.flatMap(preview =>
    preview && typeof preview === 'object' && Array.isArray(preview.passages) ? preview.passages.map((row: unknown) => ({ ...preview, ...(row && typeof row === 'object' ? row : {}) })) : [])];
  if (tool === 'read_document' && Array.isArray(value.passages)) candidates = value.passages.map(row => ({ ...value, ...(row && typeof row === 'object' ? row : {}) }));
  if (tool === 'inspect_document_page' && [value.analysis, value.text].some(text => typeof text === 'string' && text.trim())) candidates = [value];
  return candidates.slice(0, 24).flatMap(candidate => {
    const parsed = sourceSchema.safeParse(candidate);
    if (!parsed.success) return [];
    const row = parsed.data;
    return [{ entity_type: 'resource' as const, entity_id: row.resource_id, title: row.title, source_url: row.source_url,
      page_start: row.page_start ?? null, page_end: row.page_end ?? null, matched_via: [documentEvidenceWarning(tool, data) ? 'OCR fallback' : tool === 'inspect_document_page' ? 'page inspected' : 'text read'],
      ...citationExcerpt(tool, candidate) }];
  });
}
