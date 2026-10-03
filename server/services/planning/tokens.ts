import crypto from 'node:crypto';
import { z } from 'zod';
import { legacyAuthenticationSecret } from '../../utils/brandCompatibility.js';
import { PlanningError } from './errors.js';
const localSecret = crypto.randomBytes(32).toString('hex');
function secret() {
  const configured = process.env.MARINA_SESSION_SECRET ?? legacyAuthenticationSecret('SESSION_SECRET');
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL === '1') throw new PlanningError('provider_unavailable', 'Planning token signing is not configured.', 503, false);
  return localSecret;
}
const claimsSchema = z.object({
  version: z.literal(1), purpose: z.enum(['snapshot', 'cursor']), scope: z.string().regex(/^[a-f0-9]{64}$/),
  facts: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().nonnegative(),
  expires: z.number().int().positive(), after: z.string().max(200).optional(),
}).strict();
export type PlanningClaims = z.infer<typeof claimsSchema>;
export const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sign = (payload: string) => crypto.createHmac('sha256', secret()).update(`marina-planning-v1:${payload}`).digest('base64url');
export function issuePlanningToken(claims: Omit<PlanningClaims, 'version' | 'expires'>, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify(claimsSchema.parse({ ...claims, version: 1, expires: now + 15 * 60_000 }))).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
export function verifyPlanningToken(token: string, purpose: PlanningClaims['purpose'], scope: string, now = Date.now()): PlanningClaims {
  try {
    if (typeof token !== 'string' || token.length > 2000) throw new Error('size');
    const [payload, supplied, extra] = token.split('.');
    if (!payload || !supplied || extra) throw new Error('shape');
    const expected = Buffer.from(sign(payload)); const actual = Buffer.from(supplied);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw new Error('signature');
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
    if (claims.purpose !== purpose || claims.scope !== scope || claims.expires <= now || claims.expires > now + 15 * 60_000) throw new Error('scope or expiry');
    return claims;
  } catch (error) {
    if (error instanceof PlanningError && error.status === 503) throw error;
    throw new PlanningError('snapshot_stale', 'This planning context expired or changed. Refresh it and review your edit again.', 409, true);
  }
}
