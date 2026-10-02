export type EvidenceKind = 'text' | 'ocr' | 'structure' | 'visual';
export type DocumentElement = { page: number; kind: EvidenceKind; content: string; model?: string; heading?: string };
export type ElementChunk = { content: string; charStart: number; charEnd: number; page: number; kind: EvidenceKind; heading: string | null; model?: string };

/** Section and paragraph boundaries precede size splitting; pages and evidence kinds never mix. */
export function chunkDocumentElements(elements: DocumentElement[], maxChars = 2000): ElementChunk[] {
  if (!Number.isInteger(maxChars) || maxChars < 100) throw new Error('Invalid chunk size');
  const output: ElementChunk[] = [];
  for (const element of elements) {
    if (!Number.isInteger(element.page) || element.page < 1) throw new Error('Invalid physical page');
    let heading = element.heading ?? null;
    let buffer = ''; let offset = 0; let start = 0;
    const flush = () => {
      if (buffer.trim()) output.push({ content: buffer.trim(), charStart: start, charEnd: offset, page: element.page, kind: element.kind, heading, model: element.model });
      buffer = ''; start = offset;
    };
    for (const paragraph of element.content.split(/(?<=\n)\n+|(?=^#{1,6}\s)/m)) {
      const nextHeading = /^#{1,6}\s+(.+)(?:\n|$)/.exec(paragraph)?.[1];
      if (nextHeading) { flush(); heading = nextHeading.trim().slice(0,300); }
      if (buffer.length + paragraph.length > maxChars) flush();
      let remaining = paragraph;
      while (remaining.length > maxChars) {
        let end = remaining.lastIndexOf(' ', maxChars);
        if (end < maxChars / 2) end = maxChars;
        // Do not split a UTF-16 surrogate pair.
        if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
        buffer = remaining.slice(0,end); offset += end; flush(); remaining = remaining.slice(end);
      }
      if (!buffer) start = offset;
      buffer += remaining; offset += remaining.length;
    }
    flush();
  }
  return output;
}
