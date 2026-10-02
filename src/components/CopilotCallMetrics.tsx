import type { ChatCallTrace } from '../types/copilotRuntime';

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Compact details stay inside the optional disclosure on desktop and mobile. */
export function CopilotCallMetrics({ call }: { call: ChatCallTrace }) {
  return <div className="min-w-0 space-y-1 break-words font-mono text-slate-500">
    <p>{call.prompt_chars.toLocaleString()} prompt characters</p>
    {call.system_prompt_chars !== undefined && call.conversation_chars !== undefined && <p>
      {call.system_prompt_chars.toLocaleString()} instructions · {call.conversation_chars.toLocaleString()} conversation / tool results
      {call.continuation_chars ? ` · ${call.continuation_chars.toLocaleString()} continuation characters` : ''}
    </p>}
    {call.input_tokens !== undefined && <p>
      {call.input_tokens.toLocaleString()} input tokens
      {call.cached_input_tokens !== undefined ? ` · ${call.cached_input_tokens.toLocaleString()} cached` : ''}
      {call.output_tokens !== undefined ? ` · ${call.output_tokens.toLocaleString()} output tokens` : ''}
    </p>}
    {(call.first_response_ms !== undefined || call.first_content_ms !== undefined || call.first_reasoning_ms !== undefined) && <p>
      {[
        call.first_response_ms !== undefined ? `Provider response ${seconds(call.first_response_ms)}` : null,
        call.first_reasoning_ms !== undefined ? `Reasoning started ${seconds(call.first_reasoning_ms)}` : null,
        call.first_content_ms !== undefined ? `Answer started ${seconds(call.first_content_ms)}` : null,
      ].filter(Boolean).join(' · ')}
      <span className="block font-sans">Times are measured from request start; they do not isolate provider queue time.</span>
    </p>}
    {call.outcome === 'error' && <p className="text-red-700">Failed{call.error_code ? ` · ${call.error_code}` : ''}</p>}
  </div>;
}
