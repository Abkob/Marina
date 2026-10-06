import type OpenAI from 'openai';
import { NvidiaError, nvidiaResponse, readNvidiaChat, nvidiaTimeout, type NvidiaTiming } from './services/nvidiaTransport.js';
import type { ChatCallTrace } from '../src/types/copilotRuntime.js';
export type { ChatCallTrace } from '../src/types/copilotRuntime.js';
import { nvidiaKeyForModel, prepareNvidiaMessages } from './config/nvidiaModels.js';
import {
  CHAT_MODEL_PRIMARY,
  CHAT_MODEL_FALLBACK,
  CHAT_TIMEOUT_MS,
  NVIDIA_API_BASE,
  NVIDIA_FALLBACK_MODEL,
  SELECTABLE_CHAT_MODELS,
  isNvidiaChatModel,
  isSelectableChatModel,
} from './config/providers.js';

export const CHAT_MODEL = CHAT_MODEL_PRIMARY;
export const FALLBACK_MODEL = CHAT_MODEL_FALLBACK;
export const NVIDIA_MODEL = NVIDIA_FALLBACK_MODEL;
export const NVIDIA_CONFIGURED = Boolean(process.env.NVIDIA_API_KEY);
export const CHAT_MODEL_OPTIONS = SELECTABLE_CHAT_MODELS;

export function resolveChatModel(model?: string | null): string {
  if (!model) return CHAT_MODEL;
  if (!isSelectableChatModel(model)) throw new Error(`Unsupported chat model: ${model}`);
  return model;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Ephemeral provider continuation state: never render, log or persist. */
  reasoning_content?: string;
}

export interface ChatOptions {
  /** Optional per-session/per-turn model selected from CHAT_MODEL_OPTIONS. */
  model?: string;
  temperature?: number;
  max_tokens?: number;
  jsonMode?: boolean;
  thinking?: boolean;
  onTrace?: (trace: ChatCallTrace) => void;
  onAssistantMessage?: (message: ChatMessage) => void;
  allowFallback?: boolean;
  allowLocalFallback?: boolean;
  fallbackPromptCharLimit?: number;
  /** Absolute deadline shared by every model call and fallback in one turn. */
  deadlineMs?: number;
}

// ─── Model availability ──────────────────────────────────────────────────────

export type ModelStatus = 'available' | 'cloud' | 'missing' | 'unknown';

function classifyModel(model: string, _installed: string[]): ModelStatus {
  return nvidiaKeyForModel(model) ? 'cloud' : 'missing';
}

/**
 * Reports credential readiness for the configured Nemotron chat models.
 * Used by readiness endpoints so a configured-but-missing model is surfaced
 * instead of failing silently at chat time.
 */
export async function validateChatModels(): Promise<{
  reachable: boolean;
  primary: { model: string; status: ModelStatus };
  nvidia_fallback: { model: string; status: ModelStatus };
  fallback: { model: string; status: ModelStatus } | null;
  available: Array<{ model: string; provider: 'nvidia'; status: ModelStatus }>;
  installed: string[];
  error?: string;
}> {
  try {
    const installed: string[] = [];
    return {
      reachable: true,
      primary: { model: CHAT_MODEL, status: classifyModel(CHAT_MODEL, installed) },
      nvidia_fallback: { model: NVIDIA_MODEL, status: classifyModel(NVIDIA_MODEL, installed) },
      fallback: FALLBACK_MODEL
        ? { model: FALLBACK_MODEL, status: classifyModel(FALLBACK_MODEL, installed) }
        : null,
      available: CHAT_MODEL_OPTIONS.map(model => ({
        model,
        provider: 'nvidia' as const,
        status: classifyModel(model, installed),
      })),
      installed,
    };
  } catch (err) {
    return {
      reachable: false,
      primary: { model: CHAT_MODEL, status: 'unknown' },
      nvidia_fallback: { model: NVIDIA_MODEL, status: NVIDIA_CONFIGURED ? 'cloud' : 'missing' },
      fallback: FALLBACK_MODEL ? { model: FALLBACK_MODEL, status: 'unknown' } : null,
      available: CHAT_MODEL_OPTIONS.map(model => ({
        model,
        provider: 'nvidia' as const,
        status: isNvidiaChatModel(model) && nvidiaKeyForModel(model) ? 'cloud' as const : 'unknown' as const,
      })),
      installed: [],
      error: String(err),
    };
  }
}

// ─── Chat ────────────────────────────────────────────────────────────────────

class ChatTimeoutError extends Error {
  constructor(model: string, ms: number) {
    super(`Chat request to ${model} timed out after ${ms}ms`);
    this.name = 'ChatTimeoutError';
  }
}

const modelCooldowns = new Map<string, { until: number; reason: string | null }>();

