/** Operational measurements only: no prompt text or private model reasoning. */
export interface ChatCallTrace {
  model: string;
  provider: 'gemini-cloud' | 'nvidia-cloud' | 'ollama-local' | 'ollama-cloud';
  duration_ms: number;
  prompt_chars: number;
  fallback_used: boolean;
  system_prompt_chars?: number;
  conversation_chars?: number;
  continuation_chars?: number;
  /** Elapsed from request start, not independent durations or exact queue time. */
  first_response_ms?: number;
  first_reasoning_ms?: number;
  first_content_ms?: number;
  outcome?: 'error';
  error_code?: string;
  /** Provider-reported usage only; missing is unknown, not zero. */
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
}
