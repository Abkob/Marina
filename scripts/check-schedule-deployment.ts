import pg from 'pg';
if(!process.env.DATABASE_URL)throw new Error('Schedule deployment requires the configured database.');
const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000,query_timeout:15000});
try{
 await client.connect();await client.query('BEGIN READ ONLY');
 await client.query('SELECT date,timezone,saved_at,frozen,occurrences FROM schedule_day_plans LIMIT 0');
 await client.query('SELECT occurrence_id,date,revision,status,actual_start,actual_end,session_id,occurrence FROM schedule_occurrence_outcomes LIMIT 0');
 await client.query('SELECT id,request_hash,result FROM schedule_checkin_commands LIMIT 0');
 await client.query('SELECT id,schedule_occurrence_id,schedule_date,schedule_occurrence FROM work_timers LIMIT 0');
 await client.query('SELECT id,schedule_occurrence_id FROM work_sessions LIMIT 0');
 await client.query('SELECT id,subscription FROM schedule_push_subscriptions LIMIT 0');
 await client.query('SELECT id,claimed_at,sent_at FROM schedule_push_deliveries LIMIT 0');
 await client.query('SELECT id,token_hash,expires_at,revoked_at FROM schedule_shortcut_keys LIMIT 0');
 const check=await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='work_timers'::regclass AND conname='work_timers_status_check'");
 if(!check.rows[0]?.definition.includes('awaiting_end'))throw new Error('Unconfirmed ends require the M-035 timer status constraint.');
 if(Boolean(process.env.MARINA_VAPID_PUBLIC_KEY)!==Boolean(process.env.MARINA_VAPID_PRIVATE_KEY))throw new Error('Both Web Push keys must be configured together.');
 console.log('PASS Schedule deployment prerequisites: proposal history, explicit boundaries, canonical sessions and reminder tables.');
}catch{console.error('Schedule deployment is not ready. Verify a current cloud backup, rehearse its restore, and apply M-035 before deploying.');process.exitCode=1;}
finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
