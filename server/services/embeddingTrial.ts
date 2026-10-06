import {nemotronEmbeddings} from './nemotronEmbeddings.js';
import {NEMOTRON_EMBED_MODEL, NEMOTRON_EMBED_DIMENSION, type EmbeddingTrialResult} from '../../shared/embeddingTrial.js';
// Independent expected sources; no production library content is sent or indexed.
export const embeddingTrialSamples = {
  passages: [
    'Biology 210 notes: mitochondria produce most of the energy used by cells.',
    'The Monday calendar has LeetCode programming practice from 5:00 AM to 7:30 AM.',
    'The Report requires its Background reading task. A similarly named optional resource does not change that requirement.',
    'Biology 210 notes: chloroplasts capture sunlight during photosynthesis.',
    'The Wednesday calendar has LeetCode programming practice from 6:00 AM to 8:00 AM.',
    'The optional Background reading resource is extra material. Its optional label applies to the resource, not to any task.',
  ],
  queries: [
    {text: 'Which organelle supplies energy to cells?', expected: 0},
    {text: 'متى يبدأ تدريب البرمجة يوم الاثنين؟', expected: 1},
    {text: 'Is the Background reading task required for the Report?', expected: 2},
  ],
};
export function cosine(left: number[], right: number[]) {
  let dot = 0, a = 0, b = 0;
  for (let i = 0; i < left.length; i++) { dot += left[i] * right[i]; a += left[i] ** 2; b += right[i] ** 2; }
  return dot / (Math.sqrt(a) * Math.sqrt(b));
}
export function countCorrectMatches(passages: number[][], queries: number[][]): number {
  return queries.filter((query, i) => {
    const scores = passages.map(passage => cosine(query, passage));
    const best = Math.max(...scores);
    return scores.filter(score => Math.abs(score - best) < 1e-12).length === 1
      && scores[embeddingTrialSamples.queries[i].expected] === best;
  }).length;
}
export async function runEmbeddingTrial(signal?: AbortSignal): Promise<EmbeddingTrialResult> {
  const started = Date.now(), options = {signal, deadlineMs: started + 45_000};
  const passages = await nemotronEmbeddings(embeddingTrialSamples.passages, 'passage', options);
  const queries = await nemotronEmbeddings(embeddingTrialSamples.queries.map(row => row.text), 'query', options);
  // A tie is not evidence of a successful source match.
  const correct = countCorrectMatches(passages, queries);
  return {model: NEMOTRON_EMBED_MODEL, dimension: NEMOTRON_EMBED_DIMENSION, correct_top_matches: correct,
    total_queries: queries.length, elapsed_ms: Date.now() - started, sample_only: true, index_changed: false};
}
