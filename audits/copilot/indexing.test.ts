import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pageWindows } from './candidateIndex';

const mock = vi.hoisted(() => ({ query: vi.fn(), tx: vi.fn(), insert: vi.fn(), pdf: vi.fn() }));
vi.mock('../../server/db.js', () => ({ query: mock.query, transaction: mock.tx }));
vi.mock('../../server/services/pdfText.js', () => ({ extractPdfPages: mock.pdf }));
import { processResourceChunks } from '../../server/services/chunkPipeline';
let directory: string;
let fixture: string;
const chunks = () => mock.insert.mock.calls.filter(([sql]) => sql.includes('INSERT INTO resource_chunks'))
  .map(([, p]) => ({ id: p[0], content: p[3], pageStart: p[5], pageEnd: p[6], metadata: JSON.parse(p[7]) }));
beforeEach(async () => {
  vi.resetAllMocks();
  mock.query.mockResolvedValue({ rows: [] });
  mock.insert.mockResolvedValue({ rows: [] });
  mock.tx.mockImplementation(fn => fn({ query: mock.insert }));
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'marina-audit-'));
  fixture = path.join(directory, 'synthetic.txt');
  await fs.writeFile(fixture, 'synthetic');
});
afterEach(async () => { await fs.unlink(fixture); await fs.rmdir(directory); });

describe('Repaired indexing regressions', () => {
  it.each(['isomorphism', 'NEBULA-731', 'mitochondria'])('IDX-01 preserves complete rare term %s at a boundary', async term => {
    await fs.writeFile(fixture, 'a'.repeat(1997) + ' ' + term + ' is the rare concept.');
    await processResourceChunks('r', fixture, 'text/plain');
    expect(chunks().some(c => c.content.includes(term))).toBe(true);
  });
  it('IDX-02 cites only page 1 for its short final fragment', async () => {
    mock.pdf.mockResolvedValue({ total: 2, pages: [{ num: 1, text: 'A'.repeat(2100) }, { num: 2, text: 'B'.repeat(100) }] });
    await processResourceChunks('r', fixture, 'application/pdf');
    expect(chunks().find(c => c.content === 'A'.repeat(100))).toMatchObject({ pageStart: 1, pageEnd: 1 });
  });
  it.each([3, 5, 10])('IDX-03 maintains page provenance after %i blank lines', async lines => {
    mock.pdf.mockResolvedValue({ total: 2, pages: [{ num: 1, text: 'A'.repeat(1999) + '\n'.repeat(lines) }, { num: 2, text: 'B'.repeat(100) }] });
    await processResourceChunks('r', fixture, 'application/pdf');
    expect(chunks().find(c => c.content === 'B'.repeat(100))).toMatchObject({ pageStart: 2, pageEnd: 2 });
  });
  it('IDX-04 gives changed content a new immutable citation identity', async () => {
    mock.query.mockResolvedValue({ rows: [{ id: 'old-citation-id', chunk_index: 0, content_hash: 'old-hash' }] });
    await fs.writeFile(fixture, 'Changed content: the old citation no longer supports this statement.');
    await processResourceChunks('r', fixture, 'text/plain');
    expect(chunks()[0].id).not.toBe('old-citation-id');
  });
});

describe('Current extraction boundaries and preservation', () => {
  it('does not replace a previous generation when PDF parsing fails', async () => {
    mock.pdf.mockRejectedValue(new Error('synthetic parse failure'));
    await expect(processResourceChunks('r', fixture, 'application/pdf')).rejects.toThrow('synthetic');
    expect(mock.tx).not.toHaveBeenCalled();
  });
  it('does not replace a previous generation for an empty scanned text layer', async () => {
    mock.pdf.mockResolvedValue({ total: 1, pages: [{ num: 1, text: '' }] });
    expect(await processResourceChunks('r', fixture, 'application/pdf')).toBeNull();
    expect(mock.tx).not.toHaveBeenCalled();
  });
  it('rejects malformed UTF-8 rather than indexing replacement characters', async () => {
    await fs.writeFile(fixture, Buffer.from([0xc3, 0x28]));
    await expect(processResourceChunks('r', fixture, 'text/plain')).rejects.toThrow('UTF-8');
    expect(mock.tx).not.toHaveBeenCalled();
  });
});

describe('Experimental page windows: exact source spans and boundary preservation', () => {
  it.each(Array.from({ length: 24 }, (_, i) => 1978 + i))('preserves a needle starting at character %i', offset => {
    const text = 'a'.repeat(offset) + ' isomorphism is the rare concept.';
    const rows = pageWindows('r:v1', [{ number: 73, text }]);
    expect(rows.some(row => row.content.includes('isomorphism'))).toBe(true);
    for (const row of rows) {
      expect(row.content).toBe(text.slice(row.start, row.end));
      expect(row.page).toBe(73);
      expect(row.content.length).toBeLessThanOrEqual(2000);
    }
  });
  it.each([1, 1999, 2000, 2001, 4001, 100_000])('covers every character of an unbroken %i character input', length => {
    const text = 'X'.repeat(length);
    const rows = pageWindows('v1', [{ number: 1, text }]);
    const covered = new Uint8Array(length);
    rows.forEach(row => covered.fill(1, row.start, row.end));
    expect(covered.every(value => value === 1)).toBe(true);
    expect(rows.at(-1)?.end).toBe(length);
  });
  it('never attributes a fragment to another page, even after blank lines', () => {
    const pages = [{ number: 1, text: 'A'.repeat(2100) + '\n\n\n' }, { number: 2, text: 'B'.repeat(100) }];
    const rows = pageWindows('v1', pages);
    expect(rows.filter(r => r.content.includes('B')).every(r => r.page === 2)).toBe(true);
    expect(rows.filter(r => r.content.includes('A')).every(r => r.page === 1)).toBe(true);
  });
  it('pins citations to a version and is repeatable within that version', () => {
    const pages = [{ number: 1, text: 'The answer is 42.' }];
    expect(pageWindows('v1', pages)).toEqual(pageWindows('v1', pages));
    expect(pageWindows('v1', pages)[0].id).not.toBe(pageWindows('v2', pages)[0].id);
  });
  it('does not split a UTF-16 surrogate pair at a hard boundary', () => {
    const text = 'a'.repeat(1999) + '🔬'.repeat(10);
    for (const row of pageWindows('v1', [{ number: 1, text }])) {
      expect(Buffer.from(row.content, 'utf8').toString('utf8')).toBe(row.content);
    }
  });
});
