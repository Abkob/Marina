import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireApiAuth } from '../../../server/utils/auth';

beforeEach(() => {
  vi.stubEnv('MARINA_AUTH_REQUIRED', 'true');
  vi.stubEnv('MARINA_ACCESS_PASSWORD', 'a-long-test-password');
  vi.stubEnv('MARINA_SESSION_SECRET', '0123456789abcdef0123456789abcdef');
  vi.stubEnv('CRON_SECRET', 'cron-secret-for-backup-testing');
});
afterEach(() => vi.unstubAllEnvs());

function authorize(path: string, authorization?: string) {
  const next = vi.fn();
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  requireApiAuth({ path, headers: { authorization } } as Request, res as unknown as Response, next);
  return { next, res };
}

it('lets the configured cron secret run the backup job', () => {
  expect(authorize('/cron/backup', 'Bearer cron-secret-for-backup-testing').next).toHaveBeenCalledOnce();
});

it('rejects missing and incorrect credentials for the backup job', () => {
  for (const token of [undefined, 'Bearer incorrect-secret']) {
    const { next, res } = authorize('/cron/backup', token);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  }
});

it('does not grant the cron secret access to normal workspace endpoints', () => {
  const { next, res } = authorize('/notes', 'Bearer cron-secret-for-backup-testing');
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(401);
});
