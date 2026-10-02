import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { query, transaction } from '../db.js';
import type pg from 'pg';
import { DocumentError } from './uploadValidation.js';
import { extractPdfPages } from './pdfText.js';

const CHUNK_MAX_CHARS = 2000;
const SUPPORTED_TEXT_EXTS = new Set(['.txt', '.md', '.csv']);

// ─── Prompt injection sanitizer ───────────────────────────────────────────────
// Strip patterns that could hijack an LLM when chunk content is later injected
// into a prompt. This is defense-in-depth — do not rely on this alone.
export function sanitizeChunkContent(text: string): string {
  return text
    // PDF font mappings can emit NULs, which PostgreSQL text rejects (22021).
    // Keep character width and word boundaries; the original bytes stay intact.
    .replace(/\u0000/g, ' ')
    .replace(/<\|.*?\|>/gs, '')                               // <|im_start|> token boundaries
    .replace(/\[\/?(INST|SYS|SYSTEM)\]/gi, '')               // [INST] / [/INST] instruction tags
    .replace(/###\s*(System|User|Assistant)\s*:/gi, '###')   // ### role markers
    .replace(/^(System|User|Assistant)\s*:\s*/gim, '')        // inline role prefixes
    .trim();
}

// ─── Text extraction ──────────────────────────────────────────────────────────

interface PageOffset {
  num: number;        // 1-based page number
  start: number;      // char offset of page start in the joined text
  end: number;        // char offset of page end (exclusive)
}

interface ExtractedText {
  text: string;
  totalPages: number | null;
  // Exact page boundaries in `text` (PDFs only) — lets chunks carry precise
  // page citations instead of proportional approximations.
  pageOffsets: PageOffset[] | null;
}

async function extractText(filePath: string, mimeType: string): Promise<ExtractedText | null> {
  const ext = path.extname(filePath).toLowerCase();

  if (mimeType === 'application/pdf' || ext === '.pdf') {
    const result = await extractPdfPages(new Uint8Array(await fs.readFile(filePath)));
    const pageOffsets: PageOffset[] = [];
    let joined = '';
    for (const page of result.pages) {
      const start = joined.length;
      joined += page.text;
      pageOffsets.push({ num: page.num, start, end: joined.length });
      joined += '\n\n';
    }
    return { text: joined, totalPages: result.total ?? result.pages.length, pageOffsets };
  }

  if (SUPPORTED_TEXT_EXTS.has(ext) || mimeType.startsWith('text/')) {
    const bytes = await fs.readFile(filePath);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new DocumentError('text_encoding', 'Save this text file as UTF-8 and upload it again.'); }
    return { text, totalPages: null, pageOffsets: null };
  }

  return null;
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

interface Chunk {
  content: string;
  charStart: number;
  charEnd: number;
}

export function splitIntoChunks(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_MAX_CHARS, text.length);
    if (end < text.length) {
      const lastBreak = [...text.slice(start, end).matchAll(/\s+/g)].at(-1);
      if (lastBreak && lastBreak.index! > CHUNK_MAX_CHARS / 2) end = start + lastBreak.index!;
      else if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    const content = text.slice(start, end);
    if (content.trim()) chunks.push({ content, charStart: start, charEnd: end });
    if (end === text.length) break;
    // Overlap on word boundaries; long unbroken tokens make forward progress.
    let next = Math.max(start + 1, end - 150);
    while (next < end && next > 0 && !/\s/.test(text[next - 1])) next++;
    start = next;
  }
  return chunks;
}

