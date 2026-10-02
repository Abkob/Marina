import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { query } from '../db.js';
import { SKIP_INTEGRATION, startTestServer, stopTestServer } from './setup.js';
import { EMBED_MODEL } from '../config/providers.js';
import { searchDocuments } from '../services/documentRag.js';
import { findResources, readDocument } from '../services/documentReading.js';
import { processResourceChunks } from '../services/chunkPipeline.js';
const vector = `[${[1, ...Array(3071).fill(0)].join(',')}]`;
vi.mock('../embeddingProvider.js', async original => ({ ...await original<typeof import('../embeddingProvider.js')>(), embedQuery: async () => [1, ...Array(3071).fill(0)] }));
const ids: string[] = [];
const files: string[] = [];
async function resource(title: string) {
  const id = crypto.randomUUID(); ids.push(id);
  await query("INSERT INTO resources(id,title,created_at,file_validation,mime_type) VALUES($1,$2,$3,'valid','text/plain')", [id, title, new Date().toISOString()]);
  await query("INSERT INTO resource_processing_jobs(id,resource_id,status) VALUES($1,$2,'ready')", [crypto.randomUUID(), id]);
  return id;
}
async function embedding(chunk: string, text: string) {
  await query(`INSERT INTO embeddings(id,entity_type,entity_id,embedding_scope,embedding_text,embedding_3072,embedding_model,embedding_dimension,content_hash,created_at,updated_at)
    VALUES($1,'resource_chunk',$2,'full_text',$3,$4::halfvec,$5,3072,$6,$7,$7)`, [crypto.randomUUID(), chunk, text, vector, EMBED_MODEL, crypto.randomUUID(), new Date().toISOString()]);
}
describe.skipIf(SKIP_INTEGRATION)('document evidence with real PostgreSQL', () => {
  beforeAll(startTestServer); afterAll(stopTestServer);
  afterEach(async () => {
    await query("DELETE FROM embeddings WHERE entity_type='resource_chunk' AND entity_id IN(SELECT id FROM resource_chunks WHERE resource_id=ANY($1))", [ids]);
    await query('DELETE FROM resources WHERE id=ANY($1)', [ids]); ids.length = 0;
    for (const file of files.splice(0)) await fs.unlink(file);
  });
  it('executes both retrieval lanes and retains a small selected file beside a long one', async () => {
    const a = await resource('Large recovery study'), b = await resource('Small recovery study');
    for (let i = 0; i < 21; i++) {
      const chunk = crypto.randomUUID(), id = i === 20 ? b : a;
      await query('INSERT INTO resource_chunks(id,resource_id,chunk_index,content,page_start,page_end,created_at) VALUES($1,$2,$3,$4,1,1,$5)', [chunk, id, i, `recovery ${i}`, new Date().toISOString()]);
      await embedding(chunk, `recovery ${i}`);
    }
    const result = await searchDocuments('recovery', [a, b], 2, 'off');
    expect(result.vector_degraded).toBe(false);
    expect(new Set(result.evidence.map(row => row.resource_id))).toEqual(new Set([a, b]));
    expect(result.coverage?.resource_ids_without_evidence).toEqual([]);
  });
  it('executes literal resource discovery and page-filtered sequential reading', async () => {
    const id = await resource('50% evidence_literal');
    await query('INSERT INTO resource_chunks(id,resource_id,chunk_index,content,page_start,page_end,created_at) VALUES($1,$2,0,$3,2,2,$4)', [crypto.randomUUID(), id, 'Exact passage', new Date().toISOString()]);
    expect((await findResources({ search: '50% evidence_literal' })).resources.map(row => row.id)).toEqual([id]);
    expect((await readDocument({ resource_id: id, page: 2 })).passages).toHaveLength(1);
    expect((await readDocument({ resource_id: id, page: 1 })).passages).toEqual([]);
  });
  it('invalidates the legacy short embedding even when the chunk is reused, then gives changed content a new ID', async () => {
    const id = await resource('Versioned source');
    const file = path.resolve('tmp', `document-version-${id}.txt`); files.push(file);
    await fs.writeFile(file, 'Original recovery study with stable text.');
    await processResourceChunks(id, file, 'text/plain', { enqueueEmbeddings: false });
    const first = (await query<{ id: string }>('SELECT id FROM resource_chunks WHERE resource_id=$1', [id])).rows[0].id;
    await embedding(first, 'Entity: Resource Chunk\nResource: Versioned source\nOriginal recovery study');
    expect(await processResourceChunks(id, file, 'text/plain', { enqueueEmbeddings: false })).toMatchObject({ reused: 1 });
    expect((await query('SELECT is_stale FROM embeddings WHERE entity_id=$1', [first])).rows[0].is_stale).toBe(true);
    await fs.writeFile(file, 'Changed recovery study with different evidence.');
    await processResourceChunks(id, file, 'text/plain', { enqueueEmbeddings: false });
    expect((await query('SELECT id FROM resource_chunks WHERE resource_id=$1', [id])).rows[0].id).not.toBe(first);
    expect((await query('SELECT id FROM embeddings WHERE entity_id=$1', [first])).rows).toEqual([]);
  });
});
