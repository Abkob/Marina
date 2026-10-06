import {NEMOTRON_EMBED_MODEL, NEMOTRON_EMBED_DIMENSION} from '../../shared/embeddingTrial.js';

export class EmbeddingTrialError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}
const ENDPOINT = 'https://integrate.api.nvidia.com/v1/embeddings';
const MAX_RESPONSE_BYTES = 512 * 1024;

/** Bounded hosted query/passage adapter. Callers keep model-specific indexes isolated. */
export async function nemotronEmbeddings(
  texts: string[], inputType: 'query' | 'passage', options: {signal?: AbortSignal; deadlineMs?: number} = {},
): Promise<number[][]> {
  if (!['query', 'passage'].includes(inputType) || !Array.isArray(texts) || !texts.length || texts.length > 8
    || texts.some(text => typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 3000)) {
    throw new EmbeddingTrialError('Embedding trial input exceeds its limits.', 400);
  }
  const key = process.env.NVIDIA_EMBED_API_KEY || process.env.NVIDIA_API_KEY;
  if (!key) throw new EmbeddingTrialError('Configure the NVIDIA connection to try this search model.', 503);
  const remaining = Math.min(30_000, (options.deadlineMs ?? Date.now() + 30_000) - Date.now());
  if (remaining <= 0) throw new EmbeddingTrialError('The search model trial timed out.', 504);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), remaining);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new EmbeddingTrialError('The search model trial was interrupted.', 504));
      signal.addEventListener('abort', onAbort, {once: true});
    });
    // Use the hosted API's passage/query contract. It adds the prompts itself.
    const response = await Promise.race([fetch(ENDPOINT, {
      method: 'POST', redirect: 'error', signal,
      headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'NVCF-POLL-SECONDS': '10'},
      body: JSON.stringify({model: NEMOTRON_EMBED_MODEL, input: texts, input_type: inputType, encoding_format: 'float', truncate: 'NONE'}),
    }), aborted]);
    if (!response.ok || response.status === 202) {
      void response.body?.cancel().catch(() => {});
      const status = response.status === 202 ? 503 : response.status;
      throw new EmbeddingTrialError(`The NVIDIA search model is unavailable (HTTP ${status}).`, status);
    }
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_RESPONSE_BYTES || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new EmbeddingTrialError('The search model returned an invalid response.');
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const row = await Promise.race([reader.read(), aborted]);
      if (row.done) break;
      bytes += row.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new EmbeddingTrialError('The search model response exceeded its limit.');
      chunks.push(row.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if ((body.model !== undefined && body.model !== NEMOTRON_EMBED_MODEL) || !Array.isArray(body.data) || body.data.length !== texts.length) {
      throw new EmbeddingTrialError('The search model returned incompatible embeddings.');
    }
    const vectors: number[][] = Array(texts.length);
    for (const row of body.data) {
      if (!Number.isSafeInteger(row.index) || row.index < 0 || row.index >= texts.length || vectors[row.index]
        || !Array.isArray(row.embedding) || row.embedding.length !== NEMOTRON_EMBED_DIMENSION
        || row.embedding.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value))
        || !row.embedding.some((value: number) => value !== 0)
        || !Number.isFinite(row.embedding.reduce((sum: number, value: number) => sum + value * value, 0))
        || row.embedding.reduce((sum: number, value: number) => sum + value * value, 0) === 0) {
        throw new EmbeddingTrialError('The search model returned incompatible embeddings.');
      }
      vectors[row.index] = row.embedding;
    }
    signal.throwIfAborted();
    return vectors;
  } catch (error) {
    if (error instanceof EmbeddingTrialError) throw error;
    // Provider bodies, connection exceptions and credentials never reach the UI.
    throw new EmbeddingTrialError(signal.aborted ? 'The search model trial was interrupted.' : 'The search model trial could not finish.', signal.aborted ? 504 : 502);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (reader) { void reader.cancel().catch(() => {}); }
  }
}
