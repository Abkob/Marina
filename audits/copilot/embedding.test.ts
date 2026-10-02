import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ query: vi.fn(), tx: vi.fn(), write: vi.fn(), embed: vi.fn() }));
vi.mock('../../server/db.js', () => ({ query: mock.query, transaction: mock.tx }));
vi.mock('../../server/embeddingProvider.js', () => ({ embedDocument: mock.embed, embedQuery: vi.fn(), EMBED_MODEL: 'audit-model', EMBED_DIMENSION: 3 }));
import { embedEntity } from '../../server/routes/embeddings';
beforeEach(() => {
  vi.resetAllMocks(); mock.embed.mockResolvedValue([1, 0, 0]); mock.write.mockResolvedValue({ rows: [] });
  mock.tx.mockImplementation(fn => fn({ query: mock.write }));
});
function source(content: string) {
  mock.query.mockImplementation(async sql => ({ rows: sql.includes('FROM resource_chunks rc') ? [{ id: 'chunk', resource_id: 'r', chunk_index: 0, resource_title: 'Synthetic textbook', heading: 'Chapter 3', page_start: 42, page_end: 42, content }] : [] }));
}
describe('Actual resource embedding input construction, provider mocked', () => {
  it('includes source metadata and an early detail', async () => {
    source('EARLY-219 ' + 'ordinary words '.repeat(140));
    await embedEntity('resource_chunk', 'chunk');
    const text = mock.embed.mock.calls[0][0];
    expect(text).toContain('Synthetic textbook'); expect(text).toContain('Chapter 3');
    expect(text).toContain('EARLY-219');
  });
  it('EMBED-01 includes a rare detail after character 600 in the semantic index', async () => {
    source('a'.repeat(1200) + ' The exception is NEBULA-731.');
    await embedEntity('resource_chunk', 'chunk');
    expect(mock.embed.mock.calls[0][0]).toContain('NEBULA-731');
  });
  it('refuses a provider vector with the wrong dimension before writing', async () => {
    source('A short reference.'); mock.embed.mockResolvedValue([1, 0]);
    await expect(embedEntity('resource_chunk', 'chunk')).rejects.toThrow('dimension_mismatch');
    expect(mock.write).not.toHaveBeenCalled();
  });
});
