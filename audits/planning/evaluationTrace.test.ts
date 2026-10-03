import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { EvaluationRecorder, classifyTraceFailure } from '../../server/services/evaluationTrace.js';
import { runCopilotConversation } from '../../server/services/copilotConversation.js';
import { readEvaluationTrace, TRACE_EVENT_LIMIT } from '../../shared/evaluationTrace.js';
import { fixtureId } from './fixtures.js';

describe('P00.3 bounded evaluator diagnostics', () => {
  it('P00.3-U01 distinguishes provider timeout from an empty evidence result', () => {
    const trace = new EvaluationRecorder();
    trace.tool('search_documents', { evidence: [] }, 5);
    trace.record({ phase: 'interpretation', status: 'failed', failure: classifyTraceFailure({ code: 'NVIDIA_TIMEOUT' }, 'interpretation') });
    expect(trace.snapshot().events.map(event => event.failure)).toEqual(['no_relevant_evidence', 'provider_timeout']);
    expect(trace.snapshot().events[0].status).toBe('partial');
  });
  it('P00.3-U02 allowlists fields instead of logging secrets, arguments or source bodies', () => {
    const trace = new EvaluationRecorder({ configuration: { model: 'synthetic', secret: 'test-secret-never-store' } });
    const unsafe = { phase: 'context' as const, status: 'completed' as const, Authorization: 'Bearer test-secret-never-store',
      headers: { 'x-api-key': 'test-secret-never-store' }, body: 'PRIVATE DOCUMENT', reasoning: 'PRIVATE REASONING' };
    trace.record(unsafe);
    trace.tool('search_documents', { passages: [{ resource_id: fixtureId(12), generation: 2, content: 'PRIVATE DOCUMENT', url: 'https://private.example?token=test-secret-never-store' }] }, 1);
    const encoded = JSON.stringify(trace.snapshot());
    for (const secret of ['test-secret-never-store', 'PRIVATE DOCUMENT', 'PRIVATE REASONING', 'Authorization', 'headers', 'private.example']) expect(encoded).not.toContain(secret);
    expect(trace.snapshot().events[1].sources).toEqual([{ resource_id: fixtureId(12), generation: 2 }]);
  });
  it('P00.3-U03 deduplicates stable event IDs and rejects invalid operational fields', () => {
    const trace = new EvaluationRecorder(); const id = randomUUID();
    trace.record({ id, phase: 'context', status: 'completed' }); trace.record({ id, phase: 'context', status: 'completed' });
    trace.record({ phase: 'context', status: 'completed', duration_ms: Infinity });
    expect(trace.snapshot().events).toHaveLength(1); expect(trace.snapshot().dropped_events).toBe(1);
    expect(readEvaluationTrace({ ...trace.snapshot(), config_hash: 'Bearer secret' })).toBeNull();
  });
  it('P00.3-U04 preserves explicit elapsed time, expiry and snapshot isolation', () => {
    let now = Date.parse('2026-10-06T09:00:00Z'); const trace = new EvaluationRecorder({ now: () => now }); now += 100;
    trace.record({ phase: 'forecast', status: 'skipped' });
    const value = trace.snapshot(); expect(value.events[0].elapsed_ms).toBe(100);
    value.events.length = 0; expect(trace.snapshot().events).toHaveLength(1);
    expect(Date.parse(value.expires_at) - Date.parse(value.created_at)).toBe(604800000);
  });
  it('P00.3-U05 classifies storage errors by phase and tolerates malformed telemetry', () => {
    expect(classifyTraceFailure({ status: 500 }, 'persistence')).toBe('storage_failed');
    expect(classifyTraceFailure({ status: 500 }, 'interpretation')).toBe('provider_unavailable');
    const trace = new EvaluationRecorder();
    const malformed = { get evidence(): never { throw new Error('Synthetic getter failure'); } };
    expect(() => trace.tool('read_document', malformed, 1)).not.toThrow();
    expect(trace.snapshot().dropped_events).toBe(1);
    trace.tool('read_document', { evidence: 'invalid shape' }, 1);
    expect(readEvaluationTrace(trace.snapshot())).not.toBeNull();
  });
  it('P00.3-S01 caps 10,000 events and oversized evidence without copying document content', () => {
    const trace = new EvaluationRecorder();
    trace.tool('search_documents', { passages: Array.from({ length: 10000 }, () => ({ resource_id: fixtureId(12), content: 'x'.repeat(10000) })) }, 2);
    for (let i = 0; i < 10000; i++) trace.record({ phase: 'context', status: 'completed' });
    const result = trace.snapshot(); expect(result.events).toHaveLength(TRACE_EVENT_LIMIT);
    expect(result.dropped_events).toBe(10001 - TRACE_EVENT_LIMIT); expect(result.omitted_sources).toBe(9992);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(24000);
  });
  it('P00.3-I01 exercises the actual conversation loop with context and source events', async () => {
    const trace = new EvaluationRecorder(); let calls = 0;
    const result = await runCopilotConversation({
      evaluation: trace, clock: { today: '2026-10-06', time: '12:00', timezone: 'Asia/Beirut' }, turns: [{ role: 'user', content: 'Read the selected evidence.' }],
      tools: { read_document: { description: 'Read a known page', parameters: z.object({ resource_id: z.string(), page: z.number() }),
        execute: async () => ({ data: { resource_id: fixtureId(12), title: 'Synthetic book', passages: [{ chunk_id: fixtureId(13), page_start: 94, page_end: 94, passage: 'Synthetic fact', generation: 1 }] } }) } },
      complete: async () => ++calls === 1 ? JSON.stringify({ tool_calls: [{ id: 'read', name: 'read_document', arguments: { resource_id: fixtureId(12), page: 94 } }] }) : JSON.stringify({ reply: 'The synthetic fact is available.' }),
    });
    expect(result.reply).toContain('synthetic fact');
    expect(trace.snapshot().events.map(event => event.phase)).toEqual(['interpretation', 'retrieval', 'interpretation']);
    expect(trace.snapshot().events[1].sources?.[0].generation).toBe(1);
  });
  it('P00.3-I02 retains the actual provider failure without logging its message', async () => {
    const trace = new EvaluationRecorder();
    const failure = Object.assign(new Error('Bearer test-secret-provider-body'), { code: 'NVIDIA_TIMEOUT', retryable: false });
    await expect(runCopilotConversation({ evaluation: trace, turns: [{ role: 'user', content: 'hi' }],
      clock: { today: '2026-10-06', time: '12:00', timezone: 'Asia/Beirut' }, tools: {}, complete: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(trace.snapshot().events[0].failure).toBe('provider_timeout');
    expect(JSON.stringify(trace.snapshot())).not.toContain('test-secret');
  });
});
