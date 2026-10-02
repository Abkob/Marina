import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiPost, ApiError, setMutationListener } from '../apiFetch';
afterEach(() => { vi.unstubAllGlobals(); setMutationListener(null); });
describe('failed API responses', () => {
  it('keeps server diagnostics attached without treating the failure as a saved mutation', async () => {
    const runtime = { total_ms: 32000, model_calls: [{ outcome: 'error', error_code: 'NVIDIA_ENDPOINT_TIMEOUT' }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Provider timed out', runtime }), { status: 502 })));
    const listener = vi.fn(); setMutationListener(listener);
    const error = await apiPost('/api/ai/sessions/test/chat', { message: 'hi' }).catch(error => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: 'Provider timed out', status: 502, data: { runtime } });
    expect(listener).not.toHaveBeenCalled();
  });
  it.each(['Gateway timeout', 'null'])('preserves non-object errors: %s', async text => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(text, { status: 502 })));
    await expect(apiPost('/example', {})).rejects.toMatchObject({ message: text, status: 502 });
  });
});
