import {NEMOTRON_EMBED_MODEL} from '../../shared/embeddingTrial.js';
export function embeddingProfile(model = process.env.MARINA_EMBEDDING_MODEL ?? 'gemini-embedding-2') {
  if (model === 'gemini-embedding-2') return {model, provider:'gemini' as const, dimension:3072, table:'embeddings' as const, column:'embedding_3072' as const, generation:'gemini-embedding-2'};
  if (model === NEMOTRON_EMBED_MODEL) return {model, provider:'nvidia' as const, dimension:2048, table:'nemotron_embeddings' as const, column:'embedding_2048' as const, generation:'nemotron-byte-windows-mean-v1'};
  throw new Error('Unsupported embedding profile. Select Gemini Embedding 2 or Nemotron 3 Embed 1B; an index rebuild is required.');
}