class PrimaryModelCooldownError extends Error {
  constructor(model: string, until: number, reason: string | null) {
    const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    super(`Primary model ${model} is rate-limited for about ${seconds}s${reason ? ` (${reason})` : ''}`);
    this.name = 'PrimaryModelCooldownError';
  }
}

function quotaCooldownMs(error: unknown): number | null {
  const message = String((error as Error)?.message ?? error);
  if (!/\b429\b|RESOURCE_EXHAUSTED|quota exceeded|rate.?limit/i.test(message)) return null;
  const retrySeconds = Number(message.match(/"retryDelay"\s*:\s*"(\d+)s"/i)?.[1] ?? 60);
  return Math.max(5_000, Math.min(5 * 60_000, (retrySeconds + 2) * 1000));
}

export function getChatCooldownStatus(model = CHAT_MODEL): {
  active: boolean;
  until: string | null;
  reason: string | null;
} {
  const cooldown = modelCooldowns.get(model);
  const active = Boolean(cooldown && cooldown.until > Date.now());
  return {
    active,
    until: active && cooldown ? new Date(cooldown.until).toISOString() : null,
    reason: active && cooldown ? cooldown.reason : null,
  };
}

async function chatOnce(
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const abortController = isNvidiaChatModel(model) ? new AbortController() : null;
  const configuredTimeoutMs = isNvidiaChatModel(model)
    ? Number(process.env.MARINA_NVIDIA_TIMEOUT_MS ?? 90_000)
    : CHAT_TIMEOUT_MS;
  const requestTimeoutMs = Math.min(configuredTimeoutMs, opts.deadlineMs === undefined ? configuredTimeoutMs : Math.max(0, opts.deadlineMs - Date.now()));
  if (requestTimeoutMs < 1000) throw new Error('Copilot reached the turn time limit. Please try again.');
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abortController?.abort();
      reject(abortController ? nvidiaTimeout(model) : new ChatTimeoutError(model, requestTimeoutMs));
    }, requestTimeoutMs);
    timer.unref?.();
  });
  // Count the content actually sent after provider history conversion. Private
  // continuation is measured separately, never copied into traces.
  const preparedMessages: ChatMessage[] = isNvidiaChatModel(model) ? prepareNvidiaMessages(model, messages) : messages;
  const promptChars = preparedMessages.reduce((s, m) => s + m.content.length, 0);
  const promptStats = {
    system_prompt_chars: preparedMessages.filter(m => m.role === 'system').reduce((sum, m) => sum + m.content.length, 0),
    conversation_chars: preparedMessages.filter(m => m.role !== 'system').reduce((sum, m) => sum + m.content.length, 0),
    continuation_chars: preparedMessages.reduce((sum, m) => sum + (m.reasoning_content?.length ?? 0), 0),
  };
  const startedAt = Date.now();
  const timing: NvidiaTiming = { startedAt };
  const timingStats = () => {
    const { startedAt: _startedAt, ...measurements } = timing;
    return measurements;
  };
  try {
    if (isNvidiaChatModel(model)) {
      const apiKey = nvidiaKeyForModel(model);
      if (!apiKey) throw new Error('The selected NVIDIA chat model has no configured API key');
      const maxTokens = opts.max_tokens ?? 16_384;
      const isNemotron3 = /nemotron-3[.-]/.test(model);
      // Extended reasoning is useful for the substantive 8K-token Copilot
      // answer, but it makes tiny routing/JSON calls slow and can consume their
      // entire output allowance before the model emits the required JSON.
      const thinkingEnabled = (opts.thinking ?? (process.env.MARINA_NVIDIA_THINKING === 'true'))
        && maxTokens > 1_024;
      const configuredReasoningBudget = Number(process.env.MARINA_NVIDIA_REASONING_BUDGET ?? 4_096);
      // NVIDIA counts reasoning against the generated-token allowance. Always
      // reserve at least 2K tokens for the actual JSON/final answer so a long
      // thought process cannot terminate the response mid-object.
      const reasoningBudget = Math.min(
        configuredReasoningBudget,
        Math.max(256, maxTokens - 2_048),
      );
      const request = {
        model,
        messages: preparedMessages,
        temperature: opts.temperature ?? Number(process.env.MARINA_NVIDIA_TEMPERATURE ?? 1),
        top_p: Number(process.env.MARINA_NVIDIA_TOP_P ?? 0.95),
        max_tokens: maxTokens,
        ...(opts.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
        stream: true,
        stream_options: { include_usage: true },
        chat_template_kwargs: { enable_thinking: thinkingEnabled },
        ...(isNemotron3 && thinkingEnabled ? { reasoning_budget: reasoningBudget } : {}),
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
        chat_template_kwargs?: {
          enable_thinking?: boolean;
          thinking?: boolean;
        };
        reasoning_budget?: number;
      };
      const streamedResult = (async () => {
        const response = await nvidiaResponse(`${NVIDIA_API_BASE.replace(/\/$/, '')}/chat/completions`, request, apiKey, abortController!.signal, model, timing);
        return readNvidiaChat(response, abortController!, model, timing);
      })();
      const { content, reasoningChars, usage } = await Promise.race([streamedResult, timeout]);
      const text = content.trim();
      opts.onAssistantMessage?.({ role: 'assistant', content });
      const durationMs = Date.now() - startedAt;
      opts.onTrace?.({
        model,
        provider: 'nvidia-cloud',
        duration_ms: durationMs,
        prompt_chars: promptChars,
        ...promptStats,
        ...timingStats(),
        fallback_used: model !== (opts.model ?? CHAT_MODEL),
        ...(usage ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens,
          ...(usage.prompt_tokens_details?.cached_tokens !== undefined ? { cached_input_tokens: usage.prompt_tokens_details.cached_tokens } : {}) } : {}),
      });
      console.log(
        `[nvidia] ${model} ok in ${Math.round(durationMs / 1000)}s `
        + `(prompt ${promptChars} chars, reasoning ${reasoningChars} chars)`,
      );
      return text;
    }

    throw new Error(`Unsupported chat model: ${model}`);
  } catch (err) {
    if (err instanceof NvidiaError) opts.onTrace?.({ model, provider: 'nvidia-cloud', duration_ms: Date.now() - startedAt,
      prompt_chars: promptChars, ...promptStats, ...timingStats(), fallback_used: model !== (opts.model ?? CHAT_MODEL),
      outcome: 'error', error_code: err.code });
    console.warn(`[ollama] ${model} failed after ${Math.round((Date.now() - startedAt) / 1000)}s (prompt ${promptChars} chars): ${(err as Error).message}`);
    if (err instanceof NvidiaError) console.warn('[nvidia] failure metadata', { code: err.code, status: err.status, request_id: err.requestId });
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Transient network failures (DNS blips, resets) are worth one bounded retry
// of the primary before engaging the fallback — a cloud model that answers in
// seconds beats a local model that needs minutes for the same prompt.
function isTransientNetworkError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /no such host|dial tcp|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(msg);
}

