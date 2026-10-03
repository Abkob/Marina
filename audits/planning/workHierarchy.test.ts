import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertPlanningTestDatabase, validatePlanningTestUrl } from './databaseFixtures';
import { loadWorkAccounting } from '../../server/services/workAccounting';
import { beginScenario, createPlan, finishScenario, getPlanningContext } from '../../server/services/planning/planRepository';
import type { PlanningScope } from '../../shared/planningState';
vi.mock('../../server/services/obsidianVaultSync.js', async original => ({...await original<typeof import('../../server/services/obsidianVaultSync.js')>(),scheduleObsidianVaultSync:vi.fn()}));

describe.skipIf(!process.env.DATABASE_URL_TEST)('P03.2 hierarchy accounting (PostgreSQL and HTTP)', () => {
  let pool:pg.Pool; let server:typeof import('../../server/__tests__/setup');
  const ids:string[]=[];
  const task=async(estimate:number|null=60,parent:string|null=null,mode='additive'):Promise<string>=>{
    const id=randomUUID();ids.push(id);
    await pool.query("INSERT INTO tasks(id,title,parent_task_id,time_rollup_mode,estimated_minutes,due_date,created_at,updated_at) VALUES ($1,'Hierarchy test',$2,$3,$4,'2099-01-20',NOW()::text,NOW()::text)",[id,parent,mode,estimate]);return id;
  };
  const read=async(id:string)=>(await fetch(`${server.baseUrl}/api/tasks/${id}/work-accounting`)).json();
  const forecast=async(id:string,minutes:number)=>{const before=await read(id);return fetch(`${server.baseUrl}/api/tasks/${id}/work-accounting`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes,expected:before.versions})});};
  const snapshot=()=>loadWorkAccounting('2099-01-01','2099-01-31','UTC',undefined,new Date('2099-01-01T00:00:00Z'));
  beforeAll(async()=>{
    pool=new pg.Pool({connectionString:validatePlanningTestUrl(process.env.DATABASE_URL_TEST,process.env.PLANNING_TEST_DB),max:4});
    const client=await pool.connect();try{await assertPlanningTestDatabase(client);}finally{client.release();}
    server=await import('../../server/__tests__/setup');await server.startTestServer();
  });
  afterEach(async()=>{
    await pool.query('DELETE FROM edges WHERE source_id=ANY($1) OR target_id=ANY($1)',[ids]);
    await pool.query('DELETE FROM work_sessions WHERE task_id=ANY($1)',[ids]);
    await pool.query('DELETE FROM tasks WHERE id=ANY($1)',[ids.splice(0)]);
  });
  afterAll(async()=>{await server?.stopTestServer();await pool?.end();const db=await import('../../server/db');await db.getPool().end();});
  it('returns included totals and a residual rather than duplicating children',async()=>{
    const p=await task(120);await task(60,p,'inclusive');await task(60,p,'inclusive');
    expect(await read(p)).toMatchObject({work:{remaining_minutes:0},hierarchy:{remaining_minutes:120,child_count:2,residual_estimated_minutes:0}});
  });
  it('keeps additive parent work executable in both scheduling entry points',async()=>{
    const p=await task(30);const a=await task(60,p);const b=await task(60,p);
    const {loadSchedulerInputs}=await import('../../server/routes/ai');const chat=await loadSchedulerInputs(35);
    expect(chat.tasks.filter(t=>[p,a,b].includes(t.id)).reduce((sum,t)=>sum+t.estimated_minutes,0)).toBe(150);
    const preview=await(await fetch(`${server.baseUrl}/api/ai/schedule-preview`)).json();
    expect(preview.task_lookup[p].work_accounting).toEqual(chat.work_accounting[p]);
    expect((await read(p)).hierarchy.remaining_minutes).toBe(150);
  });
  it('retains the completed child allocation in the parent original budget',async()=>{
    const p=await task(120);const a=await task(60,p,'inclusive');await task(60,p,'inclusive');
    await pool.query("UPDATE tasks SET completed=true,status='done' WHERE id=$1",[a]);
    expect((await read(p)).hierarchy).toMatchObject({remaining_minutes:60,residual_estimated_minutes:0});
  });
  it('makes unknown child effort partial and never replaces it with zero',async()=>{
    const p=await task(120);await task(null,p,'inclusive');await task(60,p,'inclusive');
    expect((await read(p)).hierarchy).toMatchObject({remaining_minutes:null,known_remaining_minutes:60});
  });
  it('invalidates the ancestor forecast for mode changes, child insertion and deletion',async()=>{
    const p=await task(120);const c=await task(60,p,'inclusive');await forecast(p,30);
    await pool.query("UPDATE tasks SET time_rollup_mode='additive' WHERE id=$1",[c]);
    expect((await read(p)).work.remaining_state).toBe('stale_forecast');
    await forecast(p,30);const other=await task(10,c);
    expect((await read(p)).work.remaining_state).toBe('stale_forecast');
    await forecast(p,30);await pool.query('DELETE FROM tasks WHERE id=$1',[other]);
    expect((await read(p)).work.remaining_state).toBe('stale_forecast');
  });
  it('invalidates both old and new ancestor branches without moving session ownership',async()=>{
    const a=await task(120);const b=await task(120);const c=await task(60,a,'inclusive');
    await pool.query("INSERT INTO work_sessions(id,task_id,minutes,started_at,created_at) VALUES ($1,$2,20,NOW()::text,NOW()::text)",[randomUUID(),c]);
    await forecast(a,10);await forecast(b,10);await pool.query('UPDATE tasks SET parent_task_id=$2 WHERE id=$1',[c,b]);
    const state=await snapshot();expect(state.accounting.get(a)?.remaining_state).toBe('stale_forecast');expect(state.accounting.get(b)?.remaining_state).toBe('stale_forecast');
    expect(state.hierarchy.summaries.get(a)?.logged_minutes).toBe(0);expect(state.hierarchy.summaries.get(b)?.logged_minutes).toBe(20);
    expect((await pool.query('SELECT task_id FROM work_sessions WHERE task_id=$1',[c])).rows).toEqual([{task_id:c}]);
  });
  it('does not invalidate parent residual forecasts for a child timestamp or log correction',async()=>{
    const p=await task(90);const c=await task(60,p,'inclusive');await forecast(p,30);
    await pool.query('UPDATE tasks SET updated_at=NOW()::text WHERE id=$1',[c]);
    await pool.query("INSERT INTO work_sessions(id,task_id,minutes,started_at,created_at) VALUES ($1,$2,20,NOW()::text,NOW()::text)",[randomUUID(),c]);
    expect((await read(p))).toMatchObject({work:{remaining_basis:'forecast'},hierarchy:{remaining_minutes:70,logged_minutes:20}});
  });
  it('rejects self and ancestor cycles at HTTP and database boundaries',async()=>{
    const p=await task();const c=await task(60,p);
    for(const parent of [p,c]) {
      const response=await fetch(`${server.baseUrl}/api/tasks/${p}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({parent_task_id:parent})});
      expect(response.status).toBe(409);expect((await response.json()).error).toMatch(/ancestor|cycle|descendant/i);
    }
    await expect(pool.query('UPDATE tasks SET parent_task_id=id WHERE id=$1',[c])).rejects.toMatchObject({code:'23514'});
  });
  it('serializes competing HTTP reparenting so two writers cannot form a cycle',async()=>{
    const a=await task();const b=await task();
    const results=await Promise.all([[a,b],[b,a]].map(([id,parent])=>fetch(`${server.baseUrl}/api/tasks/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({parent_task_id:parent})})));
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  });
  it('reads malformed legacy cycles as invalid without hanging or scheduling them',async()=>{
    const a=await task(),b=await task();const client=await pool.connect();
    try {
      await client.query('BEGIN');await client.query('ALTER TABLE tasks DISABLE TRIGGER task_hierarchy_guard');
      await client.query('UPDATE tasks SET parent_task_id=CASE WHEN id=$1 THEN $2 ELSE $1 END WHERE id=ANY($3)',[a,b,[a,b]]);
      await client.query('ALTER TABLE tasks ENABLE TRIGGER task_hierarchy_guard');await client.query('COMMIT');
    } catch(error){await client.query('ROLLBACK');throw error;} finally {client.release();}
    const result=await read(a);expect(result.work.remaining_state).toBe('invalid');expect(result.hierarchy.issues).toContain('hierarchy_cycle');
    const newcomer=await task();
    await expect(pool.query('UPDATE tasks SET parent_task_id=$2 WHERE id=$1',[newcomer,a])).rejects.toMatchObject({code:'23514'});
    const {loadSchedulerInputs}=await import('../../server/routes/ai');
    expect((await loadSchedulerInputs(35)).tasks.some(t=>t.id===a||t.id===b)).toBe(false);
  });
  it('expands parent blockers consistently for residual work and child prerequisites',async()=>{
    const before=await task();const p=await task(30);const c=await task(60,p);const next=await task();
    for(const [source,target] of [[before,p],[p,next]])await pool.query("INSERT INTO edges(id,source_id,source_type,target_id,target_type,relationship,created_at) VALUES ($1,$2,'task',$3,'task','blocks',NOW()::text)",[randomUUID(),source,target]);
    const {loadSchedulerInputs}=await import('../../server/routes/ai');const chat=await loadSchedulerInputs(35);
    expect(chat.tasks.find(t=>t.id===c)?.blocker_ids).toEqual([before]);
    expect(chat.tasks.find(t=>t.id===next)?.blocker_ids.slice().sort()).toEqual([p,c].sort());
  });
  it('bounds the HTTP breakdown while the total includes all children',async()=>{
    const p=await task(null);for(let i=0;i<25;i++)await task(10,p);
    const result=await read(p);expect(result.hierarchy).toMatchObject({remaining_minutes:250,child_count:25,children_omitted:5});expect(result.hierarchy.children).toHaveLength(20);
  });
  it('reapplying M033 preserves current forecasts and hierarchy versions',async()=>{
    const p=await task(90);await task(60,p,'inclusive');await forecast(p,30);const before=await read(p);
    await pool.query(await readFile('server/migrations/033-work-hierarchy.sql','utf8'));
    const after=await read(p);expect(after.versions).toEqual(before.versions);expect(after.work.remaining_basis).toBe('forecast');
  });
  it('supersedes in-flight planning results after mode changes and reparenting',async()=>{
    const p=await task(120);const other=await task(120);const child=await task(60,p,'inclusive');
    const scope:PlanningScope={root:{kind:'task',id:p},from:'2099-01-01',to:'2099-01-20',include_subtasks:true};
    const plan=await createPlan(scope.root);
    for(const change of ["time_rollup_mode='additive'", `parent_task_id='${other}'`]) {
      const context=await getPlanningContext(scope);const id=await beginScenario(plan.id,scope,context.snapshot_token);
      await pool.query(`UPDATE tasks SET ${change} WHERE id=$1`,[child]);
      expect(await finishScenario(id,{evidence:'complete',feasibility:'feasible',assumptions:[],provider:{kind:'success'}})).toEqual({state:'superseded',accepted:true});
    }
  });
});
