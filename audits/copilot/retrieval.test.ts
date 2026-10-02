import { beforeEach, describe, expect, it, vi } from 'vitest';
import { balancedEvidence } from './candidateIndex';
const mock = vi.hoisted(() => ({ query: vi.fn(), embed: vi.fn() }));
vi.mock('../../server/db.js', () => ({ query: mock.query }));
vi.mock('../../server/embeddingProvider.js', () => ({ embedQuery: mock.embed, EMBED_MODEL: 'audit', EMBED_DIMENSION: 3 }));
import { searchDocuments } from '../../server/services/documentRag';
import { searchResearchEvidence } from '../../server/services/researchRag';
import { createCopilotTools } from '../../server/services/copilotTools';
import { ContextObservations } from '../../server/services/copilotContextWire';

const passage = (id = 'A', index = 0) => ({ resource_id: id, title: id, chunk_id: `${id}-${index}`, content: 'Synthetic source evidence', page_start: 7, page_end: 8, file_id: 'drive-id', checked_at: '2026-10-01T00:00:00Z', last_error: null });
beforeEach(() => { vi.resetAllMocks(); mock.query.mockResolvedValue({ rows: [] }); mock.embed.mockResolvedValue([1, 0, 0]); });
const noop = async () => ({});
const tools = createCopilotTools({ workspace: noop, previewSchedule: noop, previewRoutine: noop, scheduleDay: noop, overdueTasks: noop });

describe('Retrieval contracts: deterministic candidates, not real embedding accuracy', () => {
  it('does not search or embed a whitespace-only query', async () => {
    expect((await searchDocuments(' \n ')).evidence).toEqual([]);
    expect(mock.query).not.toHaveBeenCalled(); expect(mock.embed).not.toHaveBeenCalled();
  });
  it('deduplicates one chunk present in both lanes', async () => {
    mock.query.mockResolvedValue({ rows: [passage()] });
    expect((await searchDocuments('evidence')).evidence).toHaveLength(1);
  });
  it('retains lexical evidence and reports an embedding outage', async () => {
    mock.embed.mockRejectedValue(new Error('synthetic provider outage'));
    mock.query.mockResolvedValue({ rows: [passage()] });
    expect(await searchDocuments('evidence')).toMatchObject({ vector_degraded: true, evidence: [{ resource_id: 'A' }] });
  });
  it('fails visibly on a lexical database outage', async () => {
    mock.query.mockRejectedValue(new Error('synthetic database outage'));
    await expect(searchDocuments('evidence')).rejects.toThrow('database outage');
  });
  it('returns the Drive source and page range separately from preview transport', async () => {
    mock.query.mockResolvedValue({ rows: [passage()] });
    expect((await searchDocuments('evidence')).evidence[0]).toMatchObject({ source_url: 'https://drive.google.com/file/d/drive-id/view', page_start: 7, page_end: 8 });
  });
  it('marks a failed source check instead of claiming the old timestamp is current', async () => {
    mock.query.mockResolvedValue({ rows: [{ ...passage(), last_error: 'permission revoked' }] });
    expect((await searchDocuments('evidence')).evidence[0]).toMatchObject({ last_source_check: null, source_check_error: 'permission revoked' });
  });
  it('reports missing selected resources', async () => {
    mock.query.mockImplementation(async sql => ({ rows: sql.includes('COALESCE(j.status') ? [{ id: 'A', status: 'ready' }] : [] }));
    expect(await searchDocuments('evidence', ['A', 'missing'])).toMatchObject({ missing_resource_ids: ['missing'] });
  });
  it.each([1, 8, 12])('bounds a result to %i passages', async limit => {
    mock.query.mockResolvedValue({ rows: Array.from({ length: 36 }, (_, i) => passage('A', i)) });
    expect((await searchDocuments('evidence', [], limit)).evidence).toHaveLength(limit);
  });
});

