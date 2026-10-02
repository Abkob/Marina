import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fetchMock = vi.fn();
import { KIMI_MODEL, MUSE_MODEL, nvidiaKeyForModel, prepareNvidiaMessages } from '../../../server/config/nvidiaModels.js';
import { evidenceModelsSchema } from '../../../server/services/copilotModelRoles.js';
beforeEach(() => { vi.resetModules(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); vi.stubEnv('VERCEL', '1'); vi.stubEnv('NVIDIA_API_KEY', 'general-test'); vi.stubEnv('NVIDIA_KIMI_API_KEY', 'kimi-test'); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function stream(finish = 'stop', content = '{"reply":"20"}') {
  const events = [
    { choices: [{ index: 0, delta: { reasoning_content: 'ephemeral-private-state' } }] },
    { choices: [{ index: 0, delta: { content }, finish_reason: finish }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}
describe('NVIDIA model contracts', () => {
  it('isolates the dedicated Kimi key and falls back only when it is absent', () => {
    expect(nvidiaKeyForModel(KIMI_MODEL)).toBe('kimi-test');
    expect(nvidiaKeyForModel(MUSE_MODEL)).toBe('general-test');
    vi.stubEnv('NVIDIA_KIMI_API_KEY', ''); expect(nvidiaKeyForModel(KIMI_MODEL)).toBe('general-test');
    vi.stubEnv('NVIDIA_API_KEY', ''); expect(nvidiaKeyForModel(MUSE_MODEL)).toBe('');
  });
  it('uses Kimi sampling and returns private state only to the continuation callback', async () => {
    fetchMock.mockResolvedValue(stream());
    const { chat } = await import('../../../server/ollama.js');
    const onAssistantMessage = vi.fn(), onTrace = vi.fn();
    const result = await chat([{ role: 'user', content: 'subtract' }], { model: KIMI_MODEL, allowFallback: false, onAssistantMessage, onTrace });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer kimi-test');
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request).toMatchObject({ model: KIMI_MODEL, temperature: 1, reasoning_effort: 'low' });
    expect(request).not.toHaveProperty('top_p');
    expect(request).not.toHaveProperty('chat_template_kwargs');
    expect(onAssistantMessage).toHaveBeenCalledWith({ role: 'assistant', content: result, reasoning_content: 'ephemeral-private-state' });
    expect(result + JSON.stringify(onTrace.mock.calls)).not.toContain('ephemeral-private-state');
  });
  it('keeps Muse out of chat until it passes the tool-loop contract', async () => {
    const { resolveChatModel } = await import('../../../server/ollama.js');
    expect(() => resolveChatModel(MUSE_MODEL)).toThrow('Unsupported chat model');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects a truncated response instead of accepting a partial answer', async () => {
    fetchMock.mockResolvedValue(stream('length'));
    const { chat } = await import('../../../server/ollama.js'); const callback = vi.fn();
    await expect(chat([{ role: 'user', content: 'q' }], { model: KIMI_MODEL, allowFallback: false, onAssistantMessage: callback })).rejects.toThrow('response limit');
    expect(callback).not.toHaveBeenCalled();
  });
  it('marks an empty reasoning-only stream as a retryable provider failure, never an answer', async () => {
    fetchMock.mockResolvedValue(stream('stop', ''));
    const { chat } = await import('../../../server/ollama.js'); const callback = vi.fn();
    await expect(chat([{ role: 'user', content: 'q' }], { model: KIMI_MODEL, allowFallback: false, onAssistantMessage: callback })).rejects.toMatchObject({ status: 502, code: 'NVIDIA_EMPTY_RESPONSE' });
    expect(callback).not.toHaveBeenCalled();
  });
  it('supports a dedicated Kimi key without a general NVIDIA key', async () => {
    vi.stubEnv('NVIDIA_API_KEY', ''); fetchMock.mockResolvedValue(stream());
    const { chat, validateChatModels } = await import('../../../server/ollama.js');
    expect((await validateChatModels()).available.find(row => row.model === KIMI_MODEL)?.status).toBe('cloud');
    expect(await chat([{ role: 'user', content: 'q' }], { model: KIMI_MODEL, allowFallback: false })).toContain('20');
  });
  it('aborts a stalled body at the deadline without returning partial text or provider state', async () => {
    vi.stubEnv('MARINA_NVIDIA_TIMEOUT_MS', '1000');
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url, init) => {
      requestSignal = init.signal;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial","reasoning_content":"private"}}]}\n\n'));
        init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const { chat } = await import('../../../server/ollama.js'); const onAssistantMessage = vi.fn(), onTrace = vi.fn();
    await expect(chat([{ role: 'user', content: 'q' }], { model: KIMI_MODEL, allowFallback: false, onAssistantMessage, onTrace })).rejects.toMatchObject({ code: 'NVIDIA_TIMEOUT', retryable: false });
    expect(requestSignal?.aborted).toBe(true); expect(fetchMock).toHaveBeenCalledOnce();
    expect(onAssistantMessage).not.toHaveBeenCalled(); expect(onTrace).not.toHaveBeenCalled();
  });
  it('sends preserved Kimi continuation unchanged in the next request', async () => {
    fetchMock.mockImplementation(async () => stream());
    const { chat } = await import('../../../server/ollama.js');
    let assistant;
    await chat([{ role: 'user', content: 'first' }], { model: KIMI_MODEL, allowFallback: false, onAssistantMessage: message => { assistant = message; } });
    await chat([{ role: 'user', content: 'first' }, assistant, { role: 'user', content: 'tool result' }], { model: KIMI_MODEL, allowFallback: false });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages[1]).toEqual(assistant);
    expect(assistant.reasoning_content).toBe('ephemeral-private-state');
  });
  it('converts stored assistant history without inventing provider state, retaining current continuation', () => {
    const current = { role: 'assistant', content: '{"tool_calls":[]}', reasoning_content: 'state' };
    const messages = [{ role: 'system', content: 'policy' }, { role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'new question' }, current, { role: 'user', content: 'observation' }];
    const prepared = prepareNvidiaMessages(KIMI_MODEL, messages);
    expect(prepared[0]).toEqual(messages[0]); expect(prepared[1].content).toContain('old answer');
    expect(prepared.slice(2)).toEqual(messages.slice(3)); expect(prepared[3]).toBe(current);
    expect(prepareNvidiaMessages(MUSE_MODEL, messages)).toEqual(messages);
  });
  it.each([KIMI_MODEL, MUSE_MODEL])('allows %s in document roles but not as an embedding or reranker', model => {
    for (const role of ['ocr', 'vision', 'structure']) expect(evidenceModelsSchema.safeParse({ [role]: model }).success).toBe(true);
    expect(evidenceModelsSchema.safeParse({ reranker: model }).success).toBe(false);
    expect(evidenceModelsSchema.safeParse({ embeddings: model }).success).toBe(false);
  });
});
