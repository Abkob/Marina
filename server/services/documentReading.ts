import { query } from '../db.js';
import { activeResourceSql } from '../utils/archiveVisibility.js';
import { openStoredFile } from './fileStorage.js';
import { renderPdfPage } from './pdfText.js';
import { analyzeDocumentImage, transcribeDocumentImage, parseDocumentImage, MAX_VISION_IMAGE_BYTES, nvidiaEvidenceAvailable } from './nvidiaEvidence.js';
import type { EvidenceModels } from './copilotModelRoles.js';
import { resourceScopeSql, type ResourceScope } from './resourceContext.js';

type Resource = { id: string; title: string; file_path: string | null; mime_type: string | null; file_id: string | null; status: string; error: string | null; checked_at: string | null; last_error: string | null };
const resourceFields = `r.id,r.title,r.file_path,r.mime_type,d.file_id,COALESCE(j.status,'not_started') AS status,j.error,d.checked_at,d.last_error`;
const resourceJoins = `FROM resources r LEFT JOIN resource_processing_jobs j ON j.resource_id=r.id
  LEFT JOIN resource_drive_files d ON d.resource_id=r.id AND r.file_path LIKE 'gdrive://%'`;
const visible = `${activeResourceSql('r.id')} AND (d.resource_id IS NULL OR d.available)`;
const source = (row: Resource) => ({ resource_id: row.id, title: row.title,
  source_url: row.file_id ? `https://drive.google.com/file/d/${row.file_id}/view` : `/api/resources/blob/${row.id}`,
  last_source_check: row.last_error ? null : row.checked_at, source_check_error: row.last_error });

export async function findResources(args: { search?: string; after?: string; limit?: number } & ResourceScope) {
  const limit = Math.min(30, Math.max(1, Math.trunc(args.limit ?? 20)));
  const values: unknown[] = [];
  const conditions = [visible];
  for (const word of args.search?.trim().split(/\s+/).filter(Boolean) ?? []) {
    values.push(`%${word.replace(/[\\%_]/g, '\\$&')}%`);
    conditions.push(`r.title ILIKE $${values.length}`);
  }
  if (args.after) { values.push(args.after); conditions.push(`r.id > $${values.length}`); }
  const scope = resourceScopeSql(args, values);
  values.push(limit + 1);
  const { rows } = await query<Resource>(`SELECT ${resourceFields} ${resourceJoins} WHERE ${conditions.join(' AND ')} ${scope} ORDER BY r.id LIMIT $${values.length}`, values);
  const resources = rows.slice(0, limit).map(row => ({ ...source(row), id: row.id, mime_type: row.mime_type, status: row.status, error: row.error }));
  return { resources, has_more: rows.length > limit, next_after: rows.length > limit ? resources.at(-1)!.id : null };
}

async function getResource(id: string) {
  const { rows } = await query<Resource>(`SELECT ${resourceFields} ${resourceJoins} WHERE r.id=$1 AND ${visible} AND r.file_validation='valid'`, [id]);
  if (!rows[0]) throw new Error('This resource is missing, archived, unavailable, or has not passed file validation.');
  return rows[0];
}

export async function readDocument(args: { resource_id: string; page?: number; after_chunk?: number; limit?: number }) {
  const resource = await getResource(args.resource_id);
  if (resource.status !== 'ready') return { ...source(resource), status: resource.status, error: resource.error,
    passages: [], hint: 'Text indexing is not ready. For a PDF or image, inspect_document_page can read a selected original page visually.' };
  const limit = Math.min(8, Math.max(1, Math.trunc(args.limit ?? 4)));
  const values: unknown[] = [resource.id, args.after_chunk ?? -1];
  const pageFilter = args.page === undefined ? '' : 'AND page_start <= $3 AND page_end >= $3';
  if (args.page !== undefined) values.push(args.page);
  values.push(limit + 1);
  const { rows } = await query<{ id: string; chunk_index: number; content: string; page_start: number | null; page_end: number | null }>(
    `SELECT id,chunk_index,content,page_start,page_end FROM resource_chunks WHERE resource_id=$1 AND chunk_index>$2 ${pageFilter} ORDER BY chunk_index,id LIMIT $${values.length}`, values);
  const passages = rows.slice(0, limit).map(row => ({ chunk_id: row.id, chunk_index: row.chunk_index, passage: row.content, page_start: row.page_start, page_end: row.page_end }));
  return { ...source(resource), status: resource.status, passages, has_more: rows.length > limit,
    next_after_chunk: rows.length > limit ? passages.at(-1)!.chunk_index : null, requested_page: args.page ?? null,
    coverage: 'Indexed text only; images and chart content require inspect_document_page.' };
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

export async function inspectDocumentPage(args: { resource_id: string; page: number; question: string; mode?: 'ocr' | 'vision' | 'structure' }, models?: EvidenceModels) {
  const mode = args.mode ?? 'vision';
  if (models?.[mode] === 'off') throw new Error(`${mode} is disabled in your model choices.`);
  if (!nvidiaEvidenceAvailable()) throw new Error('NVIDIA visual document analysis is not configured.');
  const resource = await getResource(args.resource_id);
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
