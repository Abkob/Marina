import { Router } from 'express';
import { z } from 'zod';
import { clearSessionCookie, isAuthConfigured, isAuthenticatedRequest, passwordMatches, setSessionCookie } from '../utils/auth.js';
import { isAuthenticationRequired } from '../runtime.js';
import { rateLimit } from '../utils/rateLimit.js';

const router = Router();

router.get('/status', (req, res) => {
  const required = isAuthenticationRequired();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    required,
    configured: isAuthConfigured(),
    authenticated: !required || isAuthenticatedRequest(req),
  });
});

router.post('/login', rateLimit(10, 15 * 60_000, 'auth-login'), (req, res) => {
  if (!isAuthenticationRequired()) return res.json({ ok: true });
  if (!isAuthConfigured()) return res.status(503).json({ error: 'Authentication is not configured' });
  const parsed = z.object({ password: z.string().min(1).max(512) }).safeParse(req.body);
  if (!parsed.success || !passwordMatches(parsed.data.password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  setSessionCookie(res);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});

router.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});

export { router as authRouter };
