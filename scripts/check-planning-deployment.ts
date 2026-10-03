import pg from 'pg';
import { legacyAuthenticationSecret } from '../server/utils/brandCompatibility.js';
const key=process.env.MARINA_SESSION_SECRET ?? legacyAuthenticationSecret('SESSION_SECRET');
if (!process.env.DATABASE_URL || !key || key.length<32) throw new Error('Planning deployment is not ready: database and workspace session signing must be configured.');
const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
try {
  await client.connect();await client.query('BEGIN READ ONLY');
  const {rows}=await client.query("SELECT name FROM schema_migrations WHERE name='M-031-persistent-plans'");
  if(!rows.length) throw new Error('Planning deployment is not ready: verify a current backup, rehearse restore, then apply M-031 before deploying.');
  await client.query('SELECT id,head_version,state FROM planning_plans LIMIT 0');
  await client.query('SELECT plan_id,version,previous_version,content,redacted_at FROM planning_plan_revisions LIMIT 0');
  await client.query('SELECT id,base_version,state,result,scope,facts_hash,request_key FROM planning_scenarios LIMIT 0');
  console.log('PASS Planning deployment prerequisites: schema and signing configuration are present.');
} catch(error) {
  console.error(error instanceof Error && error.message.startsWith('Planning deployment') ? error.message : 'Planning deployment is not ready: the read-only database check failed.');process.exitCode=1;
} finally {await client.query('ROLLBACK').catch(()=>{});await client.end();}
