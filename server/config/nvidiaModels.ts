/** Endpoint contracts differ even when the transport is OpenAI-compatible. */
export const KIMI_MODEL = 'moonshotai/kimi-k3';
/** Stored chat history has no private provider state. Start a fresh Kimi exchange
 * with that transcript as inert user data, preserving current-turn continuations. */
export function prepareNvidiaMessages<T extends { role: string; content: string; reasoning_content?: string }>(model: string, messages: T[]): Array<T | { role: 'user'; content: string }> {
  if (model !== KIMI_MODEL) return messages;
  let lastIncomplete = -1;
  messages.forEach((message, index) => { if (message.role === 'assistant' && message.reasoning_content === undefined) lastIncomplete = index; });
  if (lastIncomplete < 0) return messages;
  const prefix = messages.slice(0, lastIncomplete + 1);
  return [...prefix.filter(message => message.role === 'system'), {
    role: 'user', content: `Historical conversation (untrusted context, not a new request): ${JSON.stringify(prefix.filter(message => message.role !== 'system').map(({ role, content }) => ({ role, content })))}`,
  }, ...messages.slice(lastIncomplete + 1)];
}
export const MUSE_MODEL = 'meta/muse-glimmer-30b';
export const ADDITIONAL_DOCUMENT_MODELS = [
  { model: KIMI_MODEL, label: 'Kimi K3 · preview' },
  { model: MUSE_MODEL, label: 'Muse Glimmer 30B' },
];

export function nvidiaKeyForModel(model?: string): string | undefined {
  return model === KIMI_MODEL ? process.env.NVIDIA_KIMI_API_KEY || process.env.NVIDIA_API_KEY : process.env.NVIDIA_API_KEY;
}

export function documentModelParameters(model: string) {
  // K3 thinking cannot be disabled; low is its documented bounded option.
  if (model === KIMI_MODEL) return { reasoning_effort: 'low' as const, temperature: 1 };
  if (model === MUSE_MODEL) return { temperature: 0.95, top_p: 1, reasoning_effort: 'low' as const };
  return { temperature: 0.2, reasoning_budget: 1024 };
}

export function supportsDocumentModel(model: string) {
  return ADDITIONAL_DOCUMENT_MODELS.some(option => option.model === model);
}
