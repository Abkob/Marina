/** Research prototype only. Not imported by the application.
 * Page-local, whitespace-aware windows with exact offsets and bounded overlap.
 * This is not a PDF parser, tokenizer, OCR engine, or semantic quality benchmark.
 */
import { createHash } from 'node:crypto';

export type AuditPage = { number: number; text: string };
export type AuditChunk = { id: string; page: number; start: number; end: number; content: string };
export function pageWindows(version: string, pages: AuditPage[], max = 2000, overlap = 150): AuditChunk[] {
  if (!Number.isInteger(max) || max < 2 || overlap < 0 || overlap >= max) throw new Error('Invalid window');
  const chunks: AuditChunk[] = [];
  for (const page of pages) {
    let start = 0;
    while (start < page.text.length) {
      let end = Math.min(start + max, page.text.length);
      if (end < page.text.length) {
        const window = page.text.slice(start, end);
        const breaks = [...window.matchAll(/\s+/g)];
        const last = breaks.at(-1);
        if (last && last.index! > max / 2) end = start + last.index!;
        // An exceptionally long unbroken token still needs a hard split; do not
        // split a UTF-16 surrogate pair. Full production design needs token budgets.
        else if (/[\uD800-\uDBFF]/.test(page.text[end - 1])) end--;
      }
      const content = page.text.slice(start, end);
      if (content.trim()) chunks.push({
        id: createHash('sha256').update(JSON.stringify([version, page.number, start, end, content])).digest('hex'),
        page: page.number, start, end, content,
      });
      if (end === page.text.length) break;
      let next = Math.max(start + 1, end - overlap);
      while (next < end && next > 0 && !/\s/.test(page.text[next - 1])) next++;
      start = next;
    }
  }
  return chunks;
}

/** A coverage experiment, not a relevance ranker: only feed already-qualified
 * evidence. Missing sources stay missing; do not fill with unrelated passages.
 */
export function balancedEvidence<T extends { resource_id: string }>(ranked: T[], requested: string[], limit: number): T[] {
  const selected: T[] = [];
  for (const id of [...new Set(requested)]) {
    const row = ranked.find(item => item.resource_id === id);
    if (row && selected.length < limit) selected.push(row);
  }
  for (const row of ranked) if (!selected.includes(row) && selected.length < limit) selected.push(row);
  return selected;
}
