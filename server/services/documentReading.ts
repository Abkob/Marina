import { query } from '../db.js';
import { activeResourceSql } from '../utils/archiveVisibility.js';
import { openStoredFile } from './fileStorage.js';
import { renderPdfPage } from './pdfText.js';
import { analyzeDocumentImage, transcribeDocumentImage, parseDocumentImage, MAX_VISION_IMAGE_BYTES, nvidiaEvidenceAvailable } from './nvidiaEvidence.js';
import type { EvidenceModels } from './copilotModelRoles.js';
import { resourceScopeSql, type ResourceScope } from './resourceContext.js';
import { searchDocuments } from './documentRag.js';
import { filterRootedDriveRows, DRIVE_FILE_ID_SQL } from './driveResourceAccess.js';
import { chunkEvidence } from './chunkEvidence.js';

type Resource = { id: string; title: string; original_name: string | null; file_path: string | null; mime_type: string | null; file_id: string | null; status: string; error: string | null; checked_at: string | null; last_error: string | null; total_pages?: number; visual_pages_ready?: number; visual_pages_failed?: number };
const resourceFields = `r.id,r.title,r.original_name,r.file_path,r.mime_type,${DRIVE_FILE_ID_SQL} AS file_id,COALESCE(j.status,'not_started') AS status,j.error,d.checked_at,d.last_error,
  (SELECT COUNT(*)::int FROM resource_document_pages p WHERE p.resource_id=r.id AND p.generation=j.version) AS total_pages,
  (SELECT COUNT(*)::int FROM resource_document_pages p WHERE p.resource_id=r.id AND p.generation=j.version AND p.status='ready') AS visual_pages_ready,
  (SELECT COUNT(*)::int FROM resource_document_pages p WHERE p.resource_id=r.id AND p.generation=j.version AND p.status='failed') AS visual_pages_failed`;
const resourceJoins = `FROM resources r LEFT JOIN resource_processing_jobs j ON j.resource_id=r.id
  LEFT JOIN resource_drive_files d ON d.resource_id=r.id AND r.file_path LIKE 'gdrive://%'`;
const visible = `${activeResourceSql('r.id')} AND (d.resource_id IS NULL OR d.available)`;
const source = (row: Resource) => ({ resource_id: row.id, title: row.title,
  source_url: row.file_id ? `https://drive.google.com/file/d/${row.file_id}/view` : `/api/resources/blob/${row.id}`,
  last_source_check: row.last_error ? null : row.checked_at, source_check_error: row.last_error });
const discoveredSource = (row: Resource) => ({ ...source(row), id: row.id, original_name: row.original_name, mime_type: row.mime_type, status: row.status, error: row.error });

