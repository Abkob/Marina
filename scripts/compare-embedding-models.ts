/** Explicit, bounded synthetic provider comparison; never reads/writes the library. */
import dotenv from 'dotenv';
import {writeFileSync} from 'node:fs';
import {embeddingTrialSamples as samples, countCorrectMatches, cosine} from '../server/services/embeddingTrial.js';
import {nemotronEmbeddings} from '../server/services/nemotronEmbeddings.js';
import {NEMOTRON_EMBED_MODEL} from '../shared/embeddingTrial.js';
if (!process.argv.includes('--live')) throw new Error('Pass --live to authorize this nine-input synthetic comparison.');
dotenv.config({quiet:true});
const {embedDocument, embedQuery, EMBED_MODEL, EMBED_DIMENSION} = await import('../server/embeddingProvider.js');
if (EMBED_MODEL !== 'gemini-embedding-2' || EMBED_DIMENSION !== 3072) throw new Error('The comparison expects the existing Gemini 2 index profile.');
const results = [];
for (const model of [EMBED_MODEL, NEMOTRON_EMBED_MODEL]) {
  const started = Date.now(); let phase = 'passages'; const times: Record<string, number> = {};
  try {
    const phaseStart = Date.now();
    const passages = model === NEMOTRON_EMBED_MODEL ? await nemotronEmbeddings(samples.passages, 'passage')
      : await Promise.all(samples.passages.map(embedDocument));
    times.passages_ms = Date.now() - phaseStart; phase = 'queries'; const queryStart = Date.now();
    const queries = model === NEMOTRON_EMBED_MODEL ? await nemotronEmbeddings(samples.queries.map(row => row.text), 'query')
      : await Promise.all(samples.queries.map(row => embedQuery(row.text)));
    times.queries_ms = Date.now() - queryStart;
    const dimension = model === NEMOTRON_EMBED_MODEL ? 2048 : EMBED_DIMENSION;
    if ([...passages, ...queries].some(vector => vector.length !== dimension || vector.some(value => !Number.isFinite(value)))) throw new Error('Invalid vectors');
    const matches = queries.map((query, i) => {
      const scores = passages.map(passage => cosine(query, passage));
      if (scores.some(score => !Number.isFinite(score))) throw new Error('Invalid scores');
      return {query:i, expected:samples.queries[i].expected, top:scores.indexOf(Math.max(...scores)), scores:scores.map(score => Number(score.toFixed(5)))};
    });
    results.push({model, outcome:'delivered', dimension, correct:countCorrectMatches(passages, queries), total:queries.length,
      elapsed_ms:Date.now() - started, ...times, matches, requests:model === NEMOTRON_EMBED_MODEL ? 2 : 9});
  } catch (error) {
    // Preserve failures without exposing credential-bearing SDK errors/provider bodies.
    results.push({model, outcome:'unavailable', phase, elapsed_ms:Date.now() - started, ...times,
      status:typeof error === 'object' && error !== null && 'status' in error ? error.status : null});
  }
}
const receipt = {at:new Date().toISOString(), samples, results, productionMutations:0};
writeFileSync('tmp/embedding-comparison-results.json', JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