async function tryPrimary(
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<string> {
  const primaryModel = resolveChatModel(opts.model);
  const currentCooldown = modelCooldowns.get(primaryModel);
  if (currentCooldown && currentCooldown.until > Date.now()) {
    throw new PrimaryModelCooldownError(primaryModel, currentCooldown.until, currentCooldown.reason);
  }
  try {
    return await chatOnce(primaryModel, messages, opts);
  } catch (firstErr) {
    const cooldownMs = quotaCooldownMs(firstErr);
    if (cooldownMs) {
      const until = Date.now() + cooldownMs;
      modelCooldowns.set(primaryModel, { until, reason: 'quota exceeded' });
      throw new PrimaryModelCooldownError(primaryModel, until, 'quota exceeded');
    }
    if (!isTransientNetworkError(firstErr)) throw firstErr;
    console.warn(`[ollama] Primary ${CHAT_MODEL} hit a transient network error — retrying once before fallback`);
    await new Promise(r => setTimeout(r, 2000));
    return chatOnce(primaryModel, messages, opts);
  }
}

export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  const primaryModel = resolveChatModel(opts.model);
  try {
    return await tryPrimary(messages, opts);
  } catch (primaryErr) {
    if (opts.allowFallback === false) throw primaryErr;
    let fallbackError = primaryErr;
    if (NVIDIA_CONFIGURED && NVIDIA_MODEL && NVIDIA_MODEL !== primaryModel) {
      try {
        console.warn(`[chat] Primary model ${primaryModel} failed; trying NVIDIA fallback ${NVIDIA_MODEL}`);
        return await chatOnce(NVIDIA_MODEL, messages, opts);
      } catch (nvidiaErr) {
        fallbackError = nvidiaErr;
        console.warn(`[nvidia] Fallback model ${NVIDIA_MODEL} failed: ${(nvidiaErr as Error).message}`);
      }
    }
    throw fallbackError;
  }
}

// Parse Ollama response as JSON. Ollama models sometimes wrap in ```json fences.
export function parseJSON<T = Record<string, unknown>>(raw: string): T {
  const clean = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/m, '')
    .trim();
  try {
    return JSON.parse(clean) as T;
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as T;
    throw new Error(`Could not parse JSON from model response: ${raw.slice(0, 200)}`);
  }
}

// Compatibility health field: Nemotron chat needs no local daemon.
export async function ollamaHealth(): Promise<{ ok: boolean; models: string[]; error?: string }> {
  return { ok: true, models: [] };
}
