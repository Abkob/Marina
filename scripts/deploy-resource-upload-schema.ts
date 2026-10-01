// Apply only the additive resource migration, after verifying its recovery copy.
// DATABASE_URL and BLOB_READ_WRITE_TOKEN must come from the deployment being upgraded.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import pg from 'pg';
import { get } from '@vercel/blob';
import { verifyPortableBackup } from './lib/portableBackup.js';

if (process.env.CONFIRM_RESOURCE_SCHEMA_APPLY !== '1') throw new Error('Set CONFIRM_RESOURCE_SCHEMA_APPLY=1 only after selecting the production deployment and verifying its backup.');
if (!process.env.DATABASE_URL || !process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Deployment DATABASE_URL and BLOB_READ_WRITE_TOKEN are required.');
const archive = process.argv[2];
if (!archive) throw new Error('Pass the current verified local .marina-backup.zip recovery copy.');
const name = path.basename(archive);
if (!/^marina-complete-[a-zA-Z0-9._-]+\.marina-backup\.zip$/.test(name)) throw new Error('Invalid backup filename');
const verified = await verifyPortableBackup(archive);
const age = Date.now() - Date.parse(verified.manifest.created_at);
if (!Number.isFinite(age) || age < -60_000 || age > 24 * 60 * 60_000) throw new Error('Create a fresh backup; this archive is older than 24 hours or has an invalid date.');
const hash = crypto.createHash('sha256');
for await (const bytes of fs.createReadStream(archive)) hash.update(bytes as Buffer);
const digest = hash.digest('hex');
const receiptObject = await get(`marina/backups/verified/${name}.json`, { access: 'private', useCache: false, abortSignal: AbortSignal.timeout(30_000) });
if (!receiptObject || receiptObject.statusCode !== 200) throw new Error('Verified private cloud backup receipt is missing');
let text = '';
for await (const chunk of Readable.fromWeb(receiptObject.stream as never)) {
  text += chunk.toString(); if (text.length > 16384) throw new Error('Invalid backup receipt');
}
const receipt = JSON.parse(text);
if (receipt.filename !== name || receipt.sha256 !== digest || receipt.bytes !== verified.archive_bytes) throw new Error('Cloud receipt does not match the local recovery copy');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('marina-schema-deploy'))");
    const current = (await client.query('SELECT current_database() AS name')).rows[0];
    if (current.name !== verified.manifest.database.name) throw new Error('Backup database name does not match the target');
    for (const file of ['028-resource-upload-lifecycle.sql', '029-google-drive-resources.sql']) {
      await client.query(await fsp.readFile(new URL(`../server/migrations/${file}`, import.meta.url), 'utf8'));
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, migrations: ['M-028-resource-upload-lifecycle', 'M-029-google-drive-resources'], backup_sha256: digest, seeded: false }));
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
} finally { await pool.end(); }
