import {beforeAll,afterAll,describe,expect,it,vi} from 'vitest';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
vi.hoisted(()=>{process.env.MARINA_EMBEDDING_MODEL='nvidia/nemotron-3-embed-1b';});
vi.mock('../services/nemotronEmbeddings',async()=>({...await vi.importActual<any>('../services/nemotronEmbeddings'),nemotronEmbeddings:vi.fn()}));
import {nemotronEmbeddings} from '../services/nemotronEmbeddings';
import {query} from '../db';
import {startTestServer,stopTestServer,baseUrl,SKIP_INTEGRATION} from './setup';
import {embedEntity,buildEmbeddingText} from '../routes/embeddings';
import {searchDocuments} from '../services/documentRag';
import {runSuggestionGeneration} from '../routes/topics';
const vector=(index=0,dimension=2048)=>'['+Array.from({length:dimension},(_,i)=>i===index?1:0).join(',')+']';
const embed=vi.mocked(nemotronEmbeddings),ids:string[]=[],now=new Date().toISOString();
async function task(){const id=crypto.randomUUID();ids.push(id);await query('INSERT INTO tasks(id,title,created_at,updated_at) VALUES($1,$2,$3,$3)',[id,'synthetic search task',now]);return id;}
describe.skipIf(SKIP_INTEGRATION)('Nemotron migration and production SQL with disposable PostgreSQL',()=>{
 beforeAll(async()=>{await startTestServer();embed.mockImplementation(async texts=>texts.map(()=>JSON.parse(vector())));},60000);
 afterAll(async()=>{if(ids.length){await query('DELETE FROM tasks WHERE id=ANY($1)',[ids]);await query("DELETE FROM embeddings WHERE entity_type='task' AND entity_id=ANY($1)",[ids]);}await stopTestServer();});
 it('writes and searches native Nemotron vectors while retaining the Gemini rollback row',async()=>{
  const id=await task();await query(`INSERT INTO embeddings(id,entity_type,entity_id,embedding_scope,embedding_text,embedding_3072,embedding_model,embedding_dimension,content_hash,created_at,updated_at) VALUES($1,'task',$2,'full_text','Gemini rollback',$3::halfvec,'gemini-embedding-2',3072,'old',$4,$4)`,[crypto.randomUUID(),id,vector(0,3072),now]);
  await embedEntity('task',id);const gem=(await query("SELECT embedding_model,embedding_dimension,content_hash FROM embeddings WHERE entity_id=$1",[id])).rows[0];
  expect(gem).toEqual({embedding_model:'gemini-embedding-2',embedding_dimension:3072,content_hash:'old'});
  const nem=(await query('SELECT embedding_dimension,embedding_generation FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0];expect(nem).toEqual({embedding_dimension:2048,embedding_generation:'nemotron-byte-windows-mean-v1'});
  const response=await fetch(baseUrl+'/api/embeddings/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'task',entity_types:['task']})});
  expect(response.status).toBe(200);expect((await response.json()).map((row:any)=>row.entity_id)).toContain(id);
  const global=await fetch(baseUrl+'/api/search?q=semantic-no-literal-match&types=task');const globalBody=await global.json();
  expect(global.status).toBe(200);expect(globalBody.vector_degraded).toBe(false);expect(globalBody.results.map((row:any)=>row.entity_id)).toContain(id);
 });
 it('refuses to mark a changed source current after an in-flight embedding request',async()=>{
  const id=await task();embed.mockImplementationOnce(async()=>{await query('UPDATE tasks SET title=$2 WHERE id=$1',[id,'changed during inference']);return [JSON.parse(vector())];});
  await expect(embedEntity('task',id)).rejects.toThrow('embedding_source_changed');
  expect((await query('SELECT id FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows).toEqual([]);
 });
 it('invalidates/deletes a new-profile-only entity and excludes stale search results',async()=>{
  const id=await task();await embedEntity('task',id);await query('UPDATE tasks SET title=$2 WHERE id=$1',[id,'modified']);
  expect((await query('SELECT is_stale FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0].is_stale).toBe(true);
  const response=await fetch(baseUrl+'/api/embeddings/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'task',entity_types:['task']})});
  expect((await response.json()).map((row:any)=>row.entity_id)).not.toContain(id);
  await query('DELETE FROM tasks WHERE id=$1',[id]);expect((await query('SELECT id FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows).toEqual([]);
 });
 it('keeps unchanged vectors visible during work-version and timestamp bookkeeping',async()=>{
  const id=await task();await embedEntity('task',id);
  await query('UPDATE tasks SET work_version=work_version+1,worklog_version=worklog_version+1,updated_at=$2 WHERE id=$1',[id,new Date().toISOString()]);
  expect((await query('SELECT is_stale FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0].is_stale).toBe(false);
  await query('UPDATE tasks SET description=$2 WHERE id=$1',[id,'Changed actual requirements']);
  expect((await query('SELECT is_stale FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0].is_stale).toBe(true);
 });
 it('invalidates a goal for milestone insertion, renaming and deletion while retaining unchanged bookkeeping',async()=>{
  const id=crypto.randomUUID(),milestone=crypto.randomUUID();
  await query('INSERT INTO goals(id,title,created_at,updated_at) VALUES($1,$2,$3,$3)',[id,'Synthetic goal',now]);
  try{
   await embedEntity('goal',id);
   await query('UPDATE goals SET updated_at=$2 WHERE id=$1',[id,new Date().toISOString()]);
   expect((await query('SELECT is_stale FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0].is_stale).toBe(false);
   await query('INSERT INTO goal_milestones(id,goal_id,title,created_at,updated_at) VALUES($1,$2,$3,$4,$4)',[milestone,id,'First milestone',now]);
   expect((await query('SELECT is_stale FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0].is_stale).toBe(true);
   await embedEntity('goal',id);await query('UPDATE goal_milestones SET title=$2 WHERE id=$1',[milestone,'Renamed milestone']);
   expect((await query('SELECT is_stale FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0].is_stale).toBe(true);
   await embedEntity('goal',id);await query('DELETE FROM goal_milestones WHERE id=$1',[milestone]);
   expect((await query('SELECT is_stale FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0].is_stale).toBe(true);
  }finally{await query('DELETE FROM goals WHERE id=$1',[id]);}
 });
 it('keeps a single row under concurrent idempotent upserts and permits a rollback search',async()=>{
  const id=await task();await Promise.all(Array.from({length:12},()=>embedEntity('task',id)));
  expect((await query('SELECT count(*)::int AS count FROM nemotron_embeddings WHERE entity_id=$1',[id])).rows[0].count).toBe(1);
  expect((await query('SELECT count(*)::int AS count FROM embeddings WHERE embedding_model=$1 AND embedding_dimension=$2',['gemini-embedding-2',3072])).rows[0].count).toBeGreaterThanOrEqual(1);
 });
 it('uses the selected profile in topic similarity instead of retained Gemini vectors',async()=>{
  const member=await task(),candidate=await task(),topic=crypto.randomUUID();let runId:string|undefined;
  await embedEntity('task',member);await embedEntity('task',candidate);
  await query('INSERT INTO topics(id,name,created_at,updated_at) VALUES($1,$2,$3,$3)',[topic,'Synthetic semantic cluster',now]);
  try{
   await query("INSERT INTO topic_memberships(id,topic_id,entity_type,entity_id,status,source,created_at,updated_at) VALUES($1,$2,'task',$3,'accepted','manual',$4,$4)",[crypto.randomUUID(),topic,member,now]);
   const result=await runSuggestionGeneration(topic);runId=result.run_id;
   const suggestion=(await query("SELECT status,evidence_json FROM topic_memberships WHERE topic_id=$1 AND entity_type='task' AND entity_id=$2",[topic,candidate])).rows[0];
   expect(suggestion?.status).toBe('suggested');expect(JSON.parse(suggestion.evidence_json as string).cosine.score).toBeGreaterThan(.99);
  }finally{await query('DELETE FROM topics WHERE id=$1',[topic]);if(runId)await query('DELETE FROM suggestion_runs WHERE id=$1',[runId]);}
 });
 it('does not disclose raw journals merely because resource mode says local',async()=>{
  const id=crypto.randomUUID();await query('INSERT INTO journal_entries(id,entry_date,raw_text,summary,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',[id,'2026-10-07','PRIVATE RAW JOURNAL','synthetic summary',now]);
  try{vi.stubEnv('ALLOW_CLOUD_RAW_TEXT','false');expect(await buildEmbeddingText('journal_entry',id)).not.toContain('PRIVATE RAW JOURNAL');}finally{vi.unstubAllEnvs();await query('DELETE FROM journal_entries WHERE id=$1',[id]);}
 });
 it('executes the Nemotron semantic document lane with selected-source citations and visibility filters',async()=>{
  const resources:string[]=[];
  try{
   for(const name of ['Selected lecture','Other lecture']){
    const id=crypto.randomUUID(),chunk=crypto.randomUUID();resources.push(id);
    await query("INSERT INTO resources(id,title,created_at,file_validation,mime_type) VALUES($1,$2,$3,'valid','text/plain')",[id,name,now]);
    await query("INSERT INTO resource_processing_jobs(id,resource_id,status) VALUES($1,$2,'ready')",[crypto.randomUUID(),id]);
    await query('INSERT INTO resource_chunks(id,resource_id,chunk_index,content,page_start,page_end,created_at) VALUES($1,$2,0,$3,17,18,$4)',[chunk,id,'Rotations preserve distances.',now]);
    await embedEntity('resource_chunk',chunk);
   }
   const result=await searchDocuments('isometry groups',[resources[0]],1,'off');
   expect(result.vector_degraded).toBe(false);
   expect(result.evidence).toHaveLength(1);
   expect(result.evidence[0]).toMatchObject({resource_id:resources[0],page_start:17,page_end:18,passage:'Rotations preserve distances.',source_url:`/api/resources/blob/${resources[0]}`});
   expect(result.coverage?.resource_ids_without_evidence).toEqual([]);
   const inspection=await fetch(baseUrl+`/api/resources/${resources[0]}/chunks`);
   expect(inspection.status).toBe(200);expect((await inspection.json())[0]).toMatchObject({has_embedding:true,embedding_stale:false});
   await query("UPDATE resource_processing_jobs SET status='queued' WHERE resource_id=$1",[resources[0]]);
   expect((await searchDocuments('isometry groups',[resources[0]],1,'off')).evidence).toEqual([]);
   await query("UPDATE resource_processing_jobs SET status='ready' WHERE resource_id=$1",[resources[0]]);
   await query('UPDATE resource_chunks SET content=$2 WHERE resource_id=$1',[resources[0],'Changed evidence']);
   const stale=await searchDocuments('isometry groups',[resources[0]],1,'off');
   expect(stale.vector_degraded).toBe(false);expect(stale.evidence).toEqual([]);
  }finally{await query('DELETE FROM resources WHERE id=ANY($1)',[resources]);}
 });
 it('rejects wrong dimensions and can rerun the additive migration without losing either profile',async()=>{
  const id=await task();await expect(query(`INSERT INTO nemotron_embeddings(id,entity_type,entity_id,embedding_scope,embedding_text,embedding_2048,content_hash,created_at,updated_at) VALUES($1,'task',$2,'full_text','bad',$3::halfvec,'bad',$4,$4)`,[crypto.randomUUID(),id,vector(0,3072),now])).rejects.toThrow();
  const before=(await query('SELECT count(*)::int AS count FROM nemotron_embeddings')).rows[0].count;
  await query(readFileSync('server/migrations/034-nemotron-embeddings.sql','utf8'));
  expect((await query('SELECT count(*)::int AS count FROM nemotron_embeddings')).rows[0].count).toBe(before);
 });
});
