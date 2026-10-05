import { answerHash, curatedReviewSchema, type CuratedReview, type HierarchyAnswerCase } from './hierarchyAnswerFixtures.js';
import { z } from 'zod';

export const ANSWER_DIMENSIONS = ['transport', 'protocol', 'facts', 'scope', 'arithmetic', 'grounding', 'usefulness', 'side_effects', 'persistence'] as const;
export type AnswerDimension = typeof ANSWER_DIMENSIONS[number];
export type Verdict = { status: 'pass' | 'fail' | 'unavailable' | 'not_applicable'; reasons: string[] };
export type AnswerVerdicts = Record<AnswerDimension, Verdict>;
const verdictSchema = z.object({ status: z.enum(['pass','fail','unavailable','not_applicable']), reasons: z.array(z.string().min(1).max(4000)).min(1).max(50) }).strict();
export const answerVerdictsSchema = z.object(Object.fromEntries(ANSWER_DIMENSIONS.map(key => [key, verdictSchema]))).strict();

/** An offline, curated replay oracle. It does NOT extract arbitrary prose or certify new model replies. */
export function evaluateHierarchyReply(fixture: HierarchyAnswerCase, result: unknown, options: { transport?: boolean; writes?: number; review?: CuratedReview } = {}): AnswerVerdicts {
  const verdicts = Object.fromEntries(ANSWER_DIMENSIONS.map(key => [key, { status: 'unavailable', reasons: ['Required evidence or semantic review was not supplied.'] }])) as AnswerVerdicts;
  const set = (key: AnswerDimension, status: Verdict['status'], reason: string) => { verdicts[key] = { status, reasons: [reason] }; };
  set('transport', options.transport === false ? 'fail' : 'pass', options.transport === false ? 'Provider did not return a complete result.' : 'A result was returned; this says nothing about its advice.');
  set('persistence', 'not_applicable', 'Synthetic read-only conversation; no application save is attempted.');
  if (options.writes !== undefined) set('side_effects', options.writes === 0 ? 'pass' : 'fail', `${options.writes} application writes observed.`);
  const body = result as { reply?: unknown; actions?: unknown } | null;
  if (!body || typeof body.reply !== 'string' || !body.reply.trim() || !Array.isArray(body.actions)) {
    set('protocol', 'fail', 'Missing complete public reply/actions envelope.'); return verdicts;
  }
  set('protocol', 'pass', 'Public reply/actions envelope is readable.');
  const supplied = options.review ?? fixture.samples.find(sample => sample.review.reply_sha256 === answerHash(body.reply as string))?.review;
  const parsed = curatedReviewSchema.safeParse(supplied);
  if (!parsed.success || parsed.data.reply_sha256 !== answerHash(body.reply)
    || parsed.data.checks.some(check => !body.reply!.toString().includes(check.quote))) return verdicts;
  const review = parsed.data;
  for (const key of ['facts', 'scope', 'arithmetic', 'grounding'] as const) set(key, 'pass', 'Curated reply claims agree with hand-authored fixture facts.');
  set('usefulness', review.usefulness, review.usefulness_reason);
  const fail = (key: AnswerDimension, reason: string) => {
    if (verdicts[key].status !== 'fail') verdicts[key] = { status: 'fail', reasons: [] };
    verdicts[key].reasons.push(reason);
  };
  const expected = new Map(fixture.expected.tasks.map(task => [task.id, task]));
  const input = new Map(fixture.tasks.map(task => [task.id, task]));
  for (const check of review.checks) {
    if ('task_id' in check && check.task_id && !expected.has(check.task_id)) { fail('scope', 'Claim references a task outside the selected fixture.'); continue; }
    if (check.kind === 'quantity') {
      const task = check.task_id ? expected.get(check.task_id) : undefined;
      const value = check.metric === 'own' ? task?.own_minutes : check.metric === 'subtree' ? task?.subtree_minutes
        : check.metric === 'demand' ? fixture.expected.demand_minutes : check.metric === 'budget' ? fixture.budget_minutes
          : fixture.expected.demand_minutes === null || fixture.budget_minutes === null ? null : Math.max(0, fixture.expected.demand_minutes - fixture.budget_minutes);
      if (value === undefined || check.minutes !== value) fail('facts', `Wrong ${check.metric} quantity or unknown treated as a number.`);
    } else if (check.kind === 'option') {
      const byTask = new Map<string, number>();
      for (const allocation of check.allocations) byTask.set(allocation.task_id, (byTask.get(allocation.task_id) ?? 0) + allocation.minutes);
      const used = [...byTask.values()].reduce((sum, value) => sum + value, 0);
      const unused = fixture.budget_minutes === null ? null : fixture.budget_minutes - used;
      if (unused !== null && (unused < 0 || check.unused_minutes !== undefined && check.unused_minutes !== unused || check.extra_work && unused <= 0)) fail('arithmetic', 'Option overspends or invents spare time after spending the allowance.');
      if (check.allocations.some(allocation => !expected.has(allocation.task_id))) fail('scope', 'Allocation targets an unrelated task.');
      if (check.completes_subtree) fail('grounding', 'Allocating estimated minutes is not proof the deliverable will be complete.');
    } else if (check.kind === 'scope_cut') {
      if (!check.conditional && (check.basis === 'resource_role' || input.get(check.task_id)?.requirement !== 'optional')) fail('scope', 'Resource optionality or an unconfirmed assumption cannot remove task work.');
    } else if (check.kind === 'meaning') {
      if (!check.conditional && (check.basis === 'title_only' || check.basis === 'unread_resource'
        || check.basis === 'description' && !input.get(check.task_id)?.description)) fail('grounding', 'Unspecified task purpose or unread source requirements were invented.');
    } else if (check.kind === 'completion') {
      if (check.guarantee || check.basis !== 'completed_state' || !expected.get(check.task_id)?.completed) fail('grounding', 'Estimates do not prove completion or guarantee a deadline.');
    } else {
      const task = expected.get(check.task_id)!;
      const remaining = check.scope === 'own' ? task.own_minutes : task.subtree_minutes;
      if (remaining === null || (check.coverage === 'full_estimate') !== (check.minutes >= remaining)) fail('arithmetic', 'Estimated coverage is misstated; actual completion remains a different fact.');
    }
  }
  return verdicts;
}

