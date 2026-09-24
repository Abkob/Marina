import { describe, expect, it } from 'vitest';
import { resolveLocalFallbackModel } from '../../../server/config/providers.js';

describe('local chat fallback configuration', () => {
  it('disables local fallback on Vercel', () => {
    expect(resolveLocalFallbackModel({
      VERCEL: '1',
      MARINA_LOCAL_FALLBACK_MODEL: 'qwen3:8b',
    })).toBe('');
  });

  it('keeps the local default outside Vercel', () => {
    expect(resolveLocalFallbackModel({})).toBe('qwen3:8b');
  });

  it('allows local development to disable or replace the fallback', () => {
    expect(resolveLocalFallbackModel({ MARINA_LOCAL_FALLBACK_MODEL: '' })).toBe('');
    expect(resolveLocalFallbackModel({ MARINA_LOCAL_FALLBACK_MODEL: 'llama3.2:latest' })).toBe('llama3.2:latest');
  });
});
