import { Router } from 'express';
import {
  buildGoogleAuthorizationUrl,
  decryptGoogleRefreshToken,
  encryptGoogleRefreshToken,
  exchangeGoogleAuthorizationCode,
  fetchGoogleAccountEmail,
  googleConfiguration,
  verifyGoogleOAuthState,
} from '../services/googleWorkspaceAuth.js';
import {
  getGoogleSyncConnectionStatus,
  getGoogleSyncPreview,
  googleSyncSchemaReady,
  runGoogleWorkspaceSync,
} from '../services/googleWorkspaceSync.js';
import { query } from '../db.js';

const CONNECTION_ID = 'primary';
const router = Router();
const oauthRouter = Router();

function appUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

function callbackRedirect(returnTo: string, result: 'connected' | 'error', message?: string): string {
  const url = new URL(returnTo, appUrl());
  url.searchParams.set('google', result);
  if (message) url.searchParams.set('google_message', message.slice(0, 300));
  return url.toString();
}

// Public only because Google's cross-site redirect may not carry Marina's
// SameSite=Strict session cookie. A short-lived HMAC state created by the
// authenticated /connect endpoint protects this callback.
oauthRouter.get('/callback', async (req, res) => {
  let returnTo = '/?google=error';
  try {
    if (typeof req.query.state !== 'string') throw new Error('Missing Google authorization state');
    const state = verifyGoogleOAuthState(req.query.state);
    returnTo = state.return_to;
    if (typeof req.query.error === 'string') throw new Error(`Google authorization was not completed: ${req.query.error}`);
    if (typeof req.query.code !== 'string') throw new Error('Google did not return an authorization code');
    if (!(await googleSyncSchemaReady())) throw new Error('Google sync tables have not been enabled yet');

    const tokens = await exchangeGoogleAuthorizationCode(req.query.code);
    const email = await fetchGoogleAccountEmail(tokens.access_token);
    const { rows: existingRows } = await query<{
      account_email: string | null;
      encrypted_refresh_token: string;
    }>('SELECT account_email,encrypted_refresh_token FROM google_sync_connections WHERE id=$1', [CONNECTION_ID]);
    const existing = existingRows[0];
    if (existing?.account_email && email && existing.account_email.toLowerCase() !== email.toLowerCase()) {
      throw new Error(`Marina is already linked to ${existing.account_email}. Disconnect it before connecting another Google account.`);
    }
    const encrypted = tokens.refresh_token
      ? encryptGoogleRefreshToken(tokens.refresh_token)
      : existing?.encrypted_refresh_token;
    if (!encrypted) throw new Error('Google did not return long-term access. Try Connect Google again and approve access.');
    const now = new Date().toISOString();
    await query(
      `INSERT INTO google_sync_connections
        (id,account_email,encrypted_refresh_token,calendar_name,initial_sync_complete,auto_sync_enabled,created_at,updated_at)
       VALUES ($1,$2,$3,'Marina Schedule',false,true,$4,$4)
       ON CONFLICT (id) DO UPDATE SET account_email=EXCLUDED.account_email,
         encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,last_error=NULL,updated_at=EXCLUDED.updated_at`,
      [CONNECTION_ID, email, encrypted, now],
    );
    res.redirect(303, callbackRedirect(returnTo, 'connected'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Google connection failed';
    res.redirect(303, callbackRedirect(returnTo, 'error', message));
  }
});

router.get('/status', async (_req, res) => {
  const configuration = googleConfiguration();
  const schemaReady = await googleSyncSchemaReady();
  const connection = schemaReady ? await getGoogleSyncConnectionStatus() : { connected: false as const };
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    configured: configuration.configured,
    missing_configuration: configuration.missing,
    schema_ready: schemaReady,
    ...connection,
  });
});

router.post('/connect', async (req, res) => {
  if (!(await googleSyncSchemaReady())) {
    return res.status(503).json({ error: 'Google sync tables are not enabled yet' });
  }
  res.json({ authorization_url: buildGoogleAuthorizationUrl(req.body?.return_to) });
});

router.get('/preview', async (_req, res) => {
  if (!(await googleSyncSchemaReady())) {
    return res.status(503).json({ error: 'Google sync tables are not enabled yet' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(await getGoogleSyncPreview());
});

router.post('/sync', async (req, res) => {
  if (!(await googleSyncSchemaReady())) {
    return res.status(503).json({ error: 'Google sync tables are not enabled yet' });
  }
  const stats = await runGoogleWorkspaceSync({ confirmInitial: req.body?.confirm_initial === true });
  res.json({ ok: true, stats, timestamp: new Date().toISOString() });
});

router.patch('/settings', async (req, res) => {
  if (typeof req.body?.auto_sync_enabled !== 'boolean') {
    return res.status(400).json({ error: 'auto_sync_enabled must be a boolean' });
  }
  await query('UPDATE google_sync_connections SET auto_sync_enabled=$1,updated_at=$2 WHERE id=$3',
    [req.body.auto_sync_enabled, new Date().toISOString(), CONNECTION_ID]);
  res.json({ ok: true });
});

router.delete('/connection', async (_req, res) => {
  const { rows } = await query<{ encrypted_refresh_token: string }>(
    'SELECT encrypted_refresh_token FROM google_sync_connections WHERE id=$1', [CONNECTION_ID],
  );
  const token = rows[0]?.encrypted_refresh_token;
  if (token) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decryptGoogleRefreshToken(token))}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch {
      // Local disconnection must still work if Google is temporarily offline.
    }
  }
  await query('DELETE FROM google_sync_connections WHERE id=$1', [CONNECTION_ID]);
  res.json({ ok: true, google_data_kept: true });
});

export { router as googleWorkspaceRouter, oauthRouter as googleWorkspaceOauthRouter };

