// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CopilotCallMetrics } from '../../components/CopilotCallMetrics';
const call = { model: 'moonshotai/kimi-k3', provider: 'nvidia-cloud' as const, duration_ms: 41000, prompt_chars: 20002, fallback_used: false };
describe('Copilot request measurements', () => {
  it('distinguishes instructions from conversation, provider usage and cumulative timing', () => {
    render(<CopilotCallMetrics call={{ ...call, system_prompt_chars: 20000, conversation_chars: 2, first_response_ms: 32000, first_reasoning_ms: 32500, first_content_ms: 40000, input_tokens: 6000, cached_input_tokens: 0, output_tokens: 40 }} />);
    expect(screen.getByText(/20,000 instructions · 2 conversation/)).toBeInTheDocument();
    expect(screen.getByText(/6,000 input tokens · 0 cached · 40 output/)).toBeInTheDocument();
    expect(screen.getByText(/Provider response 32.0s · Reasoning started 32.5s · Answer started 40.0s/)).toBeInTheDocument();
    expect(screen.getByText(/do not isolate provider queue time/)).toBeInTheDocument();
  });
  it('does not invent timing or zero token usage for historical messages', () => {
    const { container } = render(<CopilotCallMetrics call={call} />);
    expect(container.textContent).toBe('20,002 prompt characters');
  });
  it('shows a timed-out attempt without implying an answer was generated', () => {
    render(<CopilotCallMetrics call={{ ...call, first_response_ms: 32000, outcome: 'error', error_code: 'NVIDIA_ENDPOINT_TIMEOUT' }} />);
    expect(screen.getByText(/Failed · NVIDIA_ENDPOINT_TIMEOUT/)).toBeInTheDocument();
    expect(screen.queryByText(/Answer started/)).not.toBeInTheDocument();
  });
});
