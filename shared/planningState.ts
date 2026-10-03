import { z } from 'zod';
import { planningId, planningWorkItemSchema, taskReferenceSchema, goalReferenceSchema } from './planningContracts.js';

export const planningRootSchema = z.discriminatedUnion('kind', [taskReferenceSchema, goalReferenceSchema]);
export type PlanningRoot = z.infer<typeof planningRootSchema>;
export const planStateSchema = z.enum(['draft', 'revising', 'current', 'stale', 'archived']);
export type PlanState = z.infer<typeof planStateSchema>;
export const scenarioStateSchema = z.enum(['evaluating', 'ready', 'partial', 'conflicted', 'failed', 'canceled', 'superseded']);
export type ScenarioState = z.infer<typeof scenarioStateSchema>;
const transitions: Record<PlanState, PlanState[]> = {
  draft: ['revising', 'current', 'stale', 'archived'], revising: ['current', 'stale', 'archived'],
  current: ['revising', 'stale', 'archived'], stale: ['revising', 'current', 'archived'], archived: ['draft'],
};
export function assertPlanTransition(from: PlanState, to: PlanState) {
  if (from !== to && !transitions[from].includes(to)) throw new Error(`Invalid plan transition: ${from} to ${to}`);
}
export function canFinishScenario(from: ScenarioState, to: ScenarioState) {
  return from === 'evaluating' && to !== 'evaluating';
}
export const providerOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('success') }).strict(),
  z.object({ kind: z.literal('unavailable'), retryable: z.boolean() }).strict(),
  z.object({ kind: z.literal('canceled') }).strict(),
  z.object({ kind: z.literal('invalid_response'), retryable: z.boolean() }).strict(),
]);
export const scenarioEvaluationSchema = z.object({
  evidence: z.enum(['unknown', 'partial', 'complete', 'stale']),
  feasibility: z.enum(['unchecked', 'feasible', 'conditional', 'infeasible']),
  assumptions: z.array(z.string().min(1).max(500)).max(30), provider: providerOutcomeSchema,
}).strict().superRefine((value, ctx) => {
  if (value.feasibility === 'conditional' && !value.assumptions.length) ctx.addIssue({ code: 'custom', message: 'Conditional feasibility needs assumptions' });
  if (value.feasibility === 'feasible' && (value.assumptions.length || value.evidence !== 'complete' || value.provider.kind !== 'success')) ctx.addIssue({ code: 'custom', message: 'Incomplete or conditional evidence cannot establish unconditional feasibility' });
});
export function scenarioStatus(value: z.infer<typeof scenarioEvaluationSchema>): ScenarioState {
  if (value.provider.kind === 'canceled') return 'canceled';
  if (value.provider.kind !== 'success') return 'failed';
  if (value.evidence === 'stale') return 'superseded';
  if (value.feasibility === 'infeasible') return 'conflicted';
  if (value.evidence !== 'complete' || value.feasibility === 'unchecked') return 'partial';
  return 'ready';
}
export function scenarioMessage(state: ScenarioState) {
  return {
    evaluating: 'Checking this option.', ready: 'Ready to review; no work has been applied or completed.',
    partial: 'Some evidence or checks are missing. Review the open questions.', conflicted: 'This option does not fit the checked constraints. Revise it.',
    failed: 'The evaluation did not finish. Retry when the provider is available.', canceled: 'Canceled. Start a new evaluation to retry.',
    superseded: 'The context changed. Refresh before evaluating again.',
  }[state];
}
export const planContentSchema = z.object({
  outcome: z.string().max(4000), approach: z.string().max(8000),
  questions: z.array(z.string().min(1).max(500)).max(30), decisions: z.array(z.string().min(1).max(500)).max(30),
  work_items: z.array(planningWorkItemSchema).max(100),
}).strict()
  .refine(value => new Set(value.work_items.map(item => item.reference.id)).size === value.work_items.length, 'Duplicate work-item ID')
  .refine(value => new Set(value.work_items.flatMap(item => item.evidence.map(source => source.resource.id))).size <= 100, 'A plan revision can reference at most 100 distinct sources');
export type PlanContent = z.infer<typeof planContentSchema>;
export const emptyPlanContent = (): PlanContent => ({ outcome: '', approach: '', questions: [], decisions: [], work_items: [] });
export const revisionInputSchema = z.object({
  base_version: z.number().int().nonnegative(), idempotency_key: planningId,
  snapshot_token: z.string().min(1).max(12000), content: planContentSchema,
}).strict();
export const planErrorCodeSchema = z.enum(['invalid_payload', 'invalid_reference', 'scope_mismatch', 'snapshot_stale', 'stale_revision', 'idempotency_conflict', 'source_unavailable', 'unsupported_transition', 'provider_unavailable', 'not_found']);
export type PlanErrorCode = z.infer<typeof planErrorCodeSchema>;
export const planningScopeSchema = z.object({
  root: planningRootSchema,
  resource_ids: z.array(planningId).max(20).optional(), include_subtasks: z.boolean().default(false),
  from: z.iso.date(), to: z.iso.date(),
}).strict().refine(value => value.to >= value.from && Date.parse(value.to) - Date.parse(value.from) < 90 * 86400000, 'Use a window of at most 90 days');
export type PlanningScope = z.infer<typeof planningScopeSchema>;
export const planningScopeKey = (scope: PlanningScope) => JSON.stringify([scope.root.kind, scope.root.id, [...new Set(scope.resource_ids ?? [])].sort(), scope.resource_ids !== undefined, scope.include_subtasks, scope.from, scope.to]);
export const planningWriteSetSchema = z.array(z.object({ kind: z.literal('plan'), id: planningId }).strict()).length(1);
export const planningContextResponseSchema = z.object({
  schema_version: z.literal(1), scope: planningScopeSchema,
  root: z.object({ kind: z.enum(['task','goal']), id: planningId, title: z.string() }),
  plan: z.object({ id: planningId, version: z.number().int().nonnegative(), state: planStateSchema, content: planContentSchema,
    origin: z.enum(['user','assistant','system']), forgotten: z.boolean(), redacted_items: z.number().int().nonnegative() }).nullable(),
  evidence: z.object({ resources: z.array(z.object({ id: planningId, title: z.string(), generation: z.number().int().nullable(), status: z.string(), role: z.literal('unspecified') })).max(20), omitted: z.number().int().nonnegative() }),
  calendar_context: z.object({ scope: z.literal('workspace'), from: z.iso.date(), to: z.iso.date(), busy: z.array(z.object({ date: z.iso.date(), start_hour: z.number().finite(), duration_hours: z.number().finite() })).max(200), omitted: z.number().int().nonnegative() }),
  proposed_write_set: z.array(z.object({ kind: z.literal('plan'), id: planningId })).max(1),
  evaluations: z.array(z.object({id:planningId,state:scenarioStateSchema,evaluation:scenarioEvaluationSchema.nullable()})).max(5).default([]),
  snapshot_token: z.string().max(2000), next_cursor: z.string().max(2000).nullable(),
});
export type PlanningContextResponse = z.infer<typeof planningContextResponseSchema>;