// Map a chunk's character range to page numbers. Prefers exact page offsets
// (pdf-parse v2 gives per-page text); falls back to proportional estimate.
function pageRangeFor(
  chunk: Chunk,
  totalChars: number,
  totalPages: number | null,
  pageOffsets: PageOffset[] | null,
): { pageStart: number | null; pageEnd: number | null } {
  if (pageOffsets?.length) {
    let pageStart: number | null = null;
    let pageEnd: number | null = null;
    for (const p of pageOffsets) {
      if (p.end > chunk.charStart && p.start < chunk.charEnd) {
        if (pageStart === null) pageStart = p.num;
        pageEnd = p.num;
      }
    }
    return { pageStart, pageEnd };
  }
  if (totalPages) {
    return {
      pageStart: Math.max(1, Math.ceil((chunk.charStart / totalChars) * totalPages)),
      pageEnd: Math.min(totalPages, Math.ceil((chunk.charEnd / totalChars) * totalPages)),
    };
  }
  return { pageStart: null, pageEnd: null };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Replaces the chunk set for a resource with a freshly extracted generation.
 *
 * Guarantees:
 * - Extraction/parse failure leaves the previous good generation untouched.
 * - The swap (delete old rows, insert new rows, enqueue embedding jobs) is a
 *   single transaction — readers never observe a half-replaced chunk set.
 * - Unchanged chunks (same index + content hash) keep their row id and their
 *   existing embedding; no needless re-embedding.
 */
export async function processResourceChunks(
  resourceId: string,
  filePath: string,
  mimeType: string,
  options: { beforeCommit?: (client: pg.PoolClient) => Promise<void>; enqueueEmbeddings?: boolean } = {},
): Promise<{ chunks: number; reused: number } | null> {
  const extracted = await extractText(filePath, mimeType);
  if (!extracted) return null; // parse failed — keep previous generation

  const rawChunks = extracted.pageOffsets
    ? extracted.pageOffsets.flatMap(page => splitIntoChunks(extracted.text.slice(page.start, page.end))
      .map(chunk => ({ ...chunk, charStart: chunk.charStart + page.start, charEnd: chunk.charEnd + page.start })))
    : splitIntoChunks(extracted.text);
  if (!rawChunks.length) return null; // nothing extractable — keep previous generation

  const totalChars = extracted.text.length || 1;
  const now = new Date().toISOString();

  const { rows: existing } = await query(
    'SELECT id, chunk_index, content_hash, page_start, page_end FROM resource_chunks WHERE resource_id=$1 ORDER BY chunk_index ASC',
    [resourceId],
  ) as { rows: { id: string; chunk_index: number; content_hash: string; page_start?: number | null; page_end?: number | null }[] };
  const existingByIndex = new Map(existing.map(r => [r.chunk_index, r]));

  // Build the new generation up-front so the transaction only does writes.
  const newGeneration: Array<{
    id: string; index: number; content: string; hash: string;
    pageStart: number | null; pageEnd: number | null; metadata: string; reused: boolean;
  }> = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const raw = rawChunks[i];
    const content = sanitizeChunkContent(raw.content);
    if (!content) continue;
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const prior = existingByIndex.get(i);
    const { pageStart, pageEnd } = pageRangeFor(raw, totalChars, extracted.totalPages, extracted.pageOffsets);
    const reused = prior?.content_hash === hash && (prior.page_start ?? null) === pageStart && (prior.page_end ?? null) === pageEnd;
    newGeneration.push({
      id: reused ? prior!.id : crypto.randomUUID(),
      index: i,
      content,
      hash,
      pageStart,
      pageEnd,
      metadata: JSON.stringify({
        char_start: raw.charStart,
        char_end: raw.charEnd,
        ...(extracted.totalPages ? {
          page_start: pageStart, page_end: pageEnd, total_pages: extracted.totalPages,
          page_mapping: extracted.pageOffsets ? 'exact' : 'approximate',
        } : {}),
      }),
      reused,
    });
  }
  if (!newGeneration.length) return null;

  const keptIds = new Set(newGeneration.map(c => c.id));
  const staleRows = existing.filter(r => !keptIds.has(r.id));

  await transaction(async (client) => {
    await options.beforeCommit?.(client);
    // A reindex must also upgrade unchanged chunks from the former 600-character
    // embedding input. Keep vectors usable until this resource is explicitly
    // reprocessed; all changes here are guarded by the job lease transaction.
    await client.query(`UPDATE embeddings e SET is_stale=true FROM resource_chunks c
      WHERE e.entity_type='resource_chunk' AND e.entity_id=c.id AND c.resource_id=$1
        AND (e.embedding_text IS NULL OR e.embedding_text NOT LIKE 'Entity: Resource Chunk\nTitle:%')`, [resourceId]);
    for (const chunk of newGeneration) {
      await client.query(
        `INSERT INTO resource_chunks
           (id, resource_id, chunk_index, content, content_hash, page_start, page_end, chunk_metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE
           SET content=$4, content_hash=$5, page_start=$6, page_end=$7, chunk_metadata=$8`,
        [chunk.id, resourceId, chunk.index, chunk.content, chunk.hash, chunk.pageStart, chunk.pageEnd, chunk.metadata, now],
      );
      if (!chunk.reused) {
        await client.query("UPDATE embeddings SET is_stale=true WHERE entity_type='resource_chunk' AND entity_id=$1", [chunk.id]);
        if (options.enqueueEmbeddings !== false) await client.query(
          `INSERT INTO embedding_jobs (id, entity_type, entity_id, chunk_id, action, priority, status, attempts, created_at)
           VALUES ($1, 'resource_chunk', $2, $3, 'upsert', 3, 'pending', 0, $4)
           ON CONFLICT DO NOTHING`,
          [crypto.randomUUID(), resourceId, chunk.id, now],
        );
      }
    }
    for (const stale of staleRows) {
      await client.query('DELETE FROM resource_chunks WHERE id=$1', [stale.id]);
      await client.query("DELETE FROM embeddings WHERE entity_type='resource_chunk' AND entity_id=$1", [stale.id]);
      if (options.enqueueEmbeddings !== false) await client.query(
        `INSERT INTO embedding_jobs (id, entity_type, entity_id, chunk_id, action, priority, status, attempts, created_at)
         VALUES ($1, 'resource_chunk', $2, $3, 'delete', 3, 'pending', 0, $4)
         ON CONFLICT DO NOTHING`,
        [crypto.randomUUID(), resourceId, stale.id, now],
      );
    }
  });

  return {
    chunks: newGeneration.length,
    reused: newGeneration.filter(c => c.reused).length,
  };
}
