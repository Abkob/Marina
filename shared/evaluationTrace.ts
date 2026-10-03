import { z } from 'zod';

export const TRACE_EVENT_LIMIT = 48;
export const TRACE_BYTE_LIMIT = 24 * 1024;
export const TRACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const tracePhaseSchema = z.enum(['context', 'retrieval', 'interpretation', 'forecast', 'scheduling', 'proposal', 'apply', 'persistence', 'ui']);
export const traceFailureSchema = z.enum(['provider_timeout', 'provider_unavailable', 'no_relevant_evidence', 'invalid_response', 'invalid_proposal', 'scope_denied', 'tool_failed', 'storage_failed', 'unknown']);
export type TracePhase = z.infer<typeof tracePhaseSchema>;
export type TraceFailure = z.infer<typeof traceFailureSchema>;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// Allowlisted operational facts only: no free-text messages, prompts, headers,
// URLs, tool arguments, source bodies or hidden reasoning enter this contract.
export const traceEventSchema = z.object({
  id: z.string().uuid(), phase: tracePhaseSchema,
  status: z.enum(['completed', 'partial', 'failed', 'skipped']),
  elapsed_ms: integer, duration_ms: integer.optional(), count: integer.optional(),
  failure: traceFailureSchema.optional(), related_id: z.string().uuid().optional(),
  sources: z.array(z.object({ resource_id: z.string().uuid(), generation: integer.optional() }).strip()).max(8).optional(),
}).strip();
export type EvaluationEvent = z.infer<typeof traceEventSchema>;
export const evaluationTraceSchema = z.object({
  version: z.literal(1), request_id: z.string().uuid(), run_id: z.string().uuid().nullable(),
  config_hash: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.string().datetime(), expires_at: z.string().datetime(),
  events: z.array(traceEventSchema).max(TRACE_EVENT_LIMIT),
  proposal_ids: z.array(z.string().uuid()).max(30),
  dropped_events: integer, omitted_sources: integer,
  storage: z.enum(['pending', 'saved', 'unavailable']),
}).strip();
export type EvaluationTrace = z.infer<typeof evaluationTraceSchema>;

export function readEvaluationTrace(value: unknown): EvaluationTrace | null {
  const parsed = evaluationTraceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const TRACE_PHASE_LABELS: Record<TracePhase, string> = {
  context: 'Loading context', retrieval: 'Checking sources', interpretation: 'Preparing an answer',
  forecast: 'Estimating remaining work', scheduling: 'Checking available time', proposal: 'Checking proposed changes',
  apply: 'Applying changes', persistence: 'Saving the conversation', ui: 'Displaying the result',
};
export const TRACE_FAILURE_LABELS: Record<TraceFailure, string> = {
  provider_timeout: 'The model timed out', provider_unavailable: 'The model service was unavailable',
  no_relevant_evidence: 'This search returned no evidence', invalid_response: 'The model response could not be read',
  invalid_proposal: 'The proposed changes did not pass validation', scope_denied: 'The selected context was not accessible',
  tool_failed: 'A context check failed', storage_failed: 'Saving failed', unknown: 'The phase did not finish',
};