export async function findResources(args: { search?: string; query?: string; after?: string; limit?: number } & ResourceScope, rerankModel?: string) {
  const limit = Math.min(30, Math.max(1, Math.trunc(args.limit ?? 20)));
  const values: unknown[] = [];
  const conditions = [visible];
  for (const word of args.search?.trim().split(/\s+/).filter(Boolean) ?? []) {
    values.push(`%${word.replace(/[\\%_]/g, '\\$&')}%`);
    conditions.push(`(r.title ILIKE $${values.length} OR r.original_name ILIKE $${values.length})`);
  }
  if (args.after) { values.push(args.after); conditions.push(`r.id > $${values.length}`); }
  const scope = resourceScopeSql(args, values);
  values.push(limit + 1);
  const { rows } = await query<Resource>(`SELECT ${resourceFields} ${resourceJoins} WHERE ${conditions.join(' AND ')} ${scope} ORDER BY r.id LIMIT $${values.length}`, values);
  const resources = (await filterRootedDriveRows(rows.slice(0, limit))).map(discoveredSource);
  const result = { resources, has_more: rows.length > limit, next_after: rows.length > limit ? rows[limit - 1].id : null };
  const semanticQuery = args.query?.trim() || args.search?.trim();
  if (!semanticQuery || args.after) return result;
  // Content discovery always runs, even when a literal title matched. The model
  // receives candidate passages in this call instead of having to escape an
  // exact-name gate itself. Ranking never establishes document identity.
  try {
    const found = await searchDocuments(semanticQuery, [], 8, rerankModel, { goal_id: args.goal_id, task_id: args.task_id, ...(args.resource_ids ? { resource_ids: args.resource_ids } : {}), ...(args.include_subtasks !== undefined ? { include_subtasks: args.include_subtasks } : {}) }, { diversifyResources: true });
    const candidateIds = [...new Set(found.evidence.map(row => row.resource_id))];
    // A semantic hit alone can confuse neighboring concepts. Supply the opening
    // context of the top candidates automatically, so the model can resolve the
    // book and follow its contents without another title-lookup loop.
    const previews = await Promise.all(candidateIds.slice(0, 2).map(async resource_id => {
      try {
        const read = await readDocument({ resource_id, limit: 8 }, args);
        let chars = 0;
        const passages = read.passages.filter(row => { chars += row.passage.length; return chars <= 6000; });
        const truncated = passages.length < read.passages.length;
        return { ...read, passages, has_more: truncated || ('has_more' in read && read.has_more),
          next_after_chunk: truncated ? passages.at(-1)?.chunk_index ?? -1 : 'next_after_chunk' in read ? read.next_after_chunk : null };
      } catch { return { resource_id, unavailable: true }; }
    }));
    const candidates = new Map<string, ReturnType<typeof discoveredSource> & { matched_via: string[] }>();
    for (const row of found.evidence) candidates.set(row.resource_id, {
      id: row.resource_id, resource_id: row.resource_id, title: row.title, source_url: row.source_url,
      original_name: null, mime_type: null, status: 'ready', error: null,
      last_source_check: row.last_source_check, source_check_error: row.source_check_error, matched_via: ['semantic_or_text_content'],
    });
    for (const row of resources) candidates.set(row.id, { ...row, matched_via: [...(candidates.get(row.id)?.matched_via ?? []), 'title_or_filename'] });
    // `resources: []` previously told the planner that the source was missing,
    // even when evidence identified a candidate. Resource discovery now returns
    // the discovered sources; literal metadata matches are a separate field.
    return { ...result, resources: [...candidates.values()].slice(0, limit), title_matches: resources, evidence: found.evidence, previews, semantic_discovery: {
      query: semanticQuery, vector_degraded: found.vector_degraded, reranking: found.reranking, coverage: found.coverage,
      candidate_resource_ids: candidateIds,
    }, hint: 'resources are discovered candidates, with matched_via identifying title or content discovery. title_matches lists literal matches separately; an empty title_matches does not mean the source is missing. previews are opening passages from the top two content candidates, often including contents. Follow relevant sections with read_document. Investigate without asking permission; answer under the actual saved title and disclose any title mismatch. Similarity is not proof of identity or topic absence. Retrieval is bounded and searches ready indexed text only. has_more/next_after page the literal metadata listing.' };
  } catch {
    return { ...result, evidence: [], semantic_discovery: { unavailable: true },
      hint: 'Content discovery is temporarily unavailable. These are metadata results only, not evidence of topic absence. You may read known documents with read_document or inspect_document_page; disclose the unavailable search.' };
  }
}

async function getResource(id: string, scope: ResourceScope = {}) {
  const values: unknown[] = [id];
  const filter = resourceScopeSql(scope, values);
  const { rows } = await query<Resource>(`SELECT ${resourceFields} ${resourceJoins} WHERE r.id=$1 AND ${visible} AND r.file_validation='valid' ${filter}`, values);
  if (!rows[0] || !(await filterRootedDriveRows(rows)).length) throw new Error('This resource is outside the selected context, missing, archived, unavailable, or has not passed file validation.');
  return rows[0];
}

export async function readDocument(args: { resource_id: string; page?: number; after_chunk?: number; limit?: number }, scope: ResourceScope = {}) {
  const resource = await getResource(args.resource_id, scope);
  if (resource.status !== 'ready') return { ...source(resource), status: resource.status, error: resource.error,
    passages: [], hint: 'Text indexing is not ready. For a PDF or image, inspect_document_page can read a selected original page visually.' };
  const limit = Math.min(8, Math.max(1, Math.trunc(args.limit ?? 4)));
  const values: unknown[] = [resource.id, args.after_chunk ?? -1];
  const pageFilter = args.page === undefined ? '' : 'AND page_start <= $3 AND page_end >= $3';
  if (args.page !== undefined) values.push(args.page);
  values.push(limit + 1);
  const { rows } = await query<{ id: string; chunk_index: number; content: string; page_start: number | null; page_end: number | null; chunk_metadata?: string }>(
    `SELECT id,chunk_index,content,page_start,page_end,chunk_metadata FROM resource_chunks WHERE resource_id=$1 AND chunk_index>$2 ${pageFilter} ORDER BY chunk_index,id LIMIT $${values.length}`, values);
  const passages = rows.slice(0, limit).map(row => ({ chunk_id: row.id, chunk_index: row.chunk_index, passage: row.content, page_start: row.page_start, page_end: row.page_end, ...chunkEvidence(row.chunk_metadata) }));
  return { ...source(resource), status: resource.status, passages, has_more: rows.length > limit,
    next_after_chunk: rows.length > limit ? passages.at(-1)!.chunk_index : null, requested_page: args.page ?? null,
    coverage: resource.total_pages ? { total_pages: resource.total_pages, visual_pages_ready: resource.visual_pages_ready, visual_pages_failed: resource.visual_pages_failed,
      note: 'Text, OCR, page structure and visual interpretations are labeled separately. Model-derived evidence may be wrong. Failed/unprocessed visual pages are not fully searchable; inspect_document_page can inspect one original.' }
      : 'Legacy text index only; images and chart content require inspect_document_page or reindexing.' };
}

