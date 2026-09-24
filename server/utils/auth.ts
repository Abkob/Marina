import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { isAuthenticationRequired } from '../runtime.js';
import { LEGACY_BRAND, legacyAuthenticationSecret } from './brandCompatibility.js';

const COOKIE_NAME = 'marina_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function configuredPassword(): string {
  return process.env.MARINA_ACCESS_PASSWORD ?? legacyAuthenticationSecret('ACCESS_PASSWORD') ?? '';
}

function configuredSecret(): string {
  return process.env.MARINA_SESSION_SECRET ?? legacyAuthenticationSecret('SESSION_SECRET') ?? '';
}

export function isAuthConfigured(): boolean {
  if (!isAuthenticationRequired()) return true;
  return configuredPassword().length >= 12 && configuredSecret().length >= 32;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signature(payload: string): string {
  return crypto.createHmac('sha256', configuredSecret()).update(payload).digest('base64url');
}

export function createSessionToken(now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ issued_at: now }), 'utf8').toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function verifySessionToken(token: string, now = Date.now()): boolean {
  if (!isAuthConfigured()) return false;
  const [payload, suppliedSignature, extra] = token.split('.');
  if (!payload || !suppliedSignature || extra || !safeEqual(signature(payload), suppliedSignature)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { issued_at?: unknown };
    if (typeof decoded.issued_at !== 'number') return false;
    const age = now - decoded.issued_at;
    return age >= 0 && age <= SESSION_TTL_SECONDS * 1000;
  } catch {
    return false;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    try { cookies[key] = decodeURIComponent(value); } catch { /* ignore malformed cookie */ }
  }
  return cookies;
}

export function isAuthenticatedRequest(req: Request): boolean {
  if (!isAuthenticationRequired()) return true;
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME] ?? cookies[`${LEGACY_BRAND}_session`];
  return Boolean(token && verifySessionToken(token));
}

export function isAuthorizedCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? '';
  if (secret.length < 16) return false;
  const authorization = req.headers.authorization ?? '';
  return safeEqual(authorization, `Bearer ${secret}`);
}

export function passwordMatches(password: string): boolean {
  return isAuthConfigured() && safeEqual(password, configuredPassword());
}

export function setSessionCookie(res: Response): void {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  res.cookie(COOKIE_NAME, createSessionToken(), {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' || process.env.VERCEL === '1', path: '/' });
  res.clearCookie(`${LEGACY_BRAND}_session`, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' || process.env.VERCEL === '1', path: '/' });
}

export function requireApiAuth(req: Request, res: Response, next: NextFunction) {
  if (req.path === '/cron/maintenance' && isAuthorizedCronRequest(req)) return next();
  if (!isAuthenticationRequired()) return next();
  if (!isAuthConfigured()) {
    return res.status(503).json({ error: 'Authentication is not configured. Set MARINA_ACCESS_PASSWORD and MARINA_SESSION_SECRET.' });
  }
  if (!isAuthenticatedRequest(req)) return res.status(401).json({ error: 'Authentication required' });
  next();
}
