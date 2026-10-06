import { z } from 'zod';
import { EMBED_MODEL, NVIDIA_OCR_MODEL, NVIDIA_OCR_MODELS, NVIDIA_RERANK_MODEL, NVIDIA_VISION_MODEL, NVIDIA_PARSE_MODEL } from '../config/providers.js';
import { ADDITIONAL_DOCUMENT_MODELS } from '../config/nvidiaModels.js';
import {NEMOTRON_EMBED_MODEL, NEMOTRON_EMBED_DIMENSION} from '../../shared/embeddingTrial.js';

export const evidenceRoleOptions = {
  reranker: [{ model: NVIDIA_RERANK_MODEL, label: 'Nemotron Rerank VL 1B v2' }, { model: 'off', label: 'Off — hybrid search only' }],
  vision: [{ model: NVIDIA_VISION_MODEL, label: 'Nemotron 3 Nano Omni' }, ...ADDITIONAL_DOCUMENT_MODELS, { model: 'off', label: 'Off' }],
  structure: [{ model: NVIDIA_PARSE_MODEL, label: 'Nemotron Parse 2.0' }, ...ADDITIONAL_DOCUMENT_MODELS.map(option => ({ ...option, label: `${option.label} · layout reading` })), { model: 'off', label: 'Off' }],
  ocr: Object.keys(NVIDIA_OCR_MODELS).map(model => ({ model, label: model.endsWith('v2') ? 'Nemotron OCR v2' : 'Nemotron OCR v1' })).concat(ADDITIONAL_DOCUMENT_MODELS.map(option => ({ ...option, label: `${option.label} · transcription` })), [{ model: 'off', label: 'Off' }]),
};
export const defaultEvidenceModels = { reranker: NVIDIA_RERANK_MODEL, vision: NVIDIA_VISION_MODEL, ocr: NVIDIA_OCR_MODEL, structure: NVIDIA_PARSE_MODEL };
export type EvidenceModels = typeof defaultEvidenceModels;
export const evidenceModelsSchema = z.object({
  reranker: z.string().refine(value => evidenceRoleOptions.reranker.some(option => option.model === value)).optional(),
  vision: z.string().refine(value => evidenceRoleOptions.vision.some(option => option.model === value)).optional(),
  ocr: z.string().refine(value => evidenceRoleOptions.ocr.some(option => option.model === value)).optional(),
  structure: z.string().refine(value => evidenceRoleOptions.structure.some(option => option.model === value)).optional(),
}).strict();
export function resolveEvidenceModels(input?: Partial<EvidenceModels>): EvidenceModels {
  const choices = evidenceModelsSchema.parse(input ?? {});
  return { ...defaultEvidenceModels, ...Object.fromEntries(Object.entries(choices).filter(([, value]) => value !== undefined)) };
}
export function modelRoleCatalog() {
  return { defaults: defaultEvidenceModels, options: evidenceRoleOptions,
    embeddings: { model: EMBED_MODEL, label: EMBED_MODEL === NEMOTRON_EMBED_MODEL ? 'Nemotron 3 Embed 1B' : 'Gemini Embedding 2', change_requires_reindex: true,
      trials: [{model: NEMOTRON_EMBED_MODEL, label: 'Nemotron 3 Embed 1B', dimension: NEMOTRON_EMBED_DIMENSION,
        configured: Boolean(process.env.NVIDIA_EMBED_API_KEY || process.env.NVIDIA_API_KEY), requires_reindex: true as const}] } };
}
