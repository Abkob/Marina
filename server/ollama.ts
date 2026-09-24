import { Ollama } from 'ollama';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import OpenAI from 'openai';
import {
  CHAT_HOST,
  CHAT_MODEL_PRIMARY,
  CHAT_MODEL_FALLBACK,
  CHAT_TIMEOUT_MS,
  NVIDIA_API_BASE,
  NVIDIA_FALLBACK_MODEL,
  LOCAL_CHAT_ENABLED,
  SELECTABLE_CHAT_MODELS,
  isCloudChatModel,
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

export const ollama = new Ollama({ host: CHAT_HOST });
const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;
const nvidia = process.env.NVIDIA_API_KEY
  ? new OpenAI({
      apiKey: process.env.NVIDIA_API_KEY,
      baseURL: NVIDIA_API_BASE,
      timeout: Number(process.env.MARINA_NVIDIA_TIMEOUT_MS ?? 90_000),
      maxRetries: 0,
    })
  : null;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCallTrace {
  model: string;
  provider: 'gemini-cloud' | 'nvidia-cloud' | 'ollama-local' | 'ollama-cloud';
  duration_ms: number;
  prompt_chars: number;
  fallback_used: boolean;
  /** Provider-reported counts only; absent when the provider supplies no usage. */
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
}

export interface ChatOptions {
  /** Optional per-session/per-turn model selected from CHAT_MODEL_OPTIONS. */
  model?: string;
  temperature?: number;
  max_tokens?: number;
  jsonMode?: boolean;
  thinking?: boolean;
  onTrace?: (trace: ChatCallTrace) => void;
  allowFallback?: boolean;
  allowLocalFallback?: boolean;
  fallbackPromptCharLimit?: number;
  /** Absolute deadline shared by every model call and fallback in one turn. */
  deadlineMs?: number;
}

// ─── Model availability ──────────────────────────────────────────────────────

export type ModelStatus = 'available' | 'cloud' | 'missing' | 'unknown';

// Cache the installed-model list briefly so health checks and per-request
// fallback guards don't hammer the Ollama API.
let modelListCache: { names: string[]; fetchedAt: number } | null = null;
const MODEL_LIST_TTL_MS = 60_000;

async function listInstalledModels(): Promise<string[]> {
  if (modelListCache && Date.now() - modelListCache.fetchedAt < MODEL_LIST_TTL_MS) {
    return modelListCache.names;
  }
  const list = await ollama.list();
  const names = list.models.map(m => m.name);
  modelListCache = { names, fetchedAt: Date.now() };
  return names;
}

function classifyModel(model: string, installed: string[]): ModelStatus {
  // A cloud manifest can appear in `ollama list` after first use, but its
  // inference still happens remotely. Preserve that distinction in readiness
  // and privacy indicators instead of reporting it as locally available.
  if (model.startsWith('gemini-')) return gemini ? 'cloud' : 'missing';
  if (isNvidiaChatModel(model)) return NVIDIA_CONFIGURED ? 'cloud' : 'missing';
  if (isCloudChatModel(model)) return 'cloud';
  // Exact match, or match ignoring the ':latest' suffix convention
  if (installed.some(n => n === model || n === `${model}:latest` || `${n}:latest` === model)) {
    return 'available';
  }
  return 'missing';
}

/**
 * Validates the configured chat models against what Ollama actually has.
 * Used by readiness endpoints so a configured-but-missing model is surfaced
 * instead of failing silently at chat time.
 */
export async function validateChatModels(): Promise<{
  reachable: boolean;
  primary: { model: string; status: ModelStatus };
  nvidia_fallback: { model: string; status: ModelStatus };
  fallback: { model: string; status: ModelStatus } | null;
  available: Array<{ model: string; provider: 'gemini' | 'nvidia' | 'ollama'; status: ModelStatus }>;
  installed: string[];
  error?: string;
}> {
  try {
    const installed = LOCAL_CHAT_ENABLED ? await listInstalledModels() : [];
    return {
      reachable: true,
      primary: { model: CHAT_MODEL, status: classifyModel(CHAT_MODEL, installed) },
      nvidia_fallback: { model: NVIDIA_MODEL, status: classifyModel(NVIDIA_MODEL, installed) },
      fallback: FALLBACK_MODEL
        ? { model: FALLBACK_MODEL, status: classifyModel(FALLBACK_MODEL, installed) }
        : null,
      available: CHAT_MODEL_OPTIONS.map(model => ({
        model,
        provider: model.startsWith('gemini-') ? 'gemini' as const
          : isNvidiaChatModel(model) ? 'nvidia' as const
            : 'ollama' as const,
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
        provider: model.startsWith('gemini-') ? 'gemini' as const
          : isNvidiaChatModel(model) ? 'nvidia' as const
            : 'ollama' as const,
        status: isNvidiaChatModel(model) && NVIDIA_CONFIGURED ? 'cloud' as const : 'unknown' as const,
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
      reject(new ChatTimeoutError(model, requestTimeoutMs));
    }, requestTimeoutMs);
    timer.unref?.();
  });
  const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
  const startedAt = Date.now();
  try {
    if (isNvidiaChatModel(model)) {
      if (!nvidia) throw new Error('NVIDIA_API_KEY is required for NVIDIA NIM chat');
      const maxTokens = opts.max_tokens ?? 16_384;
      const isNemotron3 = model.includes('nemotron-3-');
      // Extended reasoning is useful for the substantive 8K-token Copilot
      // answer, but it makes tiny routing/JSON calls slow and can consume their
      // entire output allowance before the model emits the required JSON.
      const thinkingEnabled = (opts.thinking ?? (isNemotron3
        ? process.env.MARINA_NVIDIA_THINKING === 'true'
        : process.env.MARINA_DEEPSEEK_THINKING === 'true'))
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
        messages,
        temperature: opts.temperature ?? Number(process.env.MARINA_NVIDIA_TEMPERATURE ?? 1),
        top_p: Number(process.env.MARINA_NVIDIA_TOP_P ?? 0.95),
        max_tokens: maxTokens,
        ...(opts.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
        stream: true,
        stream_options: { include_usage: true },
        chat_template_kwargs: isNemotron3
          ? { enable_thinking: thinkingEnabled }
          : { thinking: thinkingEnabled },
        ...(isNemotron3 && thinkingEnabled ? { reasoning_budget: reasoningBudget } : {}),
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
        chat_template_kwargs: {
          enable_thinking?: boolean;
          thinking?: boolean;
        };
        reasoning_budget?: number;
      };
      const streamedResult = (async () => {
        const stream = await nvidia.chat.completions.create(request, {
          signal: abortController?.signal,
        });
        let content = '';
        let reasoningChars = 0;
        let usage: OpenAI.CompletionUsage | undefined;
        for await (const chunk of stream) {
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices?.[0]?.delta as
            | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
                reasoning_content?: string | null;
              })
            | undefined;
          if (delta?.reasoning_content) reasoningChars += delta.reasoning_content.length;
          if (delta?.content) content += delta.content;
        }
        return { content, reasoningChars, usage };
      })();
      const { content, reasoningChars, usage } = await Promise.race([streamedResult, timeout]);
      const text = content.trim();
      if (!text) throw new Error(`NVIDIA model ${model} returned an empty response`);
      const durationMs = Date.now() - startedAt;
      opts.onTrace?.({
        model,
        provider: 'nvidia-cloud',
        duration_ms: durationMs,
        prompt_chars: promptChars,
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

    if (model.startsWith('gemini-')) {
      if (!gemini) throw new Error('GEMINI_API_KEY is required for Gemini chat');
      const systemInstruction = messages
        .filter(message => message.role === 'system')
        .map(message => message.content)
        .join('\n\n');
      const contents = messages
        .filter(message => message.role !== 'system')
        .map(message => ({
          role: message.role === 'assistant' ? 'model' as const : 'user' as const,
          parts: [{ text: message.content }],
        }));
      const response = await Promise.race([
        gemini.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
            maxOutputTokens: opts.max_tokens ?? 8192,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          },
        }),
        timeout,
      ]);
      const text = response.text?.trim();
      if (!text) throw new Error(`Gemini model ${model} returned an empty response`);
      const durationMs = Date.now() - startedAt;
      opts.onTrace?.({
        model,
        provider: 'gemini-cloud',
        duration_ms: durationMs,
        prompt_chars: promptChars,
        fallback_used: model !== (opts.model ?? CHAT_MODEL),
      });
      console.log(`[chat] ${model} ok in ${Math.round(durationMs / 1000)}s (prompt ${promptChars} chars)`);
      return text;
    }

    const response = await Promise.race([
        ollama.chat({
          model,
          messages,
          ...(opts.jsonMode ? { format: 'json' as const } : {}),
          // qwen3 emits long chain-of-thought by default, which multiplies
          // latency and routinely blows the timeout on structured extraction.
          ...(model.startsWith('qwen3') ? { think: false } : {}),
          // Keep the model resident between calls — a cold reload plus prompt
          // evaluation costs minutes on this hardware and blows the timeout.
          keep_alive: process.env.MARINA_KEEP_ALIVE ?? '60m',
          options: {
            temperature: opts.temperature ?? 0.3,
            num_predict: opts.max_tokens ?? 8192,
            // Ollama defaults num_ctx to 4096, silently truncating our prompts:
            // the copilot context budget alone allows ~13K tokens. Truncation
            // made the model return unusable output with no error.
            num_ctx: Number(process.env.MARINA_NUM_CTX ?? 16384),
          },
        }),
        timeout,
      ]);
    const durationMs = Date.now() - startedAt;
    opts.onTrace?.({
      model,
      provider: isCloudChatModel(model) ? 'ollama-cloud' : 'ollama-local',
      duration_ms: durationMs,
      prompt_chars: promptChars,
      fallback_used: model !== (opts.model ?? CHAT_MODEL),
    });
    console.log(`[ollama] ${model} ok in ${Math.round(durationMs / 1000)}s (prompt ${promptChars} chars)`);
    return response.message.content;
  } catch (err) {
    console.warn(`[ollama] ${model} failed after ${Math.round((Date.now() - startedAt) / 1000)}s (prompt ${promptChars} chars): ${(err as Error).message}`);
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
    if (opts.allowLocalFallback === false) throw fallbackError;
    if (FALLBACK_MODEL && FALLBACK_MODEL !== primaryModel) {
      const promptChars = messages.reduce((sum, message) => sum + message.content.length, 0);
      const fallbackPromptCharLimit = opts.fallbackPromptCharLimit ?? Number.POSITIVE_INFINITY;
      if (promptChars > fallbackPromptCharLimit) {
        throw new Error(
          `${(fallbackError as Error).message}. Local fallback ${FALLBACK_MODEL} was not started because this ${promptChars.toLocaleString()}-character request exceeds its interactive limit of ${fallbackPromptCharLimit.toLocaleString()} characters.`,
        );
      }
      // Only attempt the fallback when it is actually usable — retrying a
      // missing model would just mask the real failure with a second one.
      let fallbackUsable = true;
      try {
        const installed = await listInstalledModels();
        fallbackUsable = classifyModel(FALLBACK_MODEL, installed) !== 'missing';
      } catch { /* Ollama unreachable — the fallback attempt will surface it */ }

      if (fallbackUsable) {
        console.warn(`[ollama] Cloud models failed (${(fallbackError as Error).message}), trying local fallback ${FALLBACK_MODEL}`);
        return chatOnce(FALLBACK_MODEL, messages, opts);
      }
      console.error(`[ollama] Primary model ${primaryModel} failed and configured fallback ${FALLBACK_MODEL} is not installed`);
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

// Local runtime health. Cloud-only deployments do not require an Ollama daemon.
export async function ollamaHealth(): Promise<{ ok: boolean; models: string[]; error?: string }> {
  if (!LOCAL_CHAT_ENABLED) return { ok: true, models: [] };
  try {
    const models = await listInstalledModels();
    return { ok: true, models };
  } catch (err) {
    return { ok: false, models: [], error: String(err) };
  }
}
