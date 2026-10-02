import { setTimeout as delay } from 'node:timers/promises';
import type OpenAI from 'openai';
import { _iterSSEMessages } from 'openai/core/streaming';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Safe operational metadata only. Never attach provider bodies, prompts or keys. */
export class NvidiaError extends Error {
  constructor(message: string, readonly code: string, readonly status = 502,
    readonly retryable = true, readonly requestId?: string) {
    super(message);
    this.name = 'NvidiaError';
  }
}

function requestId(response: Response) {
  const id = response.headers.get('nvcf-reqid');
  return id && UUID.test(id) ? id : undefined;
}

export function nvidiaTimeout(model: string) {
  return new NvidiaError(`NVIDIA's ${model} endpoint did not finish within the request time limit. Try again or select another model.`, 'NVIDIA_TIMEOUT', 504, false);
}

export interface NvidiaTiming {
  startedAt: number;
  first_response_ms?: number;
  first_reasoning_ms?: number;
  first_content_ms?: number;
}

/** One POST, then poll the same invocation. The caller owns the total deadline. */
export async function nvidiaResponse(url: string, body: unknown, apiKey: string, signal: AbortSignal, model: string, timing?: NvidiaTiming): Promise<Response> {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
    Accept: (body as { stream?: boolean } | null)?.stream ? 'text/event-stream' : 'application/json', 'NVCF-POLL-SECONDS': '30' };
  let id: string | undefined;
  try {
    signal.throwIfAborted();
    let response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
    if (timing) timing.first_response_ms ??= Date.now() - timing.startedAt;
    while (response.status === 202) {
      const headerId = requestId(response);
      if (!id) {
        id = headerId;
        if (!id) {
          // Some gateways put the invocation ID in JSON instead of a header.
          const pending = await response.json().catch(() => null);
          if (typeof pending?.requestId === 'string' && UUID.test(pending.requestId)) id = pending.requestId;
        }
      }
      if (!response.bodyUsed) await response.body?.cancel();
      if (!id || (headerId && headerId !== id)) throw new NvidiaError('NVIDIA returned a pending request without a usable invocation ID.', 'NVIDIA_PENDING_INVALID', 502, false);
      // Ignore Location/URLs from response bodies: keep credentials on the configured origin.
      const statusUrl = new URL(url);
      statusUrl.pathname = statusUrl.pathname.replace(/\/chat\/completions\/?$/, `/status/${id}`);
      statusUrl.search = '';
      if (!/\/status\//.test(statusUrl.pathname)) throw new NvidiaError('NVIDIA request is still pending; this endpoint does not support status polling.', 'NVIDIA_PENDING_UNSUPPORTED', 503, false, id);
      await delay(500, undefined, { signal });
      response = await fetch(statusUrl.toString(), { method: 'GET', headers, signal, redirect: 'error' });
    }
    id ??= requestId(response);
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status;
      const detail = status === 504 ? 'The endpoint timed out before returning an answer.'
        : status === 401 || status === 403 ? 'Check the configured API key and its model access.'
          : status === 429 ? 'The provider rate limit was reached.' : 'Try again or select another model.';
      throw new NvidiaError(`NVIDIA ${model} is unavailable (HTTP ${status}). ${detail}`,
        status === 504 ? 'NVIDIA_ENDPOINT_TIMEOUT' : 'NVIDIA_HTTP_ERROR', status, [429, 500, 502, 503].includes(status), id);
    }
    return response;
  } catch (error) {
    if (signal.aborted) throw nvidiaTimeout(model);
    if (error instanceof NvidiaError) throw error;
    throw new NvidiaError(`Could not connect to NVIDIA's ${model} endpoint. Try again.`, 'NVIDIA_CONNECTION_ERROR', 503, true, id);
  }
}

type CompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type Completion = OpenAI.Chat.Completions.ChatCompletion;
type PrivateMessage = { content?: string | null; reasoning_content?: string | null };

/** Accept both SSE and fulfilled JSON, including JSON returned after a 202 poll. */
export async function readNvidiaChat(response: Response, controller: AbortController, model: string, timing?: NvidiaTiming) {
  let content = '', continuationReasoning = '', finishReason: string | null = null;
  let usage: OpenAI.CompletionUsage | undefined;
  const id = requestId(response);
  const consume = (message: PrivateMessage | undefined, finish: string | null | undefined) => {
    if (timing && message?.content) timing.first_content_ms ??= Date.now() - timing.startedAt;
    if (timing && message?.reasoning_content) timing.first_reasoning_ms ??= Date.now() - timing.startedAt;
    if (typeof message?.content === 'string') content += message.content;
    if (typeof message?.reasoning_content === 'string') continuationReasoning += message.reasoning_content;
    if (finish) finishReason = finish;
    if (content.length + continuationReasoning.length > 2_000_000) throw new NvidiaError('NVIDIA response exceeded the response limit.', 'NVIDIA_RESPONSE_LIMIT', 502, false, id);
  };
  try {
    controller.signal.throwIfAborted();
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      // Reuse the SDK's UTF-8/SSE framing, but not its JSON parser: that parser
      // logs raw malformed events (which may contain private source text).
      for await (const event of _iterSSEMessages(response, controller)) {
        controller.signal.throwIfAborted();
        if (event.data.trim() === '[DONE]') break;
        if (!event.data.trim()) continue;
        const chunk = JSON.parse(event.data) as CompletionChunk & { error?: unknown };
        if (chunk.error || event.event === 'error') throw new NvidiaError('NVIDIA interrupted the answer with a provider error. Try again.', 'NVIDIA_STREAM_ERROR', 502, true, id);
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.find(choice => choice.index === 0);
        consume(choice?.delta as PrivateMessage | undefined, choice?.finish_reason);
      }
    } else if (contentType.includes('application/json')) {
      const result = await response.json() as Completion & { error?: unknown };
      if (result.error) throw new NvidiaError('NVIDIA returned a provider error instead of an answer.', 'NVIDIA_RESPONSE_ERROR', 502, true, id);
      usage = result.usage;
      const choice = result.choices?.find(choice => choice.index === 0) ?? result.choices?.[0];
      consume(choice?.message as PrivateMessage | undefined, choice?.finish_reason);
    } else {
      throw new NvidiaError('NVIDIA returned an unreadable response format.', 'NVIDIA_RESPONSE_FORMAT', 502, true, id);
    }
    controller.signal.throwIfAborted();
    if (finishReason === 'length') throw new NvidiaError(`NVIDIA model ${model} reached its response limit. Try a narrower question.`, 'NVIDIA_RESPONSE_LIMIT', 502, false, id);
    if (!content.trim()) throw new NvidiaError(`NVIDIA returned no answer from ${model}. Try again or select another chat model.`, 'NVIDIA_EMPTY_RESPONSE', 502, true, id);
    if (finishReason !== 'stop') throw new NvidiaError('NVIDIA returned an incomplete answer. Try again.', 'NVIDIA_INCOMPLETE_RESPONSE', 502, true, id);
    return { content, continuationReasoning, reasoningChars: continuationReasoning.length, usage };
  } catch (error) {
    if (controller.signal.aborted) throw nvidiaTimeout(model);
    if (error instanceof NvidiaError) throw error;
    throw new NvidiaError('NVIDIA returned an unreadable or interrupted answer. Try again.', 'NVIDIA_INVALID_RESPONSE', 502, true, id);
  } finally {
    if (!response.body?.locked) await response.body?.cancel().catch(() => {});
  }
}
