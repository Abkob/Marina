import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ create: vi.fn(), clients: [] as Array<{ apiKey: string }> }));
vi.mock('openai', () => ({ default: class {
  chat = { completions: { create: mock.create } };
  constructor(options: { apiKey: string }) { mock.clients.push(options); }
} }));
import { KIMI_MODEL, MUSE_MODEL, nvidiaKeyForModel, prepareNvidiaMessages } from '../../../server/config/nvidiaModels.js';
import { evidenceModelsSchema } from '../../../server/services/copilotModelRoles.js';
beforeEach(() => { vi.resetModules(); mock.create.mockReset(); mock.clients.length = 0; vi.stubEnv('NVIDIA_API_KEY', 'general-test'); vi.stubEnv('NVIDIA_KIMI_API_KEY', 'kimi-test'); });
afterEach(() => vi.unstubAllEnvs());
function stream(finish = 'stop') { return (async function* () {
  yield { choices: [{ delta: { reasoning_content: 'ephemeral-private-state' } }] };
  yield { choices: [{ delta: { content: '{"reply":"20"}' }, finish_reason: finish }] };
  yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } };
})(); }
describe('NVIDIA model contracts', () => {
  it('isolates the dedicated Kimi key and falls back only when it is absent', () => {
    expect(nvidiaKeyForModel(KIMI_MODEL)).toBe('kimi-test');
    expect(nvidiaKeyForModel(MUSE_MODEL)).toBe('general-test');
    vi.stubEnv('NVIDIA_KIMI_API_KEY', ''); expect(nvidiaKeyForModel(KIMI_MODEL)).toBe('general-test');
    vi.stubEnv('NVIDIA_API_KEY', ''); expect(nvidiaKeyForModel(MUSE_MODEL)).toBe('');
  });
  it('uses Kimi sampling and returns private state only to the continuation callback', async () => {
    mock.create.mockResolvedValue(stream());
    const { chat } = await import('../../../server/ollama.js');
    const onAssistantMessage = vi.fn(), onTrace = vi.fn();
    const result = await chat([{ role: 'user', content: 'subtract' }], { model: KIMI_MODEL, allowFallback: false, onAssistantMessage, onTrace });
    expect(mock.clients.at(-1)?.apiKey).toBe('kimi-test');
    expect(mock.create.mock.calls[0][0]).toMatchObject({ model: KIMI_MODEL, temperature: 1, reasoning_effort: 'low' });
    expect(mock.create.mock.calls[0][0]).not.toHaveProperty('top_p');
    expect(mock.create.mock.calls[0][0]).not.toHaveProperty('chat_template_kwargs');
    expect(onAssistantMessage).toHaveBeenCalledWith({ role: 'assistant', content: result, reasoning_content: 'ephemeral-private-state' });
    expect(result + JSON.stringify(onTrace.mock.calls)).not.toContain('ephemeral-private-state');
  });
  it('keeps Muse out of chat until it passes the tool-loop contract', async () => {
    const { resolveChatModel } = await import('../../../server/ollama.js');
    expect(() => resolveChatModel(MUSE_MODEL)).toThrow('Unsupported chat model');
    expect(mock.create).not.toHaveBeenCalled();
  });
  it('rejects a truncated response instead of accepting a partial answer', async () => {
    mock.create.mockResolvedValue(stream('length'));
    const { chat } = await import('../../../server/ollama.js'); const callback = vi.fn();
    await expect(chat([{ role: 'user', content: 'q' }], { model: KIMI_MODEL, allowFallback: false, onAssistantMessage: callback })).rejects.toThrow('response limit');
    expect(callback).not.toHaveBeenCalled();
  });
  it('supports a dedicated Kimi key without a general NVIDIA key', async () => {
    vi.stubEnv('NVIDIA_API_KEY', ''); mock.create.mockResolvedValue(stream());
    const { chat, validateChatModels } = await import('../../../server/ollama.js');
    expect((await validateChatModels()).available.find(row => row.model === KIMI_MODEL)?.status).toBe('cloud');
    expect(await chat([{ role: 'user', content: 'q' }], { model: KIMI_MODEL, allowFallback: false })).toContain('20');
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
