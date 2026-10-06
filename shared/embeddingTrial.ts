export const NEMOTRON_EMBED_MODEL = 'nvidia/nemotron-3-embed-1b';
export const NEMOTRON_EMBED_DIMENSION = 2048;
export interface EmbeddingTrialOption {
  model: string;
  label: string;
  dimension: number;
  configured: boolean;
  requires_reindex: true;
}
export interface EmbeddingTrialResult {
  model: string;
  dimension: number;
  correct_top_matches: number;
  total_queries: number;
  elapsed_ms: number;
  sample_only: true;
  index_changed: false;
}
