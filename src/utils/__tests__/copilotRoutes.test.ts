import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiRouter } from '../../../server/routes/ai.js';
import { query } from '../../../server/db.js';
import { runCopilotConversation } from '../../../server/services/copilotConversation.js';

vi.mock('../../../server/db.js', () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../server/services/copilotConversation.js', () => ({ runCopilotConversation: vi.fn() }));
vi.mock('../../../server/services/agentLedger.js', () => ({ startAgentRun: vi.fn(async () => 'run-id'), appendAgentEvent: vi.fn(), setAgentIntent: vi.fn(), finishAgentRun: vi.fn(async () => {}) }));
const result = { reply: 'Please clarify which deadlines.', actions: [], document_citations: [], conversation: { mode: 'model_led' as const, needs_clarification: true, tool_calls: [], proposal_review: 'not_needed' as const, context_usage: { raw_chars: 0, sent_chars: 0, format: 'json_tables_v1' as const } } };

// Invoke the actual Express handler without starting a network listener.
async function request(path: string, body: unknown) {
  const route = (aiRouter as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: Function }> } }> }).stack.find(layer => layer.route?.path === path)!.route!;
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  await route.stack.at(-1)!.handle({ body, params: { id: 'session-id' } }, response, vi.fn());
  return response;
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
  vi.mocked(runCopilotConversation).mockReset();
  vi.mocked(runCopilotConversation).mockResolvedValue(result);
});

describe('shared conversation endpoints', () => {
  it('reports timed-out session calls and does not advertise a disabled fallback', async () => {
    vi.mocked(query).mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT id, model FROM chat_sessions') ? [{ id: 'session-id', model: 'moonshotai/kimi-k3' }] : [], rowCount: 1 }) as never);
    vi.mocked(runCopilotConversation).mockImplementationOnce(async options => {
      options.onTrace?.({ model: 'moonshotai/kimi-k3', provider: 'nvidia-cloud', duration_ms: 32000, prompt_chars: 2, fallback_used: false, outcome: 'error', error_code: 'NVIDIA_ENDPOINT_TIMEOUT', first_response_ms: 32000 });
      throw new Error('Provider timed out');
    });
    const response = await request('/sessions/:id/chat', { message: 'hi' });
    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Provider timed out', runtime: expect.objectContaining({ fallback_model: null, local_fallback_model: null, model_calls: [expect.objectContaining({ outcome: 'error', first_response_ms: 32000 })] }) }));
    expect(vi.mocked(query).mock.calls.some(([sql]) => sql.includes('INSERT INTO chat_messages'))).toBe(false);
  });
  it('rejects invalid model-role selections before reading the database', async () => {
    const response = await request('/chat', { messages: [{ role: 'user', content: 'Read my paper' }], evidence_models: { ocr: 'untrusted-model' } });
    expect(response.status).toHaveBeenCalledWith(400); expect(query).not.toHaveBeenCalled(); expect(runCopilotConversation).not.toHaveBeenCalled();
  });
  it('returns selected specialist roles and source links independently of model prose', async () => {
    const citation = { entity_type: 'resource' as const, entity_id: 'r', title: 'Paper', source_url: 'https://drive.google.com/file/d/file/view', page_start: 3, page_end: 3, matched_via: ['page inspected'], excerpt: 'Original source text', excerpt_kind: 'ocr' as const, source_tool: 'inspect_document_page' };
    vi.mocked(runCopilotConversation).mockResolvedValue({ ...result, document_citations: [citation] });
    const response = await request('/chat', { messages: [{ role: 'user', content: 'Read my paper' }], evidence_models: { ocr: 'off' } });
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ evidence_models: expect.objectContaining({ ocr: 'off' }), citations: [citation] }));
  });
  it('sends formerly intercepted due-date wording to the model without applying task writes', async () => {
    const messages = [{ role: 'user', content: 'move all tasks due tomorrow to Friday' }];
    const response = await request('/chat', { messages });
    expect(runCopilotConversation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runCopilotConversation).mock.calls[0][0].turns).toEqual(messages);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ reply: result.reply, actions: [] }));
    expect(vi.mocked(query).mock.calls.every(([sql]) => sql.trimStart().startsWith('SELECT'))).toBe(true);
  });
  it('saves source excerpts with the assistant message so cards survive reopening the chat', async () => {
    const citation = { entity_type: 'resource' as const, entity_id: 'r', title: 'Paper', source_url: 'https://drive.google.com/file/d/file/view', page_start: 94, page_end: 94, matched_via: ['text read'], excerpt: 'Saved evidence.', excerpt_kind: 'text' as const, source_tool: 'read_document' };
    vi.mocked(query).mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT id, model FROM chat_sessions') ? [{ id: 'session-id', model: null }] : [], rowCount: 1 }) as never);
    vi.mocked(runCopilotConversation).mockResolvedValue({ ...result, document_citations: [citation] });
    const response = await request('/sessions/:id/chat', { message: 'Explain page 94' });
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ citations: [citation] }));
    const save = vi.mocked(query).mock.calls.find(([sql]) => sql.includes('INSERT INTO chat_messages'));
    expect(save).toBeDefined();
    expect(JSON.parse(String(save![1]![6])).citations).toEqual([citation]);
  });

  it('gives session replies both user and assistant history plus the exact correction', async () => {
    vi.mocked(query).mockImplementation(async (sql: string) => ({ rows:
      sql.includes('SELECT id, model FROM chat_sessions') ? [{ id: 'session-id', model: null }]
        : sql.includes('FROM chat_messages') ? [
          { role: 'user', content: 'plan all my tasks', metadata_json: null },
          { role: 'assistant', content: 'Here is a preview.', metadata_json: JSON.stringify({ plan: { from: '2026-09-28', to: '2026-10-02', blocks: [] } }) },
        ] : [], rowCount: 1,
    }) as never);
    const message = 'no dont do that i just want the thesis';
    await request('/sessions/:id/chat', { message });
    const turns = vi.mocked(runCopilotConversation).mock.calls[0][0].turns;
    expect(turns.map(turn => turn.content)).toEqual(['plan all my tasks', 'Here is a preview.', message]);
    expect(turns[1].context).toHaveProperty('plan');
    expect(vi.mocked(query).mock.calls.some(([sql]) => /UPDATE\s+tasks|INSERT\s+INTO\s+events/i.test(sql))).toBe(false);
  });

  it('rejects malformed input before calling a model or database', async () => {
    const response = await request('/sessions/:id/chat', { message: 42 });
    expect(response.status).toHaveBeenCalledWith(400);
    expect(query).not.toHaveBeenCalled();
    expect(runCopilotConversation).not.toHaveBeenCalled();
  });

  it('reports provider failure without falling back to a canned interpretation', async () => {
    vi.mocked(runCopilotConversation).mockRejectedValueOnce(new Error('Provider unavailable'));
    const response = await request('/chat', { messages: [{ role: 'user', content: 'what is overdue' }] });
    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.json).toHaveBeenCalledWith({ error: 'Provider unavailable', evaluation_trace: expect.objectContaining({ version: 1, run_id: null, storage: 'unavailable' }) });
  });
});
