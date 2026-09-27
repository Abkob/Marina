import crypto from 'crypto';
import { legacyAuthenticationSecret } from '../utils/brandCompatibility.js';

export const GOOGLE_OAUTH_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/calendar.app.created',
] as const;

interface OAuthStatePayload {
  exp: number;
  nonce: string;
  return_to: string;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

function requiredSecret(name: 'token' | 'state'): string {
  const value = name === 'token'
    ? process.env.GOOGLE_TOKEN_ENCRYPTION_KEY
    : process.env.GOOGLE_OAUTH_STATE_SECRET ?? process.env.MARINA_SESSION_SECRET ?? legacyAuthenticationSecret('SESSION_SECRET');
  if (!value || value.length < 32) {
    throw new Error(name === 'token'
      ? 'GOOGLE_TOKEN_ENCRYPTION_KEY must be at least 32 characters'
      : 'GOOGLE_OAUTH_STATE_SECRET (or MARINA_SESSION_SECRET) must be at least 32 characters');
  }
  return value;
}

function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/?google=connected';
  return value;
}

function signState(encodedPayload: string): string {
  return crypto.createHmac('sha256', requiredSecret('state')).update(encodedPayload).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createGoogleOAuthState(returnTo = '/?google=connected', now = Date.now()): string {
  const payload: OAuthStatePayload = {
    exp: now + 10 * 60_000,
    nonce: crypto.randomBytes(18).toString('base64url'),
    return_to: safeReturnTo(returnTo),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signState(encoded)}`;
}

export function verifyGoogleOAuthState(state: string, now = Date.now()): OAuthStatePayload {
  const [encoded, suppliedSignature, extra] = state.split('.');
  if (!encoded || !suppliedSignature || extra || !safeEqual(signState(encoded), suppliedSignature)) {
    throw new Error('Invalid Google authorization state');
  }
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OAuthStatePayload;
  } catch {
    throw new Error('Invalid Google authorization state');
  }
  if (!Number.isFinite(payload.exp) || payload.exp < now || typeof payload.nonce !== 'string') {
    throw new Error('Google authorization state expired');
  }
  payload.return_to = safeReturnTo(payload.return_to);
  return payload;
}

export function googleRedirectUri(): string {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const appUrl = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  return `${appUrl}/api/google/oauth/callback`;
}

export function googleConfiguration() {
  const missing: string[] = [];
  if (!process.env.GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
  if (!process.env.GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
  if (!process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || process.env.GOOGLE_TOKEN_ENCRYPTION_KEY.length < 32) {
    missing.push('GOOGLE_TOKEN_ENCRYPTION_KEY');
  }
  const stateSecret = process.env.GOOGLE_OAUTH_STATE_SECRET ?? process.env.MARINA_SESSION_SECRET ?? legacyAuthenticationSecret('SESSION_SECRET');
  if (!stateSecret || stateSecret.length < 32) missing.push('GOOGLE_OAUTH_STATE_SECRET');
  if (process.env.VERCEL === '1' && !process.env.APP_URL && !process.env.GOOGLE_REDIRECT_URI) {
    missing.push('APP_URL');
  }
  return { configured: missing.length === 0, missing, redirect_uri: googleRedirectUri() };
}

export function buildGoogleAuthorizationUrl(returnTo?: string): string {
  const config = googleConfiguration();
  if (!config.configured) throw new Error(`Google sync is not configured: ${config.missing.join(', ')}`);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: config.redirect_uri,
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state: createGoogleOAuthState(returnTo),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function parseTokenResponse(response: Response): Promise<GoogleTokenResponse> {
  const body = await response.json().catch(() => ({})) as GoogleTokenResponse & { error?: string; error_description?: string };
  if (!response.ok || !body.access_token) {
    throw Object.assign(new Error(body.error_description ?? body.error ?? 'Google token request failed'), { status: response.status });
  }
  return body;
}

export async function exchangeGoogleAuthorizationCode(code: string): Promise<GoogleTokenResponse> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: googleRedirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  return parseTokenResponse(response);
}

export async function refreshGoogleAccessToken(encryptedRefreshToken: string): Promise<string> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: decryptGoogleRefreshToken(encryptedRefreshToken),
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
    }),
  });
  return (await parseTokenResponse(response)).access_token;
}

export function encryptGoogleRefreshToken(refreshToken: string): string {
  if (!refreshToken) throw new Error('Google did not return a refresh token');
  const key = crypto.createHash('sha256').update(requiredSecret('token')).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(refreshToken, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptGoogleRefreshToken(value: string): string {
  const [version, ivRaw, tagRaw, encryptedRaw, extra] = value.split('.');
  if (version !== 'v1' || !ivRaw || !tagRaw || !encryptedRaw || extra) throw new Error('Invalid encrypted Google token');
  const key = crypto.createHash('sha256').update(requiredSecret('token')).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export async function fetchGoogleAccountEmail(accessToken: string): Promise<string | null> {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const body = await response.json() as { email?: string };
  return body.email ?? null;
}
