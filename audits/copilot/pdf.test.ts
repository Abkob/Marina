import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { extractPdfPages } from '../../server/services/pdfText';

describe('Real production PDF parser, synthetic text plus image document', () => {
  it('extracts the text-layer control and retains physical page numbers', async () => {
    const result = await extractPdfPages(new Uint8Array(await fs.readFile(new URL('./fixtures/mixed-evidence.pdf', import.meta.url))));
    expect(result.pages.map(p => p.num)).toEqual([1, 2]);
    expect(result.pages[0].text).toContain('ORBIT-219');
    expect(result.pages[1].text.trim()).toBe('');
  });
  it.fails('VIS-01 indexes the code that exists only inside a PDF image', async () => {
    const result = await extractPdfPages(new Uint8Array(await fs.readFile(new URL('./fixtures/mixed-evidence.pdf', import.meta.url))));
    expect(result.pages.map(p => p.text).join('\n')).toContain('NEBULA-731');
  });
  it.fails('VIS-02 preserves the chart labels from the embedded image', async () => {
    const result = await extractPdfPages(new Uint8Array(await fs.readFile(new URL('./fixtures/mixed-evidence.pdf', import.meta.url))));
    const text = result.pages.map(p => p.text).join('\n');
    expect(text).toContain('Before: 25'); expect(text).toContain('After: 45');
  });
});
