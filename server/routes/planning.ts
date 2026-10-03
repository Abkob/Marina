import { Router } from 'express';
import { z } from 'zod';
import { assertBoundedPayload, planningId } from '../../shared/planningContracts.js';
import { planningRootSchema, planningScopeSchema, revisionInputSchema } from '../../shared/planningState.js';
import { changePlanLifecycle, createPlan, getPlanningContext, planHistory, readPlanRevision, savePlanRevision } from '../services/planning/planRepository.js';
import { PlanningError } from '../services/planning/errors.js';
import { rateLimit } from '../utils/rateLimit.js';
const router = Router();
function scopeFromQuery(query: Record<string,unknown>) {
  const include = query.include_subtasks === undefined ? false : z.enum(['true','false']).parse(query.include_subtasks)==='true';
  const ids = query.resource_ids === undefined ? undefined : z.string().max(4020).parse(query.resource_ids).split(',').filter(Boolean);
  return planningScopeSchema.parse({root:{kind:query.root_kind,id:query.root_id},from:query.from,to:query.to,include_subtasks:include,...(ids!==undefined?{resource_ids:ids}:{})});
}
router.use((_req,res,next) => { res.setHeader('Cache-Control','no-store'); next(); });
router.use(rateLimit(120,60_000,'planning'));
router.use((req,res,next) => {
  try { assertBoundedPayload(req.body); next(); }
  catch { res.status(400).json({ error: 'Planning input exceeds validation limits.', code: 'invalid_payload', retryable: false }); }
});
router.get('/context', async (req,res) => {
  const scope = scopeFromQuery(req.query);
  const cursor = req.query.cursor === undefined ? undefined : z.string().max(2000).parse(req.query.cursor);
  res.json(await getPlanningContext(scope,cursor));
});
router.post('/plans', async (req,res) => {
  const input = z.object({ root: planningRootSchema }).strict().parse(req.body);
  res.json(await createPlan(input.root));
});
router.post('/plans/:id/revisions', async (req,res) => {
  const input = z.object({ scope: planningScopeSchema, revision: revisionInputSchema }).strict().parse(req.body);
  res.json(await savePlanRevision(planningId.parse(req.params.id), input.scope, input.revision));
});
router.post('/plans/:id/lifecycle', async (req,res) => {
  const input = z.object({ operation: z.enum(['archive','restore','forget']), base_version: z.number().int().nonnegative(), idempotency_key: planningId }).strict().parse(req.body);
  res.json(await changePlanLifecycle(planningId.parse(req.params.id),input.operation,input.base_version,input.idempotency_key));
});
router.get('/plans/:id/history', async (req,res) => {
  const before = req.query.before === undefined ? undefined : z.coerce.number().int().positive().max(2147483647).parse(req.query.before);
  res.json(await planHistory(planningId.parse(req.params.id),before));
});
router.get('/plans/:id/revisions/:version', async (req,res) => {
  const scope=scopeFromQuery(req.query);
  const version=z.coerce.number().int().nonnegative().max(2147483647).parse(req.params.version);
  res.json(await readPlanRevision(planningId.parse(req.params.id),version,scope));
});
router.use((error: unknown,_req: unknown,res: any,next: (error: unknown)=>void) => {
  if (error instanceof PlanningError) return res.status(error.status).json({ error: error.message, code: error.code, retryable: error.retryable });
  if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid planning request. Review the fields and try again.', code: 'invalid_payload', retryable: false });
  next(error);
});
export { router as planningRouter };
