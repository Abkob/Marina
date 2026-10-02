import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NvidiaError, nvidiaResponse, readNvidiaChat } from '../../../server/services/nvidiaTransport.js';

const fetchMock = vi.fn();
const endpoint = 'https://integrate.api.nvidia.com/v1/chat/completions';
const id = '12345678-1234-1234-1234-123456789abc';
const model = 'moonshotai/kimi-k3';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const completion = { choices: [{ index: 0, message: { content: '20', reasoning_content: 'private' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } };
const event = (content: string | null, finish: string | null = null, reasoning = '') => ({ choices: [{ index: 0, delta: { content, reasoning_content: reasoning }, finish_reason: finish }] });
function sse(events: unknown[], fragment = false) {
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\n' + events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
  return new Response(new ReadableStream({ start(controller) {
    if (fragment) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const post = (signal = new AbortController().signal) => nvidiaResponse(endpoint, { model, stream: true }, 'test-key', signal, model);

describe('NVIDIA HTTP invocation', () => {
  it.each(['header', 'body'])('polls a %s request ID to completion with one POST', async source => {
    fetchMock.mockResolvedValueOnce(json(source === 'body' ? { requestId: id } : {}, 202, source === 'header' ? { 'nvcf-reqid': id } : {}))
      .mockResolvedValueOnce(json({}, 202))
      .mockResolvedValueOnce(json(completion));
    const response = await post();
    expect(await readNvidiaChat(response, new AbortController(), model)).toMatchObject({ content: '20', continuationReasoning: 'private', usage: { prompt_tokens: 3 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(call => call[1].method)).toEqual(['POST', 'GET', 'GET']);
    for (const [url, init] of fetchMock.mock.calls.slice(1)) {
      expect(url).toBe(`https://integrate.api.nvidia.com/v1/status/${id}`);
      expect(init).not.toHaveProperty('body'); expect(init.headers.Authorization).toBe('Bearer test-key');
      expect(init.redirect).toBe('error');
    }
  });
  it.each([{}, { requestId: 'https://attacker.example/key' }, { requestId: '../../secret' }])('rejects unusable pending IDs %# without following a supplied URL', async body => {
    fetchMock.mockResolvedValue(json(body, 202, { Location: 'https://attacker.example' }));
    await expect(post()).rejects.toMatchObject({ code: 'NVIDIA_PENDING_INVALID', retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('rejects a changed invocation ID instead of reading another job', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 202, { 'nvcf-reqid': id }))
      .mockResolvedValueOnce(json({}, 202, { 'nvcf-reqid': 'aaaaaaaa-1234-1234-1234-123456789abc' }));
    await expect(post()).rejects.toMatchObject({ code: 'NVIDIA_PENDING_INVALID' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('stops pending polling at the shared deadline without issuing another POST', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({}, 202, { 'nvcf-reqid': id })));
    await expect(post(AbortSignal.timeout(650))).rejects.toMatchObject({ code: 'NVIDIA_TIMEOUT', retryable: false });
    expect(fetchMock.mock.calls.map(call => call[1].method)).toEqual(['POST', 'GET']);
  });
  it('does not start an already-expired invocation', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(post(controller.signal)).rejects.toMatchObject({ code: 'NVIDIA_TIMEOUT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([401, 403, 422, 429, 500, 502, 503, 504])('preserves HTTP %i and safe request ID without disclosing provider errors', async status => {
    fetchMock.mockResolvedValue(json({ error: 'private prompt and key' }, status, { 'nvcf-reqid': id }));
    let error: NvidiaError | undefined;
    try { await post(); } catch (caught) { error = caught as NvidiaError; }
    expect(error).toMatchObject({ status, requestId: id, retryable: [429, 500, 502, 503].includes(status) });
    expect(String(error) + JSON.stringify(error)).not.toContain('private prompt');
    expect(error?.message).toContain(`HTTP ${status}`);
  });
  it('does not leak a network exception or malformed request ID', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed Bearer test-key private prompt'));
    await expect(post()).rejects.toMatchObject({ code: 'NVIDIA_CONNECTION_ERROR', status: 503 });
    fetchMock.mockResolvedValue(json({}, 504, { 'nvcf-reqid': 'private-prompt' }));
    await expect(post()).rejects.toMatchObject({ requestId: undefined });
  });
});

describe('NVIDIA completion parsing', () => {
  it('decodes byte-fragmented UTF-8, CRLF, heartbeats, usage-only events and private continuation', async () => {
    const response = sse([event(null, null, 'private'), event('مرحبا 🌍'), event('20', 'stop'), { choices: [], usage: { prompt_tokens: 3, completion_tokens: 7 } }], true);
    expect(await readNvidiaChat(response, new AbortController(), model)).toEqual({ content: 'مرحبا 🌍20', continuationReasoning: 'private', reasoningChars: 7, usage: { prompt_tokens: 3, completion_tokens: 7 } });
  });
  it('also accepts a nonstreaming completion for a streaming request', async () => {
    expect(await readNvidiaChat(json(completion), new AbortController(), model)).toMatchObject({ content: '20', continuationReasoning: 'private' });
  });
  it.each(['length', 'content_filter', 'tool_calls', null])('rejects unfinished or unexpected finish reason %s', async reason => {
    await expect(readNvidiaChat(sse([event('partial answer', reason)]), new AbortController(), model)).rejects.toBeInstanceOf(NvidiaError);
  });
  it('rejects EOF after partial text without a terminal reason', async () => {
    const response = new Response(`data: ${JSON.stringify(event('partial'))}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    await expect(readNvidiaChat(response, new AbortController(), model)).rejects.toMatchObject({ code: 'NVIDIA_INCOMPLETE_RESPONSE' });
  });
  it('does not mistake reasoning alone for an answer', async () => {
    await expect(readNvidiaChat(sse([event('', 'stop', 'private')]), new AbortController(), model)).rejects.toMatchObject({ code: 'NVIDIA_EMPTY_RESPONSE' });
  });
  it.each(['data: {invalid private source text}\n\n', 'event: error\ndata: {"error":"private source text"}\n\n'])('never logs malformed or error event text %#', async wire => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let error: unknown;
    try { await readNvidiaChat(new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } }), new AbortController(), model); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(NvidiaError); expect(String(error)).not.toContain('private source');
    expect(log).not.toHaveBeenCalled();
  });
  it('rejects HTML instead of interpreting it as an empty answer', async () => {
    await expect(readNvidiaChat(new Response('<html>proxy error</html>', { headers: { 'Content-Type': 'text/html' } }), new AbortController(), model)).rejects.toMatchObject({ code: 'NVIDIA_RESPONSE_FORMAT' });
  });
  it('ignores alternate choice indices', async () => {
    const other = { choices: [{ index: 1, delta: { content: 'wrong' }, finish_reason: 'stop' }] };
    expect(await readNvidiaChat(sse([other, event('20', 'stop')]), new AbortController(), model)).toMatchObject({ content: '20' });
  });
  it('releases the response when DONE arrives without waiting for the server to close', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event('20', 'stop'))}\n\ndata: [DONE]\n\n`));
    }, cancel }), { headers: { 'Content-Type': 'text/event-stream' } });
    expect((await readNvidiaChat(response, new AbortController(), model)).content).toBe('20');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
