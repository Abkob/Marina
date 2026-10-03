import { describe, expect, it } from 'vitest';
import { assertPlanTransition, canFinishScenario, scenarioEvaluationSchema, scenarioMessage, scenarioStatus, planningScopeKey, planningScopeSchema } from '../../shared/planningState';
import { digest, issuePlanningToken, verifyPlanningToken } from '../../server/services/planning/tokens';
const scope = { root: { kind: 'task' as const, id: 'task' }, resource_ids: ['a','b'], include_subtasks: false, from: '2026-10-06', to: '2026-10-08' };
describe('P01.2 explicit planning states', () => {
  it('P01.2-U01 separates a saved plan, feasibility and completed human work', () => {
    expect(() => assertPlanTransition('draft','current')).not.toThrow();
    expect(() => assertPlanTransition('archived','current')).toThrow();
    expect(() => assertPlanTransition('current','draft')).toThrow();
    expect(scenarioMessage('ready')).toContain('no work has been applied or completed');
  });
  it('P01.2-U02 a terminal result cannot be overwritten by a late success', () => {
    for (const state of ['canceled','superseded','ready','partial','conflicted','failed'] as const) expect(canFinishScenario(state,'ready')).toBe(false);
    expect(canFinishScenario('evaluating','canceled')).toBe(true);
  });
  it('P01.2-U03 distinguishes conditional feasibility, incomplete evidence and provider outcomes', () => {
    const base = { evidence:'complete', feasibility:'feasible', assumptions:[], provider:{kind:'success'} };
    expect(scenarioStatus(scenarioEvaluationSchema.parse(base))).toBe('ready');
    expect(scenarioEvaluationSchema.safeParse({...base,evidence:'partial'}).success).toBe(false);
    expect(scenarioEvaluationSchema.safeParse({...base,assumptions:['A draft can be delivered']}).success).toBe(false);
    expect(scenarioEvaluationSchema.safeParse({...base,feasibility:'conditional'}).success).toBe(false);
    expect(scenarioStatus(scenarioEvaluationSchema.parse({...base,feasibility:'conditional',assumptions:['A draft can be delivered']}))).toBe('ready');
    expect(scenarioStatus(scenarioEvaluationSchema.parse({...base,evidence:'partial',feasibility:'unchecked'}))).toBe('partial');
    expect(scenarioStatus(scenarioEvaluationSchema.parse({...base,feasibility:'unchecked',provider:{kind:'unavailable',retryable:true}}))).toBe('failed');
    expect(scenarioStatus(scenarioEvaluationSchema.parse({...base,feasibility:'unchecked',provider:{kind:'canceled'}}))).toBe('canceled');
  });
});
describe('P01.3 authenticated context and cursor contracts', () => {
  const now = Date.now(); const claims = { purpose:'snapshot' as const,scope:digest(planningScopeKey(scope)),facts:digest('facts'),revision:4 };
  it('P01.3-U01 verifies scope and purpose before treating a token as authority', () => {
    const token=issuePlanningToken(claims,now);
    expect(verifyPlanningToken(token,'snapshot',claims.scope,now).revision).toBe(4);
    expect(() => verifyPlanningToken(token+'x','snapshot',claims.scope,now)).toThrow();
    expect(() => verifyPlanningToken(token,'cursor',claims.scope,now)).toThrow();
    expect(() => verifyPlanningToken(token,'snapshot',claims.scope,now+900001)).toThrow();
  });
  it('P01.3-S01 rejects replay across 50 roots and differently narrowed scopes', () => {
    const token=issuePlanningToken(claims,now);
    for(let i=0;i<50;i++) expect(() => verifyPlanningToken(token,'snapshot',digest(planningScopeKey({...scope,root:{kind:'task',id:`other-${i}`}})),now)).toThrow();
    for(const change of [{resource_ids:['a']},{resource_ids:undefined},{include_subtasks:true},{to:'2026-10-09'}]) expect(() => verifyPlanningToken(token,'snapshot',digest(planningScopeKey({...scope,...change})),now)).toThrow();
    expect(planningScopeKey({...scope,resource_ids:['b','a']})).toBe(planningScopeKey(scope));
    expect(planningScopeSchema.safeParse({...scope,goal_id:'another'}).success).toBe(false);
  });
});
