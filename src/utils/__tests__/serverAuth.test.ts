import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSessionToken,
  isAuthConfigured,
  passwordMatches,
  verifySessionToken,
} from '../../../server/utils/auth.js';

const original = {
  required: process.env.MARINA_AUTH_REQUIRED,
  password: process.env.MARINA_ACCESS_PASSWORD,
  secret: process.env.MARINA_SESSION_SECRET,
};

describe('server authentication tokens', () => {
  beforeEach(() => {
    process.env.MARINA_AUTH_REQUIRED = 'true';
    process.env.MARINA_ACCESS_PASSWORD = 'a-long-personal-password';
    process.env.MARINA_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
  });

  afterEach(() => {
    if (original.required === undefined) delete process.env.MARINA_AUTH_REQUIRED;
    else process.env.MARINA_AUTH_REQUIRED = original.required;
    if (original.password === undefined) delete process.env.MARINA_ACCESS_PASSWORD;
    else process.env.MARINA_ACCESS_PASSWORD = original.password;
    if (original.secret === undefined) delete process.env.MARINA_SESSION_SECRET;
    else process.env.MARINA_SESSION_SECRET = original.secret;
  });

  it('fails closed when required secrets are too short', () => {
    process.env.MARINA_ACCESS_PASSWORD = 'short';
    expect(isAuthConfigured()).toBe(false);
    expect(passwordMatches('short')).toBe(false);
  });

  it('accepts a valid signed session and rejects tampering', () => {
    const now = Date.now();
    const token = createSessionToken(now);
    expect(verifySessionToken(token, now + 1_000)).toBe(true);
    expect(verifySessionToken(`${token.slice(0, -1)}x`, now + 1_000)).toBe(false);
  });

  it('expires sessions after seven days', () => {
    const now = Date.now();
    const token = createSessionToken(now);
    expect(verifySessionToken(token, now + (7 * 24 * 60 * 60 * 1_000) + 1)).toBe(false);
  });
});
