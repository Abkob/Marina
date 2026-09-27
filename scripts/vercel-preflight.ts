import 'dotenv/config';
import { execFileSync } from 'child_process';
import fs from 'fs';

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8')) as Record<string, unknown>;
add('Vercel config exists', Boolean(config.framework === 'vite' && config.outputDirectory === 'dist'), 'Vite builds to dist');
add('Serverless entry exists', fs.existsSync('api/index.ts'), 'api/index.ts exports the Express app without starting a listener');
add('Private upload entry exists', fs.existsSync('server/routes/uploads.ts'), 'large files use direct private Blob upload');

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const unsafe = tracked.filter(file => file !== '.env.example' && /(^|\/)(\.env($|\.)|backups\/)|\.(dump|sqlite|sqlite3|db)$/i.test(file));
add('No current secrets/data tracked', unsafe.length === 0, unsafe.length ? `unsafe tracked paths: ${unsafe.join(', ')}` : 'current Git tree excludes env files and database dumps');

if (process.argv.includes('--env')) {
  const value = (name: string) => process.env[name] ?? '';
  let databaseOk = false;
  try {
    const url = new URL(value('DATABASE_URL'));
    databaseOk = ['postgres:', 'postgresql:'].includes(url.protocol) && !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch { /* invalid or absent */ }
  add('Managed PostgreSQL URL', databaseOk, 'DATABASE_URL must point to non-local PostgreSQL');
  add('Private Blob token', value('BLOB_READ_WRITE_TOKEN').length > 20, 'BLOB_READ_WRITE_TOKEN is configured');
  add('Access password', value('MARINA_ACCESS_PASSWORD').length >= 12, 'MARINA_ACCESS_PASSWORD is at least 12 characters');
  add('Session secret', value('MARINA_SESSION_SECRET').length >= 32, 'MARINA_SESSION_SECRET is at least 32 characters');
  add('Cron secret', value('CRON_SECRET').length >= 16, 'CRON_SECRET is at least 16 characters');
  add('Public app URL', /^https:\/\//i.test(value('APP_URL')), 'APP_URL uses HTTPS');

  const googleNames = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_TOKEN_ENCRYPTION_KEY', 'GOOGLE_OAUTH_STATE_SECRET'];
  const googleRequested = googleNames.some(name => Boolean(value(name)));
  if (googleRequested) {
    add('Google OAuth client', Boolean(value('GOOGLE_CLIENT_ID') && value('GOOGLE_CLIENT_SECRET')), 'Google client ID and secret are both configured');
    add('Google OAuth redirect', /^https:\/\/.+\/api\/google\/oauth\/callback$/i.test(value('GOOGLE_REDIRECT_URI')), 'GOOGLE_REDIRECT_URI is the production HTTPS callback');
    add('Google token encryption', value('GOOGLE_TOKEN_ENCRYPTION_KEY').length >= 32, 'GOOGLE_TOKEN_ENCRYPTION_KEY is at least 32 characters');
    add('Google OAuth state secret', value('GOOGLE_OAUTH_STATE_SECRET').length >= 32, 'GOOGLE_OAUTH_STATE_SECRET is at least 32 characters');
  }

  const primaryModel = value('MARINA_MAIN_MODEL');
  const cloudModelOk = primaryModel.startsWith('gemini-')
    ? Boolean(value('GEMINI_API_KEY'))
    : Boolean(value('NVIDIA_API_KEY')) && primaryModel.includes('/');
  add('Cloud AI model', cloudModelOk, 'Vercel cannot reach a laptop-only Ollama instance');
}

for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}`);
const failed = checks.filter(check => !check.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks: checks.length, failed: failed.map(check => check.name) }));
if (failed.length) process.exitCode = 1;
