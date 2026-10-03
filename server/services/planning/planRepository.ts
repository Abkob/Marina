import crypto from 'node:crypto';
import type pg from 'pg';
import { transaction } from '../../db.js';
import { assertBoundedPayload } from '../../../shared/planningContracts.js';
import { assertPlanTransition, emptyPlanContent, planContentSchema, planningScopeSchema, scenarioEvaluationSchema, scenarioStatus, type PlanContent, type PlanningRoot, type PlanningScope, type PlanState } from '../../../shared/planningState.js';
import { PlanningError } from './errors.js';
import { digest, verifyPlanningToken } from './tokens.js';
import { planningScopeKey } from '../../../shared/planningState.js';
import { contextTokens, planningFacts, redactUnavailableEvidence, requireRoot, validateSnapshot, verifiedPlanEvidence } from './context.js';
import { activeTaskSql } from '../../utils/archiveVisibility.js';

type PlanRow = { id: string; task_id: string | null; goal_id: string | null; head_version: number; state: PlanState; forgotten_at: string | null; updated_at: string };
const rootOf = (plan: PlanRow): PlanningRoot => plan.task_id ? { kind: 'task', id: plan.task_id } : { kind: 'goal', id: plan.goal_id! };
async function rowForRoot(client: pg.PoolClient, root: PlanningRoot) {
  return (await client.query<PlanRow>(`SELECT * FROM planning_plans WHERE ${root.kind === 'task' ? 'task_id' : 'goal_id'}=$1`, [root.id])).rows[0];
}
async function lockPlan(client: pg.PoolClient, id: string) {
  const row = (await client.query<PlanRow>('SELECT * FROM planning_plans WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!row) throw new PlanningError('not_found', 'Plan not found.', 404);
  await requireRoot(client, rootOf(row)); return row;
}
async function currentRevision(client: pg.PoolClient, plan: PlanRow) {
  return (await client.query('SELECT * FROM planning_plan_revisions WHERE plan_id=$1 AND version=$2', [plan.id, plan.head_version])).rows[0];
}
export async function getPlanningContext(scope: PlanningScope, cursor?: string) {
  const claims = cursor ? verifyPlanningToken(cursor, 'cursor', digest(planningScopeKey(scope))) : null;
  return transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const facts = await planningFacts(client, scope, claims?.after);
    const plan = await rowForRoot(client, scope.root);
    if (claims && (claims.facts !== facts.facts || claims.revision !== (plan?.head_version ?? 0))) throw new PlanningError('snapshot_stale', 'The resource list changed. Reload its first page.', 409, true);
    const revision = plan ? await currentRevision(client, plan) : null;
    const content = revision ? planContentSchema.parse(revision.content) : null;
    const visible = content ? redactUnavailableEvidence(content, await verifiedPlanEvidence(client,scope,content)) : null;
    const state = plan?.state === 'current' && (revision?.facts_hash !== facts.facts || visible?.redacted) ? 'stale' : plan?.state;
    const evaluations = plan ? (await client.query(`SELECT id,base_version,state,result,facts_hash,scope,
      updated_at<NOW()-INTERVAL '7 days' AS expired,
      state='evaluating' AND updated_at<NOW()-INTERVAL '30 minutes' AS timed_out
      FROM planning_scenarios WHERE plan_id=$1 ORDER BY created_at DESC,id LIMIT 5`, [plan.id])).rows.map(row => {
      const superseded=state==='stale' || plan.state==='archived' || row.base_version!==plan.head_version
        || row.facts_hash!==facts.facts || planningScopeKey(row.scope)!==planningScopeKey(scope) || row.expired;
      return {id:row.id,state:superseded?'superseded':row.timed_out?'failed':row.state,evaluation:superseded||row.timed_out?null:row.result};
    }) : [];
    return {
      schema_version: 1, scope, root: { ...scope.root, title: facts.root.title },
      plan: plan ? { id: plan.id, version: plan.head_version, state, content: visible!.content, origin: revision!.origin, forgotten: Boolean(plan.forgotten_at), redacted_items: visible!.redacted } : null,
      evidence: { resources: facts.resources, omitted: facts.resources_omitted },
      calendar_context: { scope: 'workspace', from: scope.from, to: scope.to, busy: facts.calendar, omitted: facts.calendar_omitted },
      proposed_write_set: plan ? [{ kind: 'plan', id: plan.id }] : [],
      evaluations,
      ...contextTokens(scope, facts, plan?.head_version ?? 0, claims?.after),
    };
  });
}
export async function createPlan(root: PlanningRoot) {
  return transaction(async client => {
    await requireRoot(client, root);
    const id = crypto.randomUUID();
    const inserted = await client.query(`INSERT INTO planning_plans(id,task_id,goal_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [id, root.kind === 'task' ? root.id : null, root.kind === 'goal' ? root.id : null]);
    if (inserted.rows.length) await client.query(`INSERT INTO planning_plan_revisions(plan_id,version,content,origin,operation,idempotency_key,request_hash) VALUES ($1,0,$2,'system','create','create',$3)`, [id, JSON.stringify(emptyPlanContent()), digest(root)]);
    const plan = await rowForRoot(client, root); return { id: plan!.id, version: plan!.head_version, state: plan!.state, created: Boolean(inserted.rows.length) };
  });
}
async function replay(client: pg.PoolClient, planId: string, key: string, hash: string) {
  const row = (await client.query('SELECT version,request_hash,redacted_at FROM planning_plan_revisions WHERE plan_id=$1 AND idempotency_key=$2', [planId, key])).rows[0];
  if (row && row.request_hash !== hash) throw new PlanningError('idempotency_conflict', 'This retry key was already used for a different edit. Review before submitting another edit.');
  return row ? { id: planId, version: row.version as number, replayed: true, redacted: Boolean(row.redacted_at) } : null;
}
async function append(client: pg.PoolClient, plan: PlanRow, args: { content: PlanContent; operation: string; origin: string; key: string; hash: string; facts?: string; state: PlanState }) {
  assertPlanTransition(plan.state, args.state);
  const version = plan.head_version + 1;
  await client.query(`INSERT INTO planning_plan_revisions(plan_id,version,previous_version,content,origin,operation,idempotency_key,request_hash,facts_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [plan.id, version, plan.head_version, JSON.stringify(args.content), args.origin, args.operation, args.key, args.hash, args.facts ?? null]);
  const changed = await client.query(`UPDATE planning_plans SET head_version=$2,state=$3,updated_at=NOW(),archived_at=CASE WHEN $3='archived' THEN NOW() ELSE NULL END WHERE id=$1 AND head_version=$4 RETURNING id`, [plan.id, version, args.state, plan.head_version]);
  if (!changed.rowCount) throw new PlanningError('stale_revision', 'The plan changed while saving. Your draft has been preserved.', 409, true);
  await client.query("UPDATE planning_scenarios SET state='superseded',result=NULL,updated_at=NOW() WHERE plan_id=$1 AND state IN ('evaluating','ready','partial','conflicted')", [plan.id]);
  return { id: plan.id, version, replayed: false };
}
export async function savePlanRevision(id: string, scope: PlanningScope, input: { base_version: number; idempotency_key: string; snapshot_token: string; content: PlanContent }, origin: 'user' | 'assistant' = 'user') {
  assertBoundedPayload(input); const content = planContentSchema.parse(input.content);
  const hash = digest({ base: input.base_version, content, operation: 'edit', origin, scope: planningScopeKey(scope) });
  // Authentication of the token precedes any repository reads; idempotent
  // retries may bypass only freshness, never signature or root binding.
  verifyPlanningToken(input.snapshot_token, 'snapshot', digest(planningScopeKey(scope)));
  return transaction(async client => {
    const plan = await lockPlan(client, id);
    if (JSON.stringify(rootOf(plan)) !== JSON.stringify(scope.root)) throw new PlanningError('scope_mismatch', 'The selected task or goal does not own this plan.');
    const prior = await replay(client, id, input.idempotency_key, hash); if (prior) return prior;
    if (plan.head_version !== input.base_version) throw new PlanningError('stale_revision', 'A newer plan revision exists. Your draft is still available.', 409, true);
    if (plan.state === 'archived') throw new PlanningError('unsupported_transition', 'Restore this plan before editing it.');
    const facts = await validateSnapshot(client, scope, input.snapshot_token, plan.head_version);
    const visible = redactUnavailableEvidence(content, await verifiedPlanEvidence(client,scope,content));
    if (visible.redacted) throw new PlanningError('source_unavailable', 'Some work uses unavailable or older source evidence. Refresh those sources before saving.');
    const taskIds=[...new Set(content.work_items.flatMap(item=>item.task?[item.task.id]:[]))];
    if(taskIds.length){
      const {rows}=await client.query(`WITH RECURSIVE selected AS (
        SELECT t.id FROM tasks t WHERE ($2='task' AND t.id=$1) OR ($2='goal' AND (t.goal_id=$1 OR t.milestone_id IN (SELECT id FROM goal_milestones WHERE goal_id=$1)))
        UNION SELECT child.id FROM tasks child JOIN selected parent ON child.parent_task_id=parent.id WHERE $2='goal' OR $3
      ) SELECT id FROM selected WHERE id=ANY($4::text[]) AND ${activeTaskSql('id')}`,[scope.root.id,scope.root.kind,scope.include_subtasks,taskIds]);
      if(rows.length!==taskIds.length)throw new PlanningError('scope_mismatch','A work item refers to a task outside this plan.');
    }
    return append(client, plan, { content, operation: 'edit', origin, key: input.idempotency_key, hash, facts: facts.facts, state: 'current' });
  });
}
export async function changePlanLifecycle(id: string, operation: 'archive' | 'restore' | 'forget', base: number, key: string) {
  return transaction(async client => {
    const plan = await lockPlan(client, id); const hash = digest({ base, operation });
    const prior = await replay(client, id, key, hash); if (prior) return prior;
    if (plan.head_version !== base) throw new PlanningError('stale_revision', 'The plan changed. Reload before changing its lifecycle.', 409, true);
    if ((operation === 'restore' || operation === 'forget') && plan.state !== 'archived') throw new PlanningError('unsupported_transition', 'Archive the plan before restoring or forgetting it.');
    const revision = await currentRevision(client, plan);
    if (operation === 'forget') {
      await client.query('UPDATE planning_plan_revisions SET content=$2,redacted_at=NOW() WHERE plan_id=$1', [id, JSON.stringify(emptyPlanContent())]);
      await client.query('UPDATE planning_scenarios SET result=NULL,state=\'superseded\',updated_at=NOW() WHERE plan_id=$1', [id]);
      await client.query('UPDATE planning_plans SET forgotten_at=NOW() WHERE id=$1', [id]);
    }
    return append(client, plan, { content: operation === 'forget' ? emptyPlanContent() : planContentSchema.parse(revision.content), operation, origin: 'user', key, hash, state: operation === 'restore' ? 'draft' : 'archived' });
  });
}
export async function planHistory(id: string, before = 2147483647) {
  return transaction(async client => {
    const plan = await lockPlan(client, id);
    const { rows } = await client.query('SELECT version,previous_version,origin,operation,created_at,redacted_at FROM planning_plan_revisions WHERE plan_id=$1 AND version<$2 ORDER BY version DESC LIMIT 21', [plan.id, before]);
    return { revisions: rows.slice(0,20), next_before: rows.length > 20 ? rows[19].version : null };
  });
}
export async function readPlanRevision(id: string, version: number, scope: PlanningScope) {
  return transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const facts = await planningFacts(client, scope); const plan = await rowForRoot(client,scope.root);
    if (!plan || plan.id !== id) throw new PlanningError('scope_mismatch','This revision does not belong to the selected task or goal.');
    const row = (await client.query('SELECT version,content,origin,operation,redacted_at FROM planning_plan_revisions WHERE plan_id=$1 AND version=$2',[id,version])).rows[0];
    if (!row) throw new PlanningError('not_found','Revision not found.',404);
    const content=planContentSchema.parse(row.content);
    const visible=redactUnavailableEvidence(content,await verifiedPlanEvidence(client,scope,content));
    return {...row,content:visible.content,redacted_items:visible.redacted};
  });
}
/** Foundation for future evaluators; no public route fabricates an evaluation. */
export async function beginScenario(planId: string, scope: PlanningScope, snapshotToken: string, requestKey=crypto.randomUUID()) {
  const claims=verifyPlanningToken(snapshotToken,'snapshot',digest(planningScopeKey(scope)));
  return transaction(async client => {
    const plan = await lockPlan(client, planId);
    if (JSON.stringify(rootOf(plan))!==JSON.stringify(scope.root))throw new PlanningError('scope_mismatch','The selected scope does not own this plan.');
    if (plan.state === 'archived' || plan.head_version !== claims.revision) throw new PlanningError('stale_revision', 'Refresh this plan before evaluating.');
    const facts=await validateSnapshot(client,scope,snapshotToken,plan.head_version);
    const id = crypto.randomUUID();
    await client.query('INSERT INTO planning_scenarios(id,plan_id,base_version,request_key,scope,facts_hash) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(plan_id,base_version,request_key) DO NOTHING', [id, planId,plan.head_version,requestKey,JSON.stringify(scope),facts.facts]);
    const row=(await client.query('SELECT id,scope,facts_hash FROM planning_scenarios WHERE plan_id=$1 AND base_version=$2 AND request_key=$3',[planId,plan.head_version,requestKey])).rows[0];
    if(planningScopeKey(row.scope)!==planningScopeKey(scope)||row.facts_hash!==facts.facts)throw new PlanningError('idempotency_conflict','This evaluation key was already used with another context.');
    return row.id as string;
  });
}
export async function finishScenario(id: string, value: unknown) {
  assertBoundedPayload(value); const result = scenarioEvaluationSchema.parse(value);
  return transaction(async client => {
    const found = (await client.query('SELECT plan_id FROM planning_scenarios WHERE id=$1', [id])).rows[0];
    if (!found) throw new PlanningError('not_found', 'Evaluation not found.', 404);
    const plan = await lockPlan(client, found.plan_id);
    const row = (await client.query('SELECT * FROM planning_scenarios WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (row.state !== 'evaluating') return { state: row.state, accepted: false };
    const facts=await planningFacts(client,planningScopeSchema.parse(row.scope));
    const state = plan.head_version !== row.base_version || plan.state === 'archived' || facts.facts!==row.facts_hash ? 'superseded' : scenarioStatus(result);
    await client.query('UPDATE planning_scenarios SET state=$2,result=$3,updated_at=NOW() WHERE id=$1', [id, state, state === 'superseded' ? null : JSON.stringify(result)]);
    return { state, accepted: true };
  });
}
export async function prunePlanningArtifacts(limit = 100) {
  return transaction(async client => {
    const { rows } = await client.query(`WITH expired AS (
      SELECT id FROM planning_scenarios WHERE (state='evaluating' AND updated_at<NOW()-INTERVAL '30 minutes') OR (result IS NOT NULL AND updated_at<NOW()-INTERVAL '7 days')
      ORDER BY updated_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE planning_scenarios s SET result=NULL,state=CASE WHEN s.state='evaluating' THEN 'failed' ELSE 'superseded' END,updated_at=NOW() FROM expired WHERE s.id=expired.id RETURNING s.id`, [Math.max(1, Math.min(100, Math.trunc(limit)))]);
    return rows.length;
  });
}
