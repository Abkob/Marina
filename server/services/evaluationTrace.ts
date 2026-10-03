import { createHash, randomUUID } from 'node:crypto';
import { traceEventSchema, TRACE_EVENT_LIMIT, TRACE_RETENTION_MS, type EvaluationEvent, type EvaluationTrace, type TraceFailure, type TracePhase } from '../../shared/evaluationTrace.js';

export function classifyTraceFailure(error: unknown, phase: TracePhase): TraceFailure {
  const e = error as { code?: string; status?: number; name?: string } | null;
  if (phase === 'persistence') return 'storage_failed';
  if (e?.code === 'NVIDIA_TIMEOUT' || e?.name === 'TimeoutError' || e?.status === 504) return 'provider_timeout';
  if (e?.status === 401 || e?.status === 403) return phase === 'retrieval' ? 'scope_denied' : 'provider_unavailable';
  if (e?.code?.startsWith('NVIDIA_') || e?.status === 429 || (e?.status ?? 0) >= 500) return 'provider_unavailable';
  if (phase === 'proposal') return 'invalid_proposal';
  return phase === 'interpretation' ? 'invalid_response' : 'tool_failed';
}

const TOOL_PHASES: Record<string, TracePhase> = {
  find_resources: 'retrieval', search_documents: 'retrieval', read_document: 'retrieval', inspect_document_page: 'retrieval',
  preview_schedule: 'scheduling', preview_repeating_blocks: 'scheduling', schedule_range: 'scheduling', show_schedule_day: 'scheduling', research_search: 'retrieval',
};
export function phaseForTool(name: string): TracePhase { return TOOL_PHASES[name] ?? 'context'; }

export class EvaluationRecorder {
  private value: EvaluationTrace;
  private started: number;
  constructor(options: { requestId?: string; runId?: string; configuration?: unknown; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.started = this.now();
    this.value = { version: 1, request_id: options.requestId ?? randomUUID(), run_id: options.runId ?? null,
      config_hash: createHash('sha256').update(JSON.stringify(options.configuration ?? { version: 1 })).digest('hex'),
      created_at: new Date(this.started).toISOString(), expires_at: new Date(this.started + TRACE_RETENTION_MS).toISOString(),
      events: [], proposal_ids: [], dropped_events: 0, omitted_sources: 0, storage: 'pending' };
  }
  private now: () => number;
  record(event: Omit<EvaluationEvent, 'id' | 'elapsed_ms'> & { id?: string }): void {
    // Diagnostics must not change the operation's outcome, even on malformed input.
    try {
      if (this.value.events.length >= TRACE_EVENT_LIMIT) { this.value.dropped_events++; return; }
      const parsed = traceEventSchema.safeParse({ ...event, id: event.id ?? randomUUID(), elapsed_ms: Math.max(0, this.now() - this.started) });
      if (!parsed.success) { this.value.dropped_events++; return; }
      if (this.value.events.some(existing => existing.id === parsed.data.id)) return;
      // Reserve room for proposal IDs, counters and metadata under a 24 KiB cap.
      if (Buffer.byteLength(JSON.stringify([...this.value.events, parsed.data])) > 22000) { this.value.dropped_events++; return; }
      this.value.events.push(parsed.data);
    } catch { this.value.dropped_events++; }
  }
  tool(name: string, data: unknown, duration: number): void {
    try {
    const row = data as { evidence?: unknown[]; passages?: unknown[]; resources?: unknown[]; sources?: unknown[]; resource_id?: string } | null;
    const phase = phaseForTool(name);
    const candidates = row?.evidence ?? row?.passages ?? row?.resources ?? row?.sources;
    const sources: NonNullable<EvaluationEvent['sources']> = [];
    // Limit traversal as well as stored output. Never serialize the source bodies.
    for (const item of (Array.isArray(candidates) ? candidates : []).slice(0, 8)) {
      const source = item as { resource_id?: string; id?: string; generation?: number };
      const id = source?.resource_id ?? (name === 'find_resources' ? source?.id : row?.resource_id);
      const parsed = traceEventSchema.shape.sources.unwrap().element.safeParse({ resource_id: id, generation: source?.generation });
      if (parsed.success) sources.push(parsed.data);
    }
    this.value.omitted_sources += Math.max(0, (Array.isArray(candidates) ? candidates.length : 0) - sources.length);
    const noEvidence = phase === 'retrieval' && Array.isArray(candidates) && candidates.length === 0;
    this.record({ phase, status: noEvidence ? 'partial' : 'completed', duration_ms: Math.max(0, Math.round(duration)),
      ...(Array.isArray(candidates) ? { count: candidates.length } : {}), ...(noEvidence ? { failure: 'no_relevant_evidence' } : {}), sources });
    } catch { this.value.dropped_events++; }
  }
  proposals(ids: string[]) { this.value.proposal_ids = [...new Set(ids)].filter(id => traceEventSchema.shape.id.safeParse(id).success).slice(0, 30); }
  storage(status: EvaluationTrace['storage']) { this.value.storage = status; }
  snapshot(): EvaluationTrace { return structuredClone(this.value); }
}
