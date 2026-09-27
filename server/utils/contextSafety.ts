// Production guard — called before every AI provider call.
// Throws if the context contains data that must never leave the server.

export function assertSafeAIContext(ctx: unknown, maxChars = 50_000): void {
  const str = JSON.stringify(ctx);

  // Raw journal text must never appear in AI context
  if (/"raw_text"\s*:/.test(str)) {
    throw new Error('Context safety: raw_text field present — journal raw text must not reach the AI');
  }
  // Resource chunk arrays must not appear in AI context
  if (/"resource_chunks"\s*:/.test(str)) {
    throw new Error('Context safety: resource_chunks present — chunk content must not reach the AI');
  }
  // Vector arrays: 3+ consecutive floats with decimal points
  if (/\[\s*-?\d+\.\d+,\s*-?\d+\.\d+,\s*-?\d+\.\d+/.test(str)) {
    throw new Error('Context safety: vector array present — embeddings must not reach the AI');
  }
  // Embedding text must not appear in AI context
  if (/"embedding_text"\s*:/.test(str)) {
    throw new Error('Context safety: embedding_text field present — raw embedding text must not reach the AI');
  }
  // Archived goals leaking (archived_at set to a real date)
  if (/"archived_at"\s*:\s*"\d{4}/.test(str)) {
    throw new Error('Context safety: archived_at present — archived goals must be filtered out');
  }
  if (str.length >= maxChars) {
    throw new Error(`Context safety: context too large (${str.length} chars, limit ${maxChars.toLocaleString('en-US')})`);
  }
}