export function answerAccepted(verdicts: AnswerVerdicts) {
  return ANSWER_DIMENSIONS.every(key => verdicts[key].status === 'pass' || verdicts[key].status === 'not_applicable');
}
export function replayGate(suite: { version: number; cases: HierarchyAnswerCase[] }, rows: Array<{ sample_id: string; verdicts: AnswerVerdicts }>) {
  const expected = suite.cases.flatMap(item => item.samples);
  const reasons: string[] = [];
  if (suite.version !== 1) reasons.push('Stale fixture version.');
  if (rows.length !== expected.length || new Set(rows.map(row => row.sample_id)).size !== rows.length) reasons.push('Missing or duplicate replay result.');
  for (const sample of expected) {
    const actual = rows.find(row => row.sample_id === sample.id);
    if (!actual) { reasons.push(`Missing ${sample.id}.`); continue; }
    if (!answerVerdictsSchema.safeParse(actual.verdicts).success) { reasons.push(`Malformed verdict for ${sample.id}.`); continue; }
    const unavailable = ANSWER_DIMENSIONS.some(key => actual.verdicts[key]?.status === 'unavailable' || !actual.verdicts[key]);
    if (unavailable) reasons.push(`Unreviewed/unavailable result for ${sample.id}.`);
    if (answerAccepted(actual.verdicts) !== (sample.expected_verdict === 'pass')) reasons.push(`Unexpected acceptance/rejection of ${sample.id}.`);
  }
  return { pass: reasons.length === 0, reasons, replay_samples: expected.length, planning_release_qualified: false as const };
}

export function verifyReplayReceipt(receipt: unknown, fixtureFingerprint: string, suite: { version: number; cases: HierarchyAnswerCase[] }) {
  const parsed = z.object({ version:z.literal(1),run_id:z.string().uuid(),fixture_version:z.literal(1),fixture_sha256:z.literal(fixtureFingerprint),
    kind:z.literal('offline_curated_replay'),verdicts:z.array(z.object({sample_id:z.string(),verdicts:answerVerdictsSchema})).max(300) }).safeParse(receipt);
  if (!parsed.success) return { pass:false,reasons:['Missing, malformed or stale replay receipt.'] };
  return replayGate(suite, parsed.data.verdicts as Array<{sample_id:string;verdicts:AnswerVerdicts}>);
}
