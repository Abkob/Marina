/**
 * Central provider configuration.
 * All modules that need chat model names, embedding model names, or provider
 * mode must import from here — never read process.env directly for these values.
 *
 * Chat is restricted to NVIDIA Nemotron. The legacy mode setting describes
 * resource processing preferences; document embeddings remain a separate role.
 */

import {embeddingProfile} from './embeddingProfile.js';
import { nvidiaKeyForModel } from './nvidiaModels.js';
import {NEMOTRON_CHAT_MODELS,NEMOTRON_ULTRA_MODEL,NEMOTRON_LIGHTNING_MODEL,configuredNemotronModel,isNemotronChatModel} from './nemotronChat.js';
export type ProviderMode = 'local' | 'hybrid' | 'cloud';

function resolveMode(): ProviderMode {
  const raw = process.env.PROVIDER_MODE?.toLowerCase();
  if (raw === 'local' || raw === 'hybrid' || raw === 'cloud') return raw;
  // Preserve the resource-processing mode when GEMINI_API_KEY is present.
  if (!process.env.GEMINI_API_KEY) return 'local';
  return 'hybrid';
}

export const PROVIDER_MODE: ProviderMode = resolveMode();

// ─── Chat provider ─────────────────────────────────────────────────────────────

export const CHAT_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
export const CHAT_MODEL_PRIMARY = configuredNemotronModel(process.env.MARINA_MAIN_MODEL ?? process.env.MARINA_NVIDIA_NEMOTRON_MODEL);

export function resolveLocalFallbackModel(
  env: Partial<Pick<NodeJS.ProcessEnv, 'VERCEL' | 'MARINA_LOCAL_FALLBACK_MODEL'>> = process.env,
): string {
  // Chat is Nemotron-only in every environment; stale local settings cannot reopen another provider.
  return '';
}

export const CHAT_MODEL_FALLBACK = resolveLocalFallbackModel();
export const NVIDIA_API_BASE = process.env.NVIDIA_API_BASE ?? 'https://integrate.api.nvidia.com/v1';
export const NVIDIA_NEMOTRON_MODEL = configuredNemotronModel(process.env.MARINA_NVIDIA_NEMOTRON_MODEL);
export const NVIDIA_ULTRA_MODEL = NEMOTRON_ULTRA_MODEL;
export const NVIDIA_LIGHTNING_MODEL = NEMOTRON_LIGHTNING_MODEL;
export const NVIDIA_PARSE_MODEL = 'nvidia/nemotron-parse-2.0';
export const NVIDIA_FALLBACK_MODEL = isNemotronChatModel(process.env.MARINA_NVIDIA_FALLBACK_MODEL??'')
  ? process.env.MARINA_NVIDIA_FALLBACK_MODEL! : '';
// Separate evidence specialists; each embedding model keeps an isolated vector column.
export const NVIDIA_RERANK_MODEL = process.env.MARINA_NVIDIA_RERANK_MODEL
  ?? 'nvidia/llama-nemotron-rerank-vl-1b-v2';
export const NVIDIA_RERANK_URL = process.env.MARINA_NVIDIA_RERANK_URL
  ?? 'https://ai.api.nvidia.com/v1/retrieval/nvidia/llama-nemotron-rerank-vl-1b-v2/reranking';
export const NVIDIA_VISION_MODEL = process.env.MARINA_NVIDIA_VISION_MODEL
  ?? 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
export const NVIDIA_EVIDENCE_ENABLED = process.env.MARINA_NVIDIA_EVIDENCE_ENABLED !== 'false';
export const NVIDIA_OCR_MODELS = {
  'nvidia/nemotron-ocr-v2': 'https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v2',
  'nvidia/nemotron-ocr-v1': 'https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v1',
};
export const NVIDIA_OCR_MODEL = 'nvidia/nemotron-ocr-v2';

/** Explicit optional source-check model; never a fallback for the selected writer. */
export const PLANNING_GROUNDING_MODEL=isNemotronChatModel(process.env.MARINA_PLANNING_GROUNDING_MODEL??'')
  ? process.env.MARINA_PLANNING_GROUNDING_MODEL! : null;

