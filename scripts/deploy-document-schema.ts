/** Apply only M-030 after verifying the matching current database recovery copy. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import pg from 'pg';
import { get } from '@vercel/blob';

const receiptFile = process.argv[2];
if (process.env.CONFIRM_DOCUMENT_SCHEMA_APPLY !== '1' || !receiptFile) throw new Error('Select the production environment and pass its current verified database backup receipt.');
const receipt = JSON.parse(await fsp.readFile(receiptFile, 'utf8'));
const source = new URL(process.env.DATABASE_URL!);
const age = Date.now() - Date.parse(receipt.created_at);
if (!Number.isFinite(age) || age < -60000 || age > 86400000) throw new Error('A current backup is required.');
if (receipt.database_host_sha256 !== crypto.createHash('sha256').update(source.hostname).digest('hex')) throw new Error('Backup does not belong to this database host.');
const hash = crypto.createHash('sha256'); for await (const bytes of fs.createReadStream(receipt.file)) hash.update(bytes);
if (hash.digest('hex') !== receipt.sha256) throw new Error('Local backup checksum mismatch');
const cloud = await get(receipt.cloud_path, { access:'private', useCache:false });
if (!cloud || cloud.statusCode !== 200) throw new Error('Private cloud recovery copy is unavailable');
const cloudHash = crypto.createHash('sha256'); for await (const bytes of Readable.fromWeb(cloud.stream as never)) cloudHash.update(bytes);
if (cloudHash.digest('hex') !== receipt.sha256) throw new Error('Cloud backup checksum mismatch');
const client = new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
try {
  await client.connect(); await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='10s'"); await client.query("SET LOCAL statement_timeout='60s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('marina-schema-deploy'))");
  if ((await client.query('SELECT current_database() AS name')).rows[0].name !== receipt.database) throw new Error('Backup database does not match');
  await client.query(await fsp.readFile(new URL('../server/migrations/030-structured-document-pages.sql', import.meta.url),'utf8'));
  await client.query('COMMIT');
  console.log(JSON.stringify({ok:true,migration:'M-030-structured-document-pages',backup_sha256:receipt.sha256,existing_data_preserved:true}));
} catch { await client.query('ROLLBACK').catch(()=>{}); throw new Error('Document schema deployment failed; transaction rolled back.'); }
finally { await client.end(); }
