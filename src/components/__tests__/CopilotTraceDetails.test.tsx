// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CopilotTraceDetails } from '../CopilotTraceDetails';
import { CopilotSources } from '../CopilotSources';
import { EvaluationRecorder } from '../../../server/services/evaluationTrace';
import { planningFixtures, planningUiStates } from '../../../audits/planning/fixtures';

afterEach(cleanup);
describe('P00 response diagnostics and reusable source fixtures', () => {
  it('P00.3-F01 shows useful phases and secondary identifiers with a comfortable target', () => {
    const trace = new EvaluationRecorder(); trace.record({ phase: 'context', status: 'completed', duration_ms: 20 }); trace.storage('saved');
    const { container } = render(<CopilotTraceDetails value={trace.snapshot()} />);
    expect(screen.getByRole('region', { name: 'Response phases' })).toHaveTextContent('Loading context');
    const control = screen.getByText('Diagnostic identifiers'); expect(control.className).toContain('min-h-11');
    expect(container.querySelector('details')).not.toHaveAttribute('open'); fireEvent.click(control);
    expect(container.querySelector('details')).toHaveAttribute('open'); expect(screen.getByText(/Request:/)).toHaveTextContent(trace.snapshot().request_id);
  });
  it('P00.3-F02 reports partial or unsaved diagnostics without claiming the task save failed', () => {
    const trace = new EvaluationRecorder(); for (let i = 0; i < 60; i++) trace.record({ phase: 'context', status: 'completed' });
    trace.storage('unavailable'); render(<CopilotTraceDetails value={trace.snapshot()} />);
    expect(screen.getByText(/Diagnostics are partial/)).toBeVisible();
    expect(screen.getByText(/does not establish whether your changes were saved/)).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(8);
  });
  it.each([null, { version: 500 }, new EvaluationRecorder({ now: () => 0 }).snapshot()])('P00.3-F03 safely handles absent, invalid and expired traces (%#)', value => {
    render(<CopilotTraceDetails value={value} />); expect(screen.getByText(/unavailable or have expired/)).toBeVisible();
  });
  it.each(planningUiStates.filter(state => state.evidence.length))('P00.1-F02 reuses $state evidence in the actual source cards', state => {
    render(<CopilotSources citations={state.evidence.map(evidence => ({ entity_type: 'resource', entity_id: evidence.resource_id,
      title: planningFixtures[1].resources[0].title, matched_via: ['fixture read'], excerpt: evidence.excerpt, excerpt_kind: evidence.kind,
      page_start: evidence.page, page_end: evidence.page, source_url: `/api/resources/blob/${evidence.resource_id}`, source_tool: 'read_document' }))} />);
    expect(screen.getByRole('article', { name: 'Source: Synthetic Introduction to Algebra' })).toBeVisible();
    expect(screen.getByText(state.evidence[0].excerpt)).toBeVisible();
  });
});