/** NVIDIA Build models that can be selected for an individual Copilot turn. */
export const NVIDIA_CHAT_MODELS: string[] = [...NEMOTRON_CHAT_MODELS];

export function isNvidiaChatModel(model: string): boolean {
  return NVIDIA_CHAT_MODELS.includes(model);
}

export const SELECTABLE_CHAT_MODELS = [...NVIDIA_CHAT_MODELS];

export function isSelectableChatModel(model: string): boolean {
  return SELECTABLE_CHAT_MODELS.includes(model);
}

// Every selectable chat model executes on NVIDIA's cloud.
export function isCloudChatModel(model: string): boolean {
  return isNvidiaChatModel(model);
}

export const LOCAL_CHAT_ENABLED = false;

// Bounded chat request wait — callers must not hang forever on a wedged model.
export const CHAT_TIMEOUT_MS = Number(process.env.MARINA_CHAT_TIMEOUT_MS ?? 180_000);
/** Split source grounding is opt-in until its live usefulness cohort is qualified. */
export const PLANNING_REVIEW_MODE=process.env.MARINA_PLANNING_REVIEW_MODE==='split'?'split':'combined';

// ─── Embedding provider ────────────────────────────────────────────────────────

const embedding = embeddingProfile();
export const EMBED_MODEL = embedding.model;
export const EMBED_DIMENSION = embedding.dimension;
export const EMBED_TABLE = embedding.table;
export const EMBED_COLUMN = embedding.column;
export const EMBED_GENERATION = embedding.generation;
export const EMBED_PROVIDER = embedding.provider;

// When true, raw journal/note/document text may be sent to the embedding provider.
// This applies to both embedding providers. Default: only journal summaries go to cloud.
export const ALLOW_CLOUD_RAW_TEXT = process.env.ALLOW_CLOUD_RAW_TEXT === 'true';

// ─── Display helpers ──────────────────────────────────────────────────────────

export function getProviderSummary() {
  return {
    mode: PROVIDER_MODE,
    chat: {
      provider: 'nvidia',
      model: CHAT_MODEL_PRIMARY,
      // Nemotron chat prompts execute on NVIDIA's cloud.
      model_is_cloud: isCloudChatModel(CHAT_MODEL_PRIMARY),
      fallback: CHAT_MODEL_FALLBACK || null,
      fallback_is_cloud: CHAT_MODEL_FALLBACK ? isCloudChatModel(CHAT_MODEL_FALLBACK) : null,
      nvidia_fallback: NVIDIA_FALLBACK_MODEL,
      nvidia_fallback_configured: Boolean(NVIDIA_FALLBACK_MODEL && nvidiaKeyForModel(NVIDIA_FALLBACK_MODEL)),
      host: LOCAL_CHAT_ENABLED ? CHAT_HOST : null,
      planning_review:{mode:PLANNING_REVIEW_MODE,grounding_model:PLANNING_GROUNDING_MODEL,quality:'not_qualified'},
    },
    embeddings: {
      // Each provider uses its own isolated table and vector dimensions.
      provider: EMBED_PROVIDER,
      model: EMBED_MODEL,
      dimension: EMBED_DIMENSION,
      requires_api_key: true,
      api_key_present: EMBED_PROVIDER === 'nvidia' ? Boolean(process.env.NVIDIA_EMBED_API_KEY || process.env.NVIDIA_API_KEY) : Boolean(process.env.GEMINI_API_KEY),
      sends_raw_text_to_cloud: ALLOW_CLOUD_RAW_TEXT,
    },
    evidence: {
      provider: 'nvidia',
      configured: NVIDIA_EVIDENCE_ENABLED && Boolean(process.env.NVIDIA_API_KEY),
      rerank_model: NVIDIA_RERANK_MODEL,
      vision_model: NVIDIA_VISION_MODEL,
      ocr_model: NVIDIA_OCR_MODEL,
      structure_model: NVIDIA_PARSE_MODEL,
      sends_selected_passages_and_pages_to_cloud: NVIDIA_EVIDENCE_ENABLED,
      availability: 'shared development API; rate limits and outages may apply',
    },
  };
}