async function readOriginal(reference: string, limit: number) {
  const opened = await openStoredFile(reference);
  if (!opened) throw new Error('The original file is no longer available.');
  if (!Number.isFinite(opened.size) || opened.size > limit) {
    opened.stream.destroy(); throw new Error(`The original exceeds the ${Math.floor(limit / 1024 / 1024)} MB visual inspection limit.`);
  }
  const chunks: Buffer[] = []; let bytes = 0;
  const timeout = setTimeout(() => opened.stream.destroy(new Error('Reading the original timed out.')), 20_000);
  timeout.unref();
  try {
    for await (const part of opened.stream) {
      const chunk = Buffer.from(part); bytes += chunk.byteLength;
      if (bytes > limit) throw new Error('The original exceeds the visual inspection size limit.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timeout); opened.stream.destroy(); }
}

export async function inspectRenderedDocumentImage(args: { dataUrl: string; question: string; mode?: 'ocr' | 'vision' | 'structure' }, models?: EvidenceModels) {
  const mode = args.mode ?? 'vision';
  const model = models?.[mode];
  if (model === 'off') throw new Error(`${mode} is disabled in your model choices.`);
  let result;
  if (mode === 'ocr') result = await transcribeDocumentImage(args.dataUrl, model);
  else if (mode === 'structure') result = await parseDocumentImage(args.dataUrl, model);
  else {
    try { result = await analyzeDocumentImage(args.question, args.dataUrl, model); }
    catch (error) {
      if (models?.ocr === 'off') throw error;
      try {
        const ocr = await transcribeDocumentImage(args.dataUrl, models?.ocr);
        if (!ocr.text.trim()) throw error;
        result = { ...ocr, fallback_from: 'vision', vision_unavailable: true,
          warning: 'Visual interpretation was unavailable. Only OCR text and boxes are provided. Disclose this fallback; do not claim that chart shapes, colors or relationships were visually verified.' };
      } catch { throw error; }
    }
  }
  return result;
}

export async function inspectDocumentPage(args: { resource_id: string; page: number; question: string; mode?: 'ocr' | 'vision' | 'structure' }, models?: EvidenceModels, scope: ResourceScope = {}) {
  const mode = args.mode ?? 'vision';
  if (models?.[mode] === 'off') throw new Error(`${mode} is disabled in your model choices.`);
  if (!nvidiaEvidenceAvailable()) throw new Error('NVIDIA visual document analysis is not configured.');
  const resource = await getResource(args.resource_id, scope);
  if (!resource.file_path) throw new Error('This resource has no saved original file.');
  const pdf = resource.mime_type === 'application/pdf';
  if (!pdf && !['image/png', 'image/jpeg', 'image/webp'].includes(resource.mime_type ?? '')) throw new Error('Visual inspection supports PDF, PNG, JPEG and WebP originals.');
  if (!Number.isInteger(args.page) || args.page < 1 || (!pdf && args.page !== 1)) throw new Error('Choose a valid physical page number; images use page 1.');
  const bytes = await readOriginal(resource.file_path, pdf ? 25 * 1024 * 1024 : MAX_VISION_IMAGE_BYTES);
  const rendered = pdf ? await renderPdfPage(new Uint8Array(bytes), args.page)
    : { dataUrl: `data:${resource.mime_type};base64,${bytes.toString('base64')}`, total: 1 };
  const result = await inspectRenderedDocumentImage({ ...args, dataUrl: rendered.dataUrl }, models);
  return { ...source(resource), ...result, page_start: args.page, page_end: args.page, total_pages: rendered.total,
    coverage: 'Only this original page was inspected. Interpretation may be wrong; verify exact numbers against the source.',
    inspected_at: new Date().toISOString() };
}
