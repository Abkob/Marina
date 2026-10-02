// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { defaultEvidenceModels, evidenceModelsSchema, modelRoleCatalog, resolveEvidenceModels } from '../../../server/services/copilotModelRoles.js';
import { isSelectableChatModel, NVIDIA_LIGHTNING_MODEL, NVIDIA_ULTRA_MODEL } from '../../../server/config/providers.js';

describe('per-role model selection', () => {
  it('keeps defaults for omitted roles, including explicit undefined', () => {
    expect(resolveEvidenceModels()).toEqual(defaultEvidenceModels);
    expect(resolveEvidenceModels({ ocr: undefined })).toEqual(defaultEvidenceModels);
    expect(resolveEvidenceModels({ ocr: 'off' })).toEqual({ ...defaultEvidenceModels, ocr: 'off' });
  });
  it.each(['ocr', 'vision', 'structure', 'reranker'])('rejects cross-role or arbitrary models for %s', role => {
    expect(evidenceModelsSchema.safeParse({ [role]: 'https://untrusted.example/model' }).success).toBe(false);
  });
  it('rejects arbitrary embedding swaps against the existing vector index', () => {
    expect(evidenceModelsSchema.safeParse({ embeddings: 'nvidia/nemotron-3-embed-1b' }).success).toBe(false);
    expect(modelRoleCatalog().embeddings.change_requires_reindex).toBe(true);
  });
  it('allows all advertised defaults, alternatives and disabled states', () => {
    const catalog = modelRoleCatalog();
    for (const [role, options] of Object.entries(catalog.options)) {
      for (const option of options) expect(evidenceModelsSchema.safeParse({ [role]: option.model }).success).toBe(true);
    }
  });
  it('offers the verified Ultra and Lightning chat choices', () => {
    expect(isSelectableChatModel(NVIDIA_ULTRA_MODEL)).toBe(true);
    expect(isSelectableChatModel(NVIDIA_LIGHTNING_MODEL)).toBe(true);
  });
});
