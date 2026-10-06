import { describe, expect, it } from 'vitest';
import { resolveLocalFallbackModel } from '../../../server/config/providers.js';

describe('local chat fallback configuration', () => {
  it('disables local fallback on Vercel', () => {
    expect(resolveLocalFallbackModel({
      VERCEL: '1',
      MARINA_LOCAL_FALLBACK_MODEL: 'qwen3:8b',
    })).toBe('');
  });

  it('keeps local fallback disabled outside Vercel too', () => {
    expect(resolveLocalFallbackModel({})).toBe('');
  });

  it('ignores stale settings for retired local chat models', () => {
    expect(resolveLocalFallbackModel({ MARINA_LOCAL_FALLBACK_MODEL: '' })).toBe('');
    expect(resolveLocalFallbackModel({ MARINA_LOCAL_FALLBACK_MODEL: 'llama3.2:latest' })).toBe('');
  });
});
