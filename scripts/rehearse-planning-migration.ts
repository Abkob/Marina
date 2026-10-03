import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
import { assertPlanningTestDatabase,validatePlanningTestUrl } from '../audits/planning/databaseFixtures.js';
import { emptyPlanContent } from '../shared/planningState.js';

// Only creates uniquely named databases on the explicitly marked local test cluster.
// It never restores over an existing database and never reads production settings.
const source=new URL(validatePlanningTestUrl(process.env.DATABASE_URL_TEST,process.env.PLANNING_TEST_DB));
const original=new pg.Client({connectionString:source.toString()});await original.connect();
try{await assertPlanningTestDatabase(original as any);}finally{await original.end();}
const adminUrl=new URL(source);adminUrl.pathname='/postgres';const admin=new pg.Client({connectionString:adminUrl.toString()});await admin.connect();
const stamp=Date.now().toString();const names=['empty','upgrade','dump_restore','portable_restore'].map(kind=>`marina_planning_test_${kind}_${stamp}`);
const output=path.resolve('tmp/planning-baseline');await fs.mkdir(output,{recursive:true});
const run=promisify(execFile);const pgBin=process.env.PG_BIN ?? 'C:/Program Files/PostgreSQL/18/bin';
const dbUrl=(name:string)=>{const url=new URL(source);url.pathname=`/${name}`;return url.toString();};
const pgEnv=(name:string)=>({...process.env,PGHOST:source.hostname,PGPORT:source.port||'5432',PGDATABASE:name,PGUSER:decodeURIComponent(source.username),PGPASSWORD:decodeURIComponent(source.password)});
const clients:pg.Client[]=[];
try{
  for(const name of names){assert(/^marina_planning_test_[a-z_]+_\d+$/.test(name));await admin.query(`CREATE DATABASE "${name}"`);await admin.query(`COMMENT ON DATABASE "${name}" IS 'marina:p02:rehearsal'`);}
  const current=await fs.readFile('server/schema.sql','utf8');
  const migration=await fs.readFile('server/migrations/031-persistent-plans.sql','utf8');
  const prior=(await run('git',['show','a25bd43e21d63917c6c0d3478e193bb3816b1049:server/schema.sql'],{maxBuffer:4*1024*1024,windowsHide:true})).stdout;
  for(let i=0;i<2;i++){
    const client=new pg.Client({connectionString:dbUrl(names[i])});await client.connect();clients.push(client);
    await client.query(i===0?current:prior);
    await client.query("INSERT INTO tasks(id,title,created_at,updated_at) VALUES ('rehearsal-task','Preserved legacy task',NOW()::text,NOW()::text)");
    await client.query(migration);await client.query(migration);
    assert.equal((await client.query("SELECT title FROM tasks WHERE id='rehearsal-task'")).rows[0].title,'Preserved legacy task');
    await client.query('BEGIN');await client.query("INSERT INTO planning_plans(id,task_id) VALUES ('rehearsal-plan','rehearsal-task')");
    await client.query("INSERT INTO planning_plan_revisions(plan_id,version,content,origin,operation,idempotency_key,request_hash) VALUES ('rehearsal-plan',0,$1,'user','create','rehearsal','hash')",[JSON.stringify({...emptyPlanContent(),outcome:'Recover this synthetic plan'})]);await client.query('COMMIT');
  }
  const dump=path.join(output,`p02-${stamp}.dump`);
  await run(path.join(pgBin,'pg_dump.exe'),['--format=custom','--file',dump],{env:pgEnv(names[1]),windowsHide:true,timeout:120000});
  await run(path.join(pgBin,'pg_restore.exe'),['--exit-on-error','--no-owner','--dbname',names[2],dump],{env:pgEnv(names[2]),windowsHide:true,timeout:120000});
  process.env.NODE_ENV='test';process.env.DATABASE_URL_TEST=dbUrl(names[1]);
  const {createPortableBackupArchive}=await import('../server/services/portableBackup.js');
  const {verifyPortableBackup}=await import('./lib/portableBackup.js');
  const {createWriteStream}=await import('node:fs');const zip=path.join(output,`p02-${stamp}.marina-backup.zip`);
  await createPortableBackupArchive(createWriteStream(zip));const verified=await verifyPortableBackup(zip);
  for(const name of ['planning_plans','planning_plan_revisions','planning_scenarios'])assert(verified.manifest.database.tables.some(table=>table.name===name));
  await run(process.execPath,['--import','tsx','scripts/restore-portable-backup.ts',zip],{env:{...process.env,TARGET_DATABASE_URL:dbUrl(names[3]),CONFIRM_PORTABLE_RESTORE:'1',RESTORE_STORAGE:'local'},windowsHide:true,timeout:120000,maxBuffer:1024*1024});
  for(const name of names.slice(2)){
    const client=new pg.Client({connectionString:dbUrl(name)});await client.connect();clients.push(client);
    assert.equal((await client.query("SELECT content->>'outcome' AS outcome FROM planning_plan_revisions WHERE plan_id='rehearsal-plan'")).rows[0].outcome,'Recover this synthetic plan');
    await assert.rejects(client.query("UPDATE planning_plans SET head_version=999 WHERE id='rehearsal-plan'"),{code:'23503'});
  }
  const receipt={checked_at:new Date().toISOString(),empty_migration:true,prior_schema_upgrade:true,repeated_migration:true,legacy_task_preserved:true,custom_dump_restore:true,portable_archive_checksums:true,portable_restore:true,head_foreign_key_restored:true,production_used:false,databases:names};
  await fs.writeFile(path.join(output,'p02-migration-rehearsal.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{for(const client of clients)await client.end();await admin.end();const db=await import('../server/db.js');await db.getPool().end();}
