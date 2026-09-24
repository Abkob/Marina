import { afterEach, expect, it, vi } from 'vitest';
import { LEGACY_BRAND, legacyBackupName, marinaBackupName } from '../../../server/utils/brandCompatibility';
import { clearSessionCookie, createSessionToken, isAuthenticatedRequest, isAuthConfigured, passwordMatches } from '../../../server/utils/auth';
import type { Request, Response } from 'express';

afterEach(() => vi.unstubAllEnvs());
it('signs out both current and pre-rename sessions', () => {
  const clearCookie = vi.fn();
  clearSessionCookie({ clearCookie } as unknown as Response);
  expect(clearCookie).toHaveBeenCalledWith('marina_session', expect.objectContaining({ httpOnly: true, path: '/' }));
  expect(clearCookie).toHaveBeenCalledWith(`${LEGACY_BRAND}_session`, expect.objectContaining({ httpOnly: true, path: '/' }));
});
it('uses protected existing authentication secrets and accepts an existing signed session', () => {
  vi.stubEnv('MARINA_AUTH_REQUIRED', 'true');
  vi.stubEnv('MARINA_ACCESS_PASSWORD', undefined);
  vi.stubEnv('MARINA_SESSION_SECRET', undefined);
  vi.stubEnv('AMINA_ACCESS_PASSWORD', 'existing-personal-password');
  vi.stubEnv('AMINA_SESSION_SECRET', 'existing-session-secret-with-more-than-32-characters');
  expect(isAuthConfigured()).toBe(true);
  expect(passwordMatches('existing-personal-password')).toBe(true);
  const token = createSessionToken();
  expect(isAuthenticatedRequest({ headers: { cookie: `${LEGACY_BRAND}_session=${token}` } } as Request)).toBe(true);
  expect(isAuthenticatedRequest({ headers: { cookie: `marina_session=${token}` } } as Request)).toBe(true);
  expect(isAuthenticatedRequest({ headers: { cookie: 'marina_session=invalid' } } as Request)).toBe(false);
});
it('maps old backup filenames to Marina labels and back without altering the backup identity', () => {
  const oldName = 'amina-complete-2026-09-24-1234.amina-backup.zip';
  const current = marinaBackupName(oldName);
  expect(current).toBe('marina-complete-2026-09-24-1234.marina-backup.zip');
  expect(legacyBackupName(current)).toBe(oldName);
  expect(marinaBackupName(current)).toBe(current);
});
