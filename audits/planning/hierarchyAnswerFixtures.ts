import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const HIERARCHY_ANSWER_FIXTURE_VERSION = 1;
export const answerHash = (reply: string) => createHash('sha256').update(reply).digest('hex');
const id = z.string().uuid();
const minutes = z.number().int().min(0).max(60_000_000);
const quote = z.string().min(1).max(4000);
const scope = z.enum(['own', 'subtree']);
const checks = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('quantity'), quote, task_id: id.nullable(), metric: z.enum(['own', 'subtree', 'demand', 'budget', 'shortfall']), minutes: minutes.nullable() }).strict(),
  z.object({ kind: z.literal('option'), quote, allocations: z.array(z.object({ task_id: id, minutes }).strict()).max(20), unused_minutes: minutes.optional(), extra_work: z.boolean(), completes_subtree: z.boolean() }).strict(),
  z.object({ kind: z.literal('scope_cut'), quote, task_id: id, basis: z.enum(['resource_role', 'task_requirement', 'assumption']), conditional: z.boolean() }).strict(),
  z.object({ kind: z.literal('meaning'), quote, task_id: id, basis: z.enum(['title_only', 'unread_resource', 'description', 'conditional']), conditional: z.boolean() }).strict(),
  z.object({ kind: z.literal('completion'), quote, task_id: id, scope, basis: z.enum(['estimate', 'completed_state']), guarantee: z.boolean() }).strict(),
  z.object({ kind: z.literal('coverage'), quote, task_id: id, scope, minutes, coverage: z.enum(['full_estimate', 'partial_estimate']) }).strict(),
]);
export const curatedReviewSchema = z.object({
  source: z.literal('curated_replay_annotations'), reply_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  checks: z.array(checks).min(1).max(40), usefulness: z.enum(['pass', 'fail']), usefulness_reason: quote,
}).strict();
export type CuratedReview = z.infer<typeof curatedReviewSchema>;
export const hierarchyAnswerCaseSchema = z.object({
  id: z.string().regex(/^C\d{2}-[a-z-]+$/), families: z.array(z.string().regex(/^C\d{2}$/)).min(1).max(12),
  failure_ids: z.array(z.string().regex(/^E\d{2}$/)).max(12), prompt: z.string().min(1).max(4000), budget_minutes: minutes.nullable(),
  tasks: z.array(z.object({ id, title: z.string().min(1).max(200), description: z.string().max(2000), parent_task_id: id.nullable(),
    time_rollup_mode: z.enum(['inclusive', 'additive']), estimated_minutes: minutes.nullable(), completed: z.boolean(),
    requirement: z.enum(['required', 'optional', 'unspecified']) }).strict()).min(1).max(100),
  resources: z.array(z.object({ id, task_id: id, title: z.string().min(1).max(200), role: z.enum(['required', 'reference', 'optional']), contents_read: z.boolean() }).strict()).max(10),
  expected: z.object({ demand_minutes: minutes.nullable(), tasks: z.array(z.object({ id, own_minutes: minutes.nullable(), subtree_minutes: minutes.nullable(),
    known_subtotal: minutes, unknown_count: z.number().int().min(0).max(100), completed: z.boolean() }).strict()).min(1).max(100), explanation: quote }).strict(),
  samples: z.array(z.object({ id: z.string().min(1).max(100), origin: z.enum(['historical_public_reply', 'authored_positive', 'authored_negative']),
    source_receipt: z.string().max(200).nullable(), model: z.string().max(120).nullable(), recorded_at: z.iso.datetime().nullable(),
    historical_configuration_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    reply: z.string().min(1).max(20000), expected_verdict: z.enum(['pass', 'fail']), review: curatedReviewSchema,
  }).strict()).min(1).max(12),
}).strict();
export type HierarchyAnswerCase = z.infer<typeof hierarchyAnswerCaseSchema>;
export const hierarchyAnswerSuiteSchema = z.object({
  version: z.literal(HIERARCHY_ANSWER_FIXTURE_VERSION), expected_values: z.literal('hand_authored_independent_of_production_aggregation'),
  observations_provenance: z.literal('reconstructed_synthetic_inputs_not_historical_tool_captures'),
  sources: z.array(z.object({ file: z.string().regex(/^[a-z0-9.-]+\.json$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(10),
  cases: z.array(hierarchyAnswerCaseSchema).min(1).max(30),
  recovery_checks: z.array(z.object({ id: z.string().regex(/^E\d{2}$/), model: z.string().max(120), source_receipt: z.string().max(200),
    observed_at: z.iso.datetime(), historical_status: z.number().int().min(100).max(599), disposition: z.literal('historical_failure_current_recovery_open'),
    required_check: quote }).strict()).max(10),
  transcript_states: z.array(z.object({ state: z.enum(['accepted', 'unverified', 'provider_unavailable', 'canceled', 'unsaved']), accepted_recommendation: z.boolean(),
    saved: z.boolean(), recovery: z.enum(['none', 'retry', 'resume', 'save_retry']), explanation: quote }).strict()).length(5),
}).strict().superRefine((suite, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const sampleIds = suite.cases.flatMap(item => item.samples.map(sample => sample.id));
  if (new Set(sampleIds).size !== sampleIds.length || new Set(suite.cases.map(item => item.id)).size !== suite.cases.length) fail('Duplicate fixture/sample identity');
  if (new Set(suite.transcript_states.map(item => item.state)).size !== 5) fail('Missing transcript state');
  for (const item of suite.cases) {
    const ids = new Set(item.tasks.map(task => task.id));
    if (ids.size !== item.tasks.length || item.expected.tasks.length !== ids.size || new Set(item.expected.tasks.map(task => task.id)).size !== ids.size) fail('Expected tasks must cover each input task exactly once');
    for (const task of item.expected.tasks) if (!ids.has(task.id)) fail('Expected task identity is outside fixture');
    for (const task of item.tasks) if (task.parent_task_id && !ids.has(task.parent_task_id)) fail('Missing fixture parent');
    for (const resource of item.resources) if (!ids.has(resource.task_id)) fail('Resource role must reference its own task');
    for (const sample of item.samples) {
      if (answerHash(sample.reply) !== sample.review.reply_sha256) fail('Review is stale or belongs to another public reply');
      if (sample.source_receipt && !suite.sources.some(source => source.file === sample.source_receipt)) fail('Unregistered historical receipt');
      for (const check of sample.review.checks) {
        if (!sample.reply.includes(check.quote)) fail('Curated claim quote is not present in the public reply');
        if ('task_id' in check && check.task_id && !ids.has(check.task_id)) fail('Claim references another task');
        if (check.kind === 'option' && check.allocations.some(allocation => !ids.has(allocation.task_id))) fail('Option references another task');
      }
    }
  }
  const covered = new Set([...suite.cases.flatMap(item => item.failure_ids), ...suite.recovery_checks.map(item => item.id)]);
  for (let index = 1; index <= 10; index++) if (!covered.has(`E${String(index).padStart(2, '0')}`)) fail('Missing original failure ledger coverage');
});
export type HierarchyAnswerSuite = z.infer<typeof hierarchyAnswerSuiteSchema>;
export function loadHierarchyAnswerFixtures(file = 'audits/planning/fixtures/hierarchyAnswers.json'): HierarchyAnswerSuite {
  const bytes = readFileSync(file);
  if (bytes.length > 200_000) throw new Error('Hierarchy answer fixtures exceed the reviewed byte limit');
  const suite = hierarchyAnswerSuiteSchema.parse(JSON.parse(bytes.toString('utf8')));
  const freeze = (value: any) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(suite); return suite;
}
