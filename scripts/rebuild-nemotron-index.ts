/** Explicit shadow rebuild. Requires verified current backup; never writes the Gemini table. */
import 'dotenv/config';
import {readFileSync,writeFileSync} from 'node:fs';
import {query,getPool} from '../server/db.js';
import {embedEntity} from '../server/routes/embeddings.js';
import {EMBED_TABLE,EMBED_MODEL,EMBED_DIMENSION} from '../server/config/providers.js';
import {activeEntitySql,activeResourceSql} from '../server/utils/archiveVisibility.js';
if(process.env.CONFIRM_NEMOTRON_REBUILD!=='1'||EMBED_TABLE!=='nemotron_embeddings') throw new Error('Select Nemotron and explicitly authorize its backed-up shadow rebuild.');
const backup=JSON.parse(readFileSync(process.env.VERIFIED_INDEX_BACKUP_RECEIPT??'','utf8'));
if(!backup.cloudReadbackVerified||!backup.fullArchiveDecompressionVerified||Date.now()-Date.parse(backup.createdAt)>6*3600000)throw new Error('A current verified private database backup is required.');
const types={goal:'goals',task:'tasks',resource:'resources',journal_entry:'journal_entries',note:'notes',meeting:'meetings'} as const;
try{
 const targets:Array<{type:string;id:string}>=[];
 for(const [type,table] of Object.entries(types)){
  const rows=(await query(`SELECT entity.id FROM ${table} entity WHERE ${activeEntitySql("'"+type+"'","entity.id")} ORDER BY entity.id`)).rows;
  targets.push(...rows.map(row=>({type,id:row.id as string})));
 }
 const chunks=(await query(`SELECT c.id FROM resource_chunks c JOIN resources r ON r.id=c.resource_id
  LEFT JOIN resource_processing_jobs j ON j.resource_id=r.id LEFT JOIN resource_drive_files d ON d.resource_id=r.id
  WHERE ${activeResourceSql('r.id')} AND (j.resource_id IS NULL OR j.status='ready')
    AND (d.resource_id IS NULL OR (d.available AND r.file_validation='valid'))
  ORDER BY c.resource_id,c.chunk_index`)).rows;
 targets.push(...chunks.map(row=>({type:'resource_chunk',id:row.id as string})));
 let cursor=0,processed=0;const failed:Array<{type:string;id:string;status:number|null}>=[];
 const worker=async()=>{
  while(cursor<targets.length){
   const target=targets[cursor++];let ok=false,status:number|null=null;
   for(let attempt=0;attempt<3&&!ok;attempt++){
    try{await embedEntity(target.type,target.id);ok=true;}catch(error){
     status=typeof error==='object'&&error!==null&&'status' in error?Number(error.status):null;
     const changed=error instanceof Error&&error.message.startsWith('embedding_source_changed');
     if(!changed&&![429,502,503,504].includes(status??0))break;
     if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));
    }
   }
   if(ok)processed++;else failed.push({...target,status});
   if((processed+failed.length)%25===0)console.log(JSON.stringify({completed:processed,failed:failed.length,total:targets.length}));
  }
 };
 await Promise.all([worker(),worker()]);
 const current=(await query('SELECT entity_type,entity_id,is_stale,embedding_model,embedding_dimension FROM nemotron_embeddings')).rows;
 const missing=targets.filter(target=>!current.some(row=>row.entity_type===target.type&&row.entity_id===target.id&&!row.is_stale&&row.embedding_model===EMBED_MODEL&&Number(row.embedding_dimension)===EMBED_DIMENSION));
 const receipt={at:new Date().toISOString(),model:EMBED_MODEL,dimension:EMBED_DIMENSION,processed,total:targets.length,failed,missing,geminiWrites:0,backup:backup.sha256,complete:failed.length===0&&missing.length===0};
 writeFileSync('tmp/nemotron-rebuild-receipt.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify({...receipt,failed:failed.length,missing:missing.length}));
 if(!receipt.complete)process.exitCode=1;
} finally {await getPool().end();}