describe('Known retrieval gaps: desired assertions currently fail', () => {
  it('RAG-01 represents both requested files in a two-file comparison', async () => {
    const rows = Array.from({ length: 24 }, (_, i) => passage(i < 12 ? 'A' : 'B', i));
    mock.query.mockImplementation(async sql => ({ rows: sql.includes('COALESCE(j.status') ? [{ id: 'A', status: 'ready' }, { id: 'B', status: 'ready' }] : rows }));
    const result = await searchDocuments('compare A and B', ['A', 'B'], 12);
    expect(new Set(result.evidence.map(row => row.resource_id))).toEqual(new Set(['A', 'B']));
  });
  it.fails('RAG-02 rejects a deliberately unrelated vector candidate', async () => {
    mock.query.mockImplementation(async sql => ({ rows: sql.includes('JOIN embeddings') ? [{ ...passage(), title: 'Baking', content: 'A sourdough loaf.' }] : [] }));
    expect((await searchDocuments('quasar radio emission')).evidence).toEqual([]);
  });
  it.fails('RAG-03 can find research evidence beyond the first 1000 candidate rows', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ paper_id: 'paper', resource_id: 'book', title: 'Book', chunk_id: `c${i}`, heading: null, content: i === 1000 ? 'isomorphism rare exception' : 'ordinary material', page_start: i + 1, page_end: i + 1 }));
    mock.query.mockImplementation(async sql => ({ rows: sql.includes('LIMIT 1000') ? rows.slice(0, 1000) : rows }));
    expect((await searchResearchEvidence('isomorphism')).length).toBeGreaterThan(0);
  });
});

describe('Context and selection policy limits', () => {
  it.each([
    [{ query: 'x', resource_ids: Array.from({ length: 20 }, (_, i) => `r${i}`) }, true],
    [{ query: 'x', resource_ids: Array.from({ length: 21 }, (_, i) => `r${i}`) }, false],
    [{ query: 'x'.repeat(2000) }, true], [{ query: 'x'.repeat(2001) }, false],
    [{ query: 'x', limit: 12 }, true], [{ query: 'x', limit: 13 }, false],
    [{ query: 'x', page: 300 }, false], [{ query: 'x', goal_id: 'goal' }, false],
  ])('validates source search arguments %#', (args, valid) => {
    expect(tools.search_documents.parameters.safeParse(args).success).toBe(valid);
  });
  it('supports two large observations but refuses a third without silently pruning it', () => {
    const context = new ContextObservations();
    const payload = (round: number) => ({ evidence: Array.from({ length: 12 }, (_, i) => ({ resource_id: `r${round}`, chunk_id: `${round}-${i}`, passage: String.fromCharCode(65 + round).repeat(2000) + i })) });
    context.encode('one', payload(0)); context.encode('two', payload(1));
    expect(() => context.encode('three', payload(2))).toThrow('Context budget reached');
    const size = context.sentChars;
    expect(() => context.encode('retry', { evidence: 'x'.repeat(60_000) })).toThrow();
    expect(context.sentChars).toBe(size);
    expect(() => context.encode('small', { remaining: 'source C still unread' })).not.toThrow();
  });
  it('deduplicates identical source results to conserve the observation budget', () => {
    const context = new ContextObservations(); const data = { source: 'a'.repeat(4000) };
    context.encode('first', data);
    expect(context.encode('again', data)).toMatchObject({ source: { same_as: { call_id: 'first', field: 'source' } } });
    expect(context.sentChars).toBeLessThan(4500);
  });
});

describe('Experimental source coverage allocator', () => {
  it.each([2, 3, 5, 12])('represents all %i requested sources when each has qualified evidence', count => {
    const requested = Array.from({ length: count }, (_, i) => `R${i}`);
    const ranked = requested.flatMap(id => Array.from({ length: 12 }, (_, i) => passage(id, i)));
    const selected = balancedEvidence(ranked, requested, 12);
    expect(new Set(selected.map(r => r.resource_id))).toEqual(new Set(requested));
    expect(selected.length).toBeLessThanOrEqual(12);
    expect(new Set(selected.map(r => r.chunk_id)).size).toBe(selected.length);
  });
  it('does not fabricate evidence for a source with no qualified candidates', () => {
    expect(balancedEvidence([passage('A')], ['A', 'missing'], 12)).toEqual([passage('A')]);
  });
});
