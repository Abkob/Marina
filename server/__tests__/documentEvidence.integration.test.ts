import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { query } from '../db.js';
import { SKIP_INTEGRATION, startTestServer, stopTestServer } from './setup.js';
import { EMBED_MODEL } from '../config/providers.js';
import { searchDocuments } from '../services/documentRag.js';
import { searchResearchEvidence } from '../services/researchRag.js';
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
  it('retrieves research evidence after chunk 1000 through database-ranked search', async () => {
    const id = await resource('Long research document');
    const now = new Date().toISOString();
    await query('INSERT INTO research_papers(id,resource_id,created_at,updated_at) VALUES($1,$2,$3,$3)',[crypto.randomUUID(),id,now]);
    await query(`INSERT INTO resource_chunks(id,resource_id,chunk_index,content,page_start,page_end,created_at)
      SELECT $1||'-'||n,$1,n,CASE WHEN n=1200 THEN 'Rarequasar concluding theorem' ELSE 'Ordinary paragraph' END,n+1,n+1,$2 FROM generate_series(0,1200) n`,[id,now]);
    const result = await searchResearchEvidence('Rarequasar');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({resource_id:id,page_start:1201,passage:'Rarequasar concluding theorem'});
  });
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
  it('discovers a small semantically matching document beside a long book without a matching title', async () => {
    const large = await resource('Encyclopedia'), small = await resource('Geometry lectures');
    for (let i = 0; i < 26; i++) {
      const chunk = crypto.randomUUID(), id = i === 25 ? small : large;
      await query('INSERT INTO resource_chunks(id,resource_id,chunk_index,content,page_start,page_end,created_at) VALUES($1,$2,$3,$4,117,117,$5)', [chunk, id, i, 'Rotations and reflections preserve distances.', new Date().toISOString()]);
      await embedding(chunk, 'Rotations and reflections preserve distances.');
    }
    const result = await findResources({ search: 'Introduction to algebra', query: 'isometry groups' }, 'off');
    expect(result).toMatchObject({ title_matches: [] });
    expect(new Set(result.resources.map(row => row.id))).toEqual(new Set([large, small]));
    expect(result).toMatchObject({ semantic_discovery: { vector_degraded: false, coverage: { exhaustive: false } } });
    const evidence = 'evidence' in result ? result.evidence : [];
    expect(new Set(evidence.map(row => row.resource_id))).toEqual(new Set([large, small]));
    expect(evidence.filter(row => row.resource_id === large).length).toBeLessThanOrEqual(2);
    expect(evidence.find(row => row.resource_id === small)).toMatchObject({ page_start: 117, passage: 'Rotations and reflections preserve distances.' });
  });
  it('finds original filenames and excludes unavailable, stale and unready evidence', async () => {
    const good = await resource('My saved book');
    await query('UPDATE resources SET original_name=$2 WHERE id=$1', [good, 'Introduction_to_Abstract_Algebra.pdf']);
    expect((await findResources({ search: 'Introduction Abstract Algebra' }, 'off')).resources.map(row => row.id)).toEqual([good]);
    for (const state of ['unavailable', 'stale', 'queued']) {
      const id = await resource(`Hidden ${state}`), chunk = crypto.randomUUID();
      await query('INSERT INTO resource_chunks(id,resource_id,chunk_index,content,page_start,page_end,created_at) VALUES($1,$2,0,$3,1,1,$4)', [chunk, id, 'isometry groups', new Date().toISOString()]);
      await embedding(chunk, 'isometry groups');
      if (state === 'stale') {
        await query('UPDATE embeddings SET is_stale=true WHERE entity_id=$1', [chunk]);
        // No lexical overlap: this case specifically checks stale vector exclusion.
        await query("UPDATE resource_chunks SET content='Rotations' WHERE id=$1", [chunk]);
      }
      if (state === 'queued') await query("UPDATE resource_processing_jobs SET status='queued' WHERE resource_id=$1", [id]);
      if (state === 'unavailable') {
        await query("UPDATE resources SET file_path='gdrive://hidden' WHERE id=$1", [id]);
        await query("INSERT INTO resource_drive_files(resource_id,file_id,source_mime,source_version,available) VALUES($1,$1,'application/pdf','1',false)", [id]);
      }
    }
    expect(await findResources({ search: 'absent title', query: 'isometry groups' }, 'off')).toMatchObject({ evidence: [], semantic_discovery: { vector_degraded: false } });
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
