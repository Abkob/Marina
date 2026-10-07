import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import crypto from 'node:crypto';
vi.hoisted(()=>{process.env.MARINA_EMBEDDING_MODEL='nvidia/nemotron-3-embed-1b';});
vi.mock('../services/nemotronEmbeddings',async()=>({...await vi.importActual<any>('../services/nemotronEmbeddings'),nemotronEmbeddings:vi.fn()}));
import {nemotronEmbeddings} from '../services/nemotronEmbeddings';
import {query} from '../db';
import {embedEntity} from '../routes/embeddings';
import {processEmbeddingJobs} from '../services/embeddingWorker';
import {baseUrl,SKIP_INTEGRATION,startTestServer,stopTestServer} from './setup';
const ids:string[]=[],now=new Date().toISOString();
const vector=(dimension=2048)=>'['+Array.from({length:dimension},(_,index)=>index===0?1:0).join(',')+']';
const call=(path:string,method:string,body?:unknown)=>fetch(baseUrl+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
async function make(title='synthetic note'){const response=await call('/api/notes','POST',{title,content:'An independent source fact.',date_str:'2026-10-07'});expect(response.status).toBe(200);const {id}=await response.json();ids.push(id);return id as string;}
async function pending(id:string){return (await query("SELECT id FROM embedding_jobs WHERE entity_type='note' AND entity_id=$1 AND status='pending'",[id])).rows;}
async function clearJobs(id:string){await query("DELETE FROM embedding_jobs WHERE entity_type='note' AND entity_id=$1",[id]);}
async function current(id:string){await clearJobs(id);await embedEntity('note',id);}
async function rejectQueue(title:string,run:()=>Promise<void>){
 await query(`CREATE OR REPLACE FUNCTION test_reject_note_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_type='note' AND EXISTS(SELECT 1 FROM notes WHERE id=NEW.entity_id AND title=${"'"+title.replace(/'/g,"''")+"'"}) THEN RAISE EXCEPTION 'synthetic queue failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_note_queue_failure BEFORE INSERT ON embedding_jobs FOR EACH ROW EXECUTE FUNCTION test_reject_note_queue()`);
 try{await run();}finally{await query('DROP TRIGGER test_note_queue_failure ON embedding_jobs; DROP FUNCTION test_reject_note_queue()');await query('DELETE FROM notes WHERE title=$1',[title]);}
}
describe.skipIf(SKIP_INTEGRATION)('durable note saves and native embedding lifecycle',()=>{
 beforeAll(async()=>{await startTestServer();vi.mocked(nemotronEmbeddings).mockImplementation(async texts=>texts.map(()=>JSON.parse(vector())));},60000);
 afterAll(async()=>{if(ids.length){await query("DELETE FROM embedding_jobs WHERE entity_type='note' AND entity_id=ANY($1)",[ids]);await query('DELETE FROM notes WHERE id=ANY($1)',[ids]);await query("DELETE FROM embeddings WHERE entity_type='note' AND entity_id=ANY($1)",[ids]);}await stopTestServer();});
 it('persists creation with one pending job, then the real worker makes the note searchable',async()=>{
  const id=await make();expect(await pending(id)).toHaveLength(1);
  const result=await processEmbeddingJobs(50);expect(result.failed).toBe(0);
  expect((await query('SELECT is_stale FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0]).toEqual({is_stale:false});
  const search=await fetch(baseUrl+'/api/search?q=no-literal-match&types=note&limit=50');const body=await search.json();expect(body.vector_degraded).toBe(false);expect(body.results.map((row:any)=>row.entity_id)).toContain(id);
 });
 it.each(['title','content','date_str'])('queues a replacement for changed %s and the worker restores current coverage',async field=>{
  const id=await make();await current(id);const response=await call('/api/notes/'+id,'PATCH',{[field]:field==='date_str'?'2026-10-08':'Changed source value'});expect(response.status).toBe(200);
  expect((await query('SELECT is_stale FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0].is_stale).toBe(true);expect(await pending(id)).toHaveLength(1);
  await processEmbeddingJobs(50);expect((await query('SELECT is_stale FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0].is_stale).toBe(false);
 });
 it('keeps unchanged source text and completion bookkeeping current with both profiles present',async()=>{
  const id=await make();await current(id);await query(`INSERT INTO embeddings(id,entity_type,entity_id,embedding_scope,embedding_text,embedding_3072,embedding_model,embedding_dimension,content_hash,created_at,updated_at) VALUES($1,'note',$2,'full_text','legacy',$3::halfvec,'gemini-embedding-2',3072,'legacy',$4,$4)`,[crypto.randomUUID(),id,vector(3072),now]);
  expect((await call('/api/notes/'+id,'PATCH',{title:'synthetic note',content:'An independent source fact.',date_str:'2026-10-07',completed:true})).status).toBe(200);
  expect(await pending(id)).toHaveLength(0);expect((await query('SELECT is_stale FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0].is_stale).toBe(false);
 });
 it('rolls back creation when its durable queue insert fails instead of reporting a saved unsearchable note',async()=>{
  const title='synthetic failing queue '+crypto.randomUUID();await rejectQueue(title,async()=>{
   expect((await call('/api/notes','POST',{title,content:'Must roll back'})).status).toBe(500);
   expect((await query('SELECT id FROM notes WHERE title=$1',[title])).rows).toHaveLength(0);
  });
 });
 it('rolls back an edit and invalidation together if replacement queuing fails',async()=>{
  const id=await make();await current(id);const title='synthetic failed edit '+crypto.randomUUID();await rejectQueue(title,async()=>{
   expect((await call('/api/notes/'+id,'PATCH',{title})).status).toBe(500);
   expect((await query('SELECT title FROM notes WHERE id=$1',[id])).rows[0].title).toBe('synthetic note');
   expect((await query('SELECT is_stale FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0].is_stale).toBe(false);expect(await pending(id)).toHaveLength(0);
  });
 });
 it('deduplicates eight simultaneous edits and deletes pending work without resurrecting a removed source',async()=>{
  const id=await make();await current(id);
  const responses=await Promise.all(Array.from({length:8},(_,index)=>call('/api/notes/'+id,'PATCH',{content:'Concurrent fact '+index})));expect(responses.every(row=>row.status===200)).toBe(true);expect(await pending(id)).toHaveLength(1);
  await processEmbeddingJobs(50);expect((await query('SELECT is_stale FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0].is_stale).toBe(false);
  expect((await call('/api/notes/'+id,'PATCH',{content:'Final queued edit'})).status).toBe(200);expect((await call('/api/notes/'+id,'DELETE')).status).toBe(200);
  expect(await pending(id)).toHaveLength(0);await processEmbeddingJobs(50);expect((await query('SELECT id FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows).toHaveLength(0);
 });
});
