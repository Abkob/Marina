import { describe, expect, it } from 'vitest';
import { chunkDocumentElements } from '../../../server/services/documentElements';
describe('structured evidence chunks', () => {
  it('keeps page, evidence kind and model provenance separate', () => {
    const rows = chunkDocumentElements([{ page: 2, kind: 'text', content: '# Chapter\n\nNative paragraph.' },
      { page: 2, kind: 'visual', content: 'A chart shows an increasing line.', model: 'vision' },
      { page: 3, kind: 'ocr', content: 'Scanned page text.', model: 'ocr' }]);
    expect(rows.map(r => [r.page,r.kind,r.model])).toEqual([[2,'text',undefined],[2,'visual','vision'],[3,'ocr','ocr']]);
    expect(rows[0].heading).toBe('Chapter');
  });
  it('flushes at section boundaries and never duplicates paragraphs', () => {
    const input = '# A\n\nOne paragraph.\n\n# B\n\nAnother paragraph.';
    const chunks = chunkDocumentElements([{ page: 1, kind: 'structure', content: input }]);
    expect(chunks.map(c => c.heading)).toEqual(['A','B']);
    expect(chunks.map(c => c.content).join(' ')).toContain('One paragraph.');
    expect(chunks[0].content).not.toContain('Another');
  });
  it.each(['word '.repeat(2000), '字'.repeat(5000), '😀'.repeat(3000), 'x'.repeat(10000)])('bounds very long paragraphs without corrupting Unicode', text => {
    const chunks = chunkDocumentElements([{ page: 1, kind: 'text', content: text }]);
    expect(chunks.every(c => c.content.length <= 2000)).toBe(true);
    expect(chunks.map(c => c.content).join('').replace(/\s/g,'')).toBe(text.replace(/\s/g,''));
    expect(chunks.every(c => new TextDecoder().decode(new TextEncoder().encode(c.content)) === c.content)).toBe(true);
  });
});
