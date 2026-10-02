import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SKIP_INTEGRATION, startTestServer, stopTestServer } from './setup.js';
import { query, transaction } from '../db.js';
const models = vi.hoisted(() => ({ ocr:vi.fn(), structure:vi.fn(), visual:vi.fn() }));
vi.mock('../services/nvidiaEvidence.js', async original => ({ ...await original<typeof import('../services/nvidiaEvidence.js')>(),
  transcribeDocumentImage:models.ocr, parseDocumentImage:models.structure, analyzeDocumentImage:models.visual }));
import { processStructuredDocument } from '../services/structuredIngestion.js';

const fixture = fileURLToPath(new URL('../../audits/copilot/fixtures/mixed-evidence.pdf', import.meta.url));
let id: string;
describe.skipIf(SKIP_INTEGRATION)('page checkpoints, generation reuse and atomic evidence publication (real PostgreSQL/PDF; synthetic model outputs)', () => {
  beforeAll(startTestServer); afterAll(stopTestServer);
  beforeEach(async () => {
    vi.resetAllMocks();
    models.ocr.mockResolvedValue({text:'NEBULA-731 Before: 25 After: 45',model:'test-ocr',regions:[]});
    models.structure.mockResolvedValue({text:'# Synthetic section\n\n| Before | After |\n| 25 | 45 |',model:'test-layout'});
    models.visual.mockResolvedValue({analysis:'A synthetic chart rises from 25 to 45.',model:'test-vision'});
    id = crypto.randomUUID();
    await query('INSERT INTO resources(id,title,created_at) VALUES($1,$2,$3)',[id,'Synthetic mixed PDF',new Date().toISOString()]);
    await query("INSERT INTO resource_chunks(id,resource_id,chunk_index,content,created_at) VALUES($1,$2,0,'previous complete generation',$3)",[crypto.randomUUID(),id,new Date().toISOString()]);
  });
  afterEach(async () => { await query('DELETE FROM resources WHERE id=$1',[id]); });
  const run = (generation=1, assertLease: Parameters<typeof processStructuredDocument>[0]['assertLease'] = async () => {}) => processStructuredDocument({resourceId:id,generation,filePath:fixture,mimeType:'application/pdf',assertLease});
  it('publishes only after every page has settled, preserving physical pages and evidence kinds', async () => {
    expect(await run()).toMatchObject({pending:true});
    expect((await query('SELECT content FROM resource_chunks WHERE resource_id=$1',[id])).rows[0].content).toBe('previous complete generation');
    expect(await run()).toMatchObject({pending:true});
    expect(await run()).toMatchObject({pending:false});
    const chunks = (await query('SELECT content,page_start,page_end,chunk_metadata FROM resource_chunks WHERE resource_id=$1 ORDER BY chunk_index',[id])).rows;
    expect(chunks.some(c=>String(c.content).includes('ORBIT-219'))).toBe(true);
    expect(chunks.some(c=>c.page_start===2 && String(c.content).includes('NEBULA-731'))).toBe(true);
    expect(new Set(chunks.map(c=>JSON.parse(String(c.chunk_metadata)).evidence_kind))).toEqual(new Set(['text','ocr','structure','visual']));
    expect(chunks.every(c=>c.page_start===c.page_end)).toBe(true);
  });
  it('reuses unchanged pages on a new generation without repeating provider calls', async () => {
    await run(); await run(); await run();
    const calls = models.visual.mock.calls.length;
    expect(await run(2)).toMatchObject({pending:false});
    expect(models.visual).toHaveBeenCalledTimes(calls);
    expect((await query('SELECT COUNT(*)::int AS count FROM resource_document_pages WHERE resource_id=$1 AND generation=2',[id])).rows[0].count).toBe(2);
  });
  it('keeps native evidence and discloses visual failure after bounded per-page retries', async () => {
    models.visual.mockRejectedValue(new Error('Synthetic outage'));
    for (let i=0;i<6;i++) await run();
    expect(await run()).toMatchObject({pending:false});
    expect(models.structure).toHaveBeenCalledTimes(2);
    expect(models.visual).toHaveBeenCalledTimes(6);
    expect((await query("SELECT COUNT(*)::int AS count FROM resource_document_pages WHERE resource_id=$1 AND status='failed'",[id])).rows[0].count).toBe(2);
    expect((await query('SELECT content FROM resource_chunks WHERE resource_id=$1',[id])).rows.some(c=>String(c.content).includes('ORBIT-219'))).toBe(true);
  });
  it('does not initialize or publish a generation after its lease is lost', async () => {
    await expect(run(1,async()=>{throw new Error('lease lost');})).rejects.toThrow('lease lost');
    expect((await query('SELECT page_number FROM resource_document_pages WHERE resource_id=$1',[id])).rows).toEqual([]);
    expect((await query('SELECT content FROM resource_chunks WHERE resource_id=$1',[id])).rows[0].content).toBe('previous complete generation');
  });
});
