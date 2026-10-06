import pg from 'pg';
import {embeddingProfile} from '../server/config/embeddingProfile.js';
async function check() {
const profile=embeddingProfile();
if (profile.provider==='nvidia') {
  if (!process.env.NVIDIA_EMBED_API_KEY && !process.env.NVIDIA_API_KEY) throw new Error('Embedding deployment is not ready: configure the NVIDIA connection.');
  const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000,query_timeout:15000});
  try {
    await client.connect();await client.query('BEGIN READ ONLY');
    const vector=(await client.query("SELECT format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid=to_regclass('nemotron_embeddings') AND attname='embedding_2048'")).rows[0];
    if(vector?.type!=='halfvec(2048)')throw new Error('Embedding deployment is not ready: verify a backup and apply M-034 before activating Nemotron.');
    if(!(await client.query("SELECT name FROM schema_migrations WHERE name='M-034-nemotron-embeddings'")).rows.length)throw new Error('Embedding deployment is not ready: M-034 is missing.');
  } finally {await client.query('ROLLBACK').catch(()=>{});await client.end();}
}
console.log('PASS Embedding deployment prerequisites: selected provider and isolated vector profile.');
}
try { await check(); } catch (error) {
  const message=error instanceof Error && error.message.startsWith('Embedding deployment is not ready:') ? error.message
    : 'Embedding deployment is not ready: the selected profile or read-only database check failed.';
  console.error(message);process.exitCode=1;
}
