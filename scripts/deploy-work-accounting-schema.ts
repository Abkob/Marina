// Applies only M-032. Never imports local application data into production.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import pg from 'pg';
import { get } from '@vercel/blob';

if (process.env.CONFIRM_WORK_ACCOUNTING_SCHEMA_APPLY !== '1') throw new Error('Explicit deployment configuration is required.');
if (!process.env.DATABASE_URL || !process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Production database and private backup storage configuration are required.');
const receiptPath = process.argv[2];
if (!receiptPath) throw new Error('Pass the verified database backup receipt path.');
const receipt = JSON.parse(await fsp.readFile(receiptPath,'utf8'));
const age = Date.now()-Date.parse(receipt.created_at);
if (!Number.isFinite(age) || age < 0 || age > 60*60_000) throw new Error('A backup verified within the last hour is required.');
const url = new URL(process.env.DATABASE_URL);
const hostHash = crypto.createHash('sha256').update(url.hostname).digest('hex');
if (hostHash !== receipt.database_host_sha256 || decodeURIComponent(url.pathname.slice(1)) !== receipt.database) throw new Error('The backup does not belong to the selected production database.');
if (receipt.verified !== 'full pg_restore read and private cloud SHA-256 read-back') throw new Error('The required restore-read verification is missing.');
const localHash = crypto.createHash('sha256'); let localBytes=0;
for await (const part of fs.createReadStream(receipt.file)) { localHash.update(part);localBytes+=part.length; }
if(localHash.digest('hex')!==receipt.sha256 || localBytes!==receipt.bytes) throw new Error('Local recovery copy checksum mismatch.');
const backup = await get(receipt.cloud_path,{access:'private',useCache:false,abortSignal:AbortSignal.timeout(30_000)});
if(!backup || backup.statusCode!==200) throw new Error('Private cloud recovery copy is unavailable.');
const cloudHash=crypto.createHash('sha256');let cloudBytes=0;
for await(const part of Readable.fromWeb(backup.stream as never)){cloudHash.update(part);cloudBytes+=part.length;}
if(cloudHash.digest('hex')!==receipt.sha256 || cloudBytes!==receipt.bytes)throw new Error('Private cloud recovery copy checksum mismatch.');
const rehearsal=JSON.parse(await fsp.readFile('tmp/planning-baseline/p031-migration-rehearsal.json','utf8'));
if(!rehearsal.empty_migration || !rehearsal.prior_schema_upgrade || !rehearsal.custom_dump_restore || !rehearsal.portable_restore || !rehearsal.head_foreign_key_restored || rehearsal.production_used!==false)throw new Error('An isolated migration and restore rehearsal is required.');
const migration=await fsp.readFile(new URL('../server/migrations/032-work-accounting.sql',import.meta.url),'utf8');
if (!rehearsal.forecast_versions_preserved || !rehearsal.stale_reservations_preserved || !rehearsal.triggers_reenabled || rehearsal.migration_sha256!==crypto.createHash('sha256').update(migration).digest('hex')) throw new Error('This exact accounting migration must pass restore and version preservation rehearsal.');
const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
try{
  await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await client.query("SET LOCAL lock_timeout='10s'");await client.query("SET LOCAL statement_timeout='60s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('marina-schema-deploy'))");
  const counts=async()=>{
    const result:Record<string,number>={};
    for(const table of ['tasks','goals','resources','events','event_task_links','work_sessions','chat_messages','planning_plans','planning_plan_revisions'])result[table]=Number((await client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
    return result;
  };
  const before=await counts();await client.query(migration);const after=await counts();
  if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Legacy row counts changed during the migration.');
  await client.query('SELECT id,work_version,worklog_version,remaining_forecast_minutes,forecast_revision FROM tasks LIMIT 0');
  await client.query('SELECT id,work_version FROM event_task_links LIMIT 0');
  await client.query('COMMIT');
  const result={checked_at:new Date().toISOString(),migration:'M-032-work-accounting',backup_sha256:receipt.sha256,local_and_private_cloud_reverified:true,legacy_counts_preserved:before,seeded:false};
  await fsp.writeFile('backups/work-accounting-migration-receipt.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{await client.end();}
