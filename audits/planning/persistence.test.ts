import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { assertPlanningTestDatabase, validatePlanningTestUrl } from './databaseFixtures';
import { emptyPlanContent, type PlanningScope } from '../../shared/planningState';
import { beginScenario, changePlanLifecycle, createPlan, finishScenario, getPlanningContext, planHistory, prunePlanningArtifacts, readPlanRevision, savePlanRevision } from '../../server/services/planning/planRepository';

vi.mock('../../server/services/obsidianVaultSync.js', async original => ({ ...await original<typeof import('../../server/services/obsidianVaultSync.js')>(), scheduleObsidianVaultSync: vi.fn() }));
// Drive originals are covered separately; these real DB fixtures have no remote originals.
describe.skipIf(!process.env.DATABASE_URL_TEST)('P01/P02 persistent plan acceptance (real PostgreSQL)', () => {
  let pool: pg.Pool; let server: typeof import('../../server/__tests__/setup');
  const tasks: string[]=[]; const goals: string[]=[]; const resources:string[]=[];
  const scopeFor = (id:string):PlanningScope => ({ root:{kind:'task',id},from:'2026-10-06',to:'2026-10-08',include_subtasks:false });
  const task = async (goalId?: string) => {
    const id=randomUUID(); tasks.push(id);
    await pool.query("INSERT INTO tasks(id,title,goal_id,created_at,updated_at) VALUES ($1,'Synthetic P02 work',$2,NOW()::text,NOW()::text)",[id,goalId??null]); return id;
  };
  const setupPlan=async()=>{ const root=await task(); const scope=scopeFor(root); const plan=await createPlan(scope.root); const context=await getPlanningContext(scope); return {root,scope,plan,context}; };
  const edit=(context:Awaited<ReturnType<typeof getPlanningContext>>,outcome='Complete a report',key=randomUUID())=>({base_version:context.plan!.version,idempotency_key:key,snapshot_token:context.snapshot_token,content:{...emptyPlanContent(),outcome}});
  const request=(path:string,body?:unknown)=>fetch(`${server.baseUrl}/api/planning/${path}`,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  beforeAll(async()=>{
    pool=new pg.Pool({connectionString:validatePlanningTestUrl(process.env.DATABASE_URL_TEST,process.env.PLANNING_TEST_DB),max:4});
    const client=await pool.connect();try{await assertPlanningTestDatabase(client);}finally{client.release();}
    server=await import('../../server/__tests__/setup');await server.startTestServer();
  });
  afterEach(async()=>{
    await pool.query('DELETE FROM tasks WHERE id=ANY($1)',[tasks.splice(0)]);
    await pool.query('DELETE FROM goals WHERE id=ANY($1)',[goals.splice(0)]);
    await pool.query('DELETE FROM resources WHERE id=ANY($1)',[resources.splice(0)]);
  });
  afterAll(async()=>{await server?.stopTestServer();await pool?.end();const db=await import('../../server/db');await db.getPool().end();});

  it('P02.1-I01 reads without creating a plan and lazily races 20 creates into one root',async()=>{
    const id=await task();const scope=scopeFor(id);
    expect((await getPlanningContext(scope)).plan).toBeNull();
    expect((await pool.query('SELECT id FROM planning_plans WHERE task_id=$1',[id])).rows).toEqual([]);
    const plans=await Promise.all(Array.from({length:20},()=>createPlan(scope.root)));
    expect(new Set(plans.map(p=>p.id)).size).toBe(1);expect(plans.filter(p=>p.created)).toHaveLength(1);
    const history=await planHistory(plans[0].id);expect(history.revisions).toHaveLength(1);expect(history.revisions[0].version).toBe(0);
    const invalid=await request('plans',{root:{kind:'resource',id}});expect(invalid.status).toBe(400);
  });
  it('P02.1-U01 concrete foreign keys and the one-root constraint reject invalid SQL',async()=>{
    const id=await task();
    await expect(pool.query('INSERT INTO planning_plans(id) VALUES ($1)',[randomUUID()])).rejects.toMatchObject({code:'23514'});
    await expect(pool.query('INSERT INTO planning_plans(id,task_id) VALUES ($1,$2)',[randomUUID(),randomUUID()])).rejects.toMatchObject({code:'23503'});
    const plan=await createPlan({kind:'task',id});
    await expect(pool.query('UPDATE planning_plans SET head_version=999 WHERE id=$1',[plan.id])).rejects.toMatchObject({code:'23503'});
  });
  it('P01/P02-I03 real HTTP saves/reloads revisions and rejects unsupported client state',async()=>{
    const {plan,scope,context}=await setupPlan();const input=edit(context);
    const saved=await request(`plans/${plan.id}/revisions`,{scope,revision:input});expect(saved.status).toBe(200);
    const loaded=await request(`context?${new URLSearchParams({root_kind:scope.root.kind,root_id:scope.root.id,from:scope.from,to:scope.to})}`);
    expect(loaded.headers.get('cache-control')).toBe('no-store');expect((await loaded.json()).plan.content.outcome).toBe('Complete a report');
    const malformedScope=await request(`context?${new URLSearchParams({root_kind:scope.root.kind,root_id:scope.root.id,from:scope.from,to:scope.to,include_subtasks:'maybe'})}`);expect(malformedScope.status).toBe(400);
    const invalid=await request(`plans/${plan.id}/revisions`,{scope,revision:{...input,state:'current',origin:'assistant'}});expect(invalid.status).toBe(400);
    const history=await request(`plans/${plan.id}/history`);expect((await history.json()).revisions.map((row:any)=>row.version)).toEqual([1,0]);
    const old=await request(`plans/${plan.id}/revisions/0?${new URLSearchParams({root_kind:scope.root.kind,root_id:scope.root.id,from:scope.from,to:scope.to})}`);expect((await old.json()).content.outcome).toBe('');
  });
  it('P02.2-I01 concurrent edits cannot lose acknowledged work; identical retry is idempotent',async()=>{
    const {plan,scope,context}=await setupPlan();
    const a=edit(context,'First proposal'),b=edit(context,'Other proposal');
    const outcomes=await Promise.allSettled([savePlanRevision(plan.id,scope,a),savePlanRevision(plan.id,scope,b)]);
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(outcomes.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'stale_revision'}});
    const winner=outcomes[0].status==='fulfilled'?a:b;
    expect(await savePlanRevision(plan.id,scope,winner)).toMatchObject({version:1,replayed:true});
    await expect(savePlanRevision(plan.id,scope,{...winner,content:{...winner.content,outcome:'Changed payload'}})).rejects.toMatchObject({code:'idempotency_conflict'});
    expect((await getPlanningContext(scope)).plan?.content.outcome).toBe(winner.content.outcome);
    expect((await planHistory(plan.id)).revisions.map(r=>r.version)).toEqual([1,0]);
  });
  it('P02.2-S01 100 simultaneous edits yield one revision and 99 explicit conflicts',async()=>{
    const {plan,scope,context}=await setupPlan();
    const outcomes=await Promise.allSettled(Array.from({length:100},(_,i)=>savePlanRevision(plan.id,scope,edit(context,`Attempt ${i}`))));
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(outcomes.filter(r=>r.status==='rejected').every(r=>(r as PromiseRejectedResult).reason.code==='stale_revision')).toBe(true);
    expect((await planHistory(plan.id)).revisions).toHaveLength(2);
  },60000);
  it('P02.2-I02 a database failure after revision insertion rolls back head and history',async()=>{
    const {plan,scope,context}=await setupPlan(); const client=await pool.connect();
    // A transaction-scoped trigger simulates a crash/failure at the head update.
    const name=`p02_fault_${randomUUID().replaceAll('-','')}`;
    try {
      await client.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${plan.id}' THEN RAISE EXCEPTION 'synthetic head failure'; END IF; RETURN NEW; END $$`);
      await client.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON planning_plans FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      await expect(savePlanRevision(plan.id,scope,edit(context))).rejects.toThrow('synthetic head failure');
      expect((await pool.query('SELECT head_version FROM planning_plans WHERE id=$1',[plan.id])).rows[0].head_version).toBe(0);
      expect((await planHistory(plan.id)).revisions).toHaveLength(1);
    }finally{await client.query(`DROP TRIGGER IF EXISTS ${name} ON planning_plans`);await client.query(`DROP FUNCTION IF EXISTS ${name}()`);client.release();}
    expect(await savePlanRevision(plan.id,scope,edit(context))).toMatchObject({version:1});
  });
  it('P01.3-I01 forged, changed-root and stale snapshots cannot save a revision',async()=>{
    const {plan,scope,context}=await setupPlan();const other=await task();
    await expect(savePlanRevision(plan.id,scope,{...edit(context),snapshot_token:context.snapshot_token+'x'})).rejects.toMatchObject({code:'snapshot_stale'});
    await expect(savePlanRevision(plan.id,scopeFor(other),edit(context))).rejects.toMatchObject({code:'snapshot_stale'});
    await pool.query("UPDATE tasks SET title='Changed work' WHERE id=$1",[scope.root.id]);
    await expect(savePlanRevision(plan.id,scope,edit(context))).rejects.toMatchObject({code:'snapshot_stale'});
    expect((await planHistory(plan.id)).revisions).toHaveLength(1);
  });
  it('P01.3-I02 selected documents require saved root relationships; all calendar commitments remain',async()=>{
    const {scope}=await setupPlan();const r=randomUUID();resources.push(r);
    await pool.query("INSERT INTO resources(id,title,created_at) VALUES ($1,'Synthetic specification',NOW()::text)",[r]);
    await expect(getPlanningContext({...scope,resource_ids:[r]})).rejects.toMatchObject({code:'scope_mismatch'});
    const edge=randomUUID(); await pool.query("INSERT INTO edges(id,source_id,source_type,target_id,target_type,relationship,created_at) VALUES ($1,$2,'resource',$3,'task','attached_to',NOW()::text)",[edge,r,scope.root.id]);
    const event=randomUUID();
    try {
      await pool.query("INSERT INTO events(id,title,week_start,day_index,start_hour,duration_hours,created_at,updated_at) VALUES ($1,'Unrelated appointment','2026-10-05',1,11,1,NOW()::text,NOW()::text)",[event]);
      const context=await getPlanningContext({...scope,resource_ids:[r]});
      expect(context.evidence.resources).toEqual([expect.objectContaining({id:r,role:'unspecified'})]);
      expect(context.calendar_context.busy).toContainEqual({date:'2026-10-06',start_hour:11,duration_hours:1});
      expect(JSON.stringify(context.evidence)).not.toContain('Unrelated appointment');
    }finally{await pool.query('DELETE FROM events WHERE id=$1',[event]);await pool.query('DELETE FROM edges WHERE id=$1',[edge]);}
  });
  it('P01.2-S01 cancellation wins against late success and revisions supersede pending evaluations',async()=>{
    const {plan,scope,context}=await setupPlan(); const id=await beginScenario(plan.id,scope,context.snapshot_token);
    const canceled={evidence:'unknown',feasibility:'unchecked',assumptions:[],provider:{kind:'canceled'}};
    expect(await finishScenario(id,canceled)).toEqual({state:'canceled',accepted:true});
    const success={evidence:'complete',feasibility:'feasible',assumptions:[],provider:{kind:'success'}};
    const late=await Promise.all(Array.from({length:100},()=>finishScenario(id,success)));
    expect(late.every(row=>row.state==='canceled'&&!row.accepted)).toBe(true);
    const pending=await beginScenario(plan.id,scope,context.snapshot_token);await savePlanRevision(plan.id,scope,edit(context));
    expect(await finishScenario(pending,success)).toEqual({state:'superseded',accepted:false});
  },60000);
  it.each([
    ['ready',{evidence:'complete',feasibility:'feasible',assumptions:[],provider:{kind:'success'}}],
    ['partial',{evidence:'partial',feasibility:'unchecked',assumptions:[],provider:{kind:'success'}}],
    ['conflicted',{evidence:'complete',feasibility:'infeasible',assumptions:[],provider:{kind:'success'}}],
    ['failed',{evidence:'unknown',feasibility:'unchecked',assumptions:[],provider:{kind:'unavailable',retryable:true}}],
    ['canceled',{evidence:'unknown',feasibility:'unchecked',assumptions:[],provider:{kind:'canceled'}}],
    ['superseded',{evidence:'stale',feasibility:'unchecked',assumptions:[],provider:{kind:'success'}}],
  ])('P01.2-I01 %s persists and reloads without changing human work',async(state,evaluation)=>{
    const {plan,scope,context,root}=await setupPlan();const key=randomUUID();
    const id=await beginScenario(plan.id,scope,context.snapshot_token,key);
    expect(await beginScenario(plan.id,scope,context.snapshot_token,key)).toBe(id);
    expect((await getPlanningContext(scope)).evaluations[0].state).toBe('evaluating');
    expect(await finishScenario(id,evaluation)).toEqual({state,accepted:true});
    expect((await getPlanningContext(scope)).evaluations[0].state).toBe(state);
    expect((await pool.query('SELECT completed FROM tasks WHERE id=$1',[root])).rows[0].completed).toBe(false);
    expect((await planHistory(plan.id)).revisions).toHaveLength(1);
  });
  it('P01.2-S02 100 interleaved result/cancel events have exactly one terminal writer',async()=>{
    const {plan,scope,context}=await setupPlan();const id=await beginScenario(plan.id,scope,context.snapshot_token);
    const outcomes=await Promise.all(Array.from({length:100},(_,i)=>finishScenario(id,{evidence:'unknown',feasibility:'unchecked',assumptions:[],provider:i%2?{kind:'canceled'}:{kind:'unavailable',retryable:true}})));
    expect(outcomes.filter(row=>row.accepted)).toHaveLength(1);expect(new Set(outcomes.map(row=>row.state)).size).toBe(1);
  },60000);
  it('P01.3-I04 touch timestamps do not stale a draft, but dependencies, overrides and live evaluations do',async()=>{
    const {plan,scope,context,root}=await setupPlan();
    await pool.query('UPDATE tasks SET last_activity_at=NOW()::text,updated_at=NOW()::text WHERE id=$1',[root]);
    await savePlanRevision(plan.id,scope,edit(context));
    const next=await getPlanningContext(scope);const id=await beginScenario(plan.id,scope,next.snapshot_token);
    const blocker=await task();const edge=randomUUID();const override=randomUUID();
    try{
      await pool.query("INSERT INTO edges(id,source_id,source_type,target_id,target_type,relationship,created_at) VALUES ($1,$2,'task',$3,'task','blocks',NOW()::text)",[edge,blocker,root]);
      await expect(savePlanRevision(plan.id,scope,edit(next))).rejects.toMatchObject({code:'snapshot_stale'});
      expect(await finishScenario(id,{evidence:'complete',feasibility:'feasible',assumptions:[],provider:{kind:'success'}})).toEqual({state:'superseded',accepted:true});
      expect((await getPlanningContext(scope)).evaluations[0].evaluation).toBeNull();
      const beforeBlocker=await getPlanningContext(scope);
      await pool.query('UPDATE tasks SET completed=true WHERE id=$1',[blocker]);
      await expect(savePlanRevision(plan.id,scope,edit(beforeBlocker))).rejects.toMatchObject({code:'snapshot_stale'});
      const updated=await getPlanningContext(scope);
      await pool.query("INSERT INTO schedule_day_overrides(id,date,available_minutes,created_at) VALUES ($1,'2026-10-07',60,NOW()::text)",[override]);
      await expect(savePlanRevision(plan.id,scope,edit(updated))).rejects.toMatchObject({code:'snapshot_stale'});
    }finally{await pool.query('DELETE FROM edges WHERE id=$1',[edge]);await pool.query('DELETE FROM schedule_day_overrides WHERE id=$1',[override]);}
  });
  it('P01.3-S02 real paginated evidence never widens across 50 roots; later-page evidence remains valid',async()=>{
    const {plan,scope,root}=await setupPlan();const ids=Array.from({length:25},()=>randomUUID()).sort();resources.push(...ids);const edges=ids.map(()=>randomUUID());
    try{
      for(let i=0;i<ids.length;i++){
        await pool.query("INSERT INTO resources(id,title,created_at) VALUES ($1,'Bounded evidence',NOW()::text)",[ids[i]]);
        await pool.query("INSERT INTO edges(id,source_id,source_type,target_id,target_type,relationship,created_at) VALUES ($1,$2,'resource',$3,'task','attached_to',NOW()::text)",[edges[i],ids[i],root]);
      }
      const first=await getPlanningContext(scope);expect(first.evidence.resources).toHaveLength(20);expect(first.next_cursor).toBeTruthy();
      const second=await getPlanningContext(scope,first.next_cursor!);expect(second.evidence.resources.map(row=>row.id)).toEqual(ids.slice(20));expect(second.next_cursor).toBeNull();
      const otherRoots=await Promise.all(Array.from({length:50},()=>task()));
      for(const id of otherRoots){
        await expect(getPlanningContext(scopeFor(id),first.next_cursor!)).rejects.toMatchObject({code:'snapshot_stale'});
        expect((await getPlanningContext(scopeFor(id))).evidence.resources).toEqual([]);
      }
      const input=edit(first);input.content.work_items=[{reference:{kind:'work_item',id:'page-two'},title:'Later source task',task:null,effort:{state:'unknown',minutes:null},evidence:[{resource:{kind:'resource',id:ids[24]},state:'partial',generation:null,pages:null}]}];
      await savePlanRevision(plan.id,scope,input);expect((await getPlanningContext(scope)).plan?.redacted_items).toBe(0);
      const narrowed=await request(`plans/${plan.id}/revisions/1?${new URLSearchParams({root_kind:scope.root.kind,root_id:scope.root.id,from:scope.from,to:scope.to,resource_ids:''})}`);
      expect(narrowed.status).toBe(200);expect(JSON.stringify(await narrowed.json())).not.toContain('Later source task');
      await expect(getPlanningContext(scope,first.next_cursor!)).rejects.toMatchObject({code:'snapshot_stale'});
      await pool.query('DELETE FROM edges WHERE id=$1',[edges[24]]);
      expect(JSON.stringify(await readPlanRevision(plan.id,1,scope))).not.toContain('Later source task');
    }finally{await pool.query('DELETE FROM edges WHERE id=ANY($1)',[edges]);}
  },60000);
  it('P02.3-I03 archiving a goal hides its plans; root deletion cascades without deleting resources',async()=>{
    const goal=randomUUID();goals.push(goal);await pool.query("INSERT INTO goals(id,title,created_at,updated_at) VALUES ($1,'Goal',NOW()::text,NOW()::text)",[goal]);
    const root=await task(goal);const scope=scopeFor(root);const plan=await createPlan(scope.root);
    const resource=randomUUID();resources.push(resource);await pool.query("INSERT INTO resources(id,title,created_at) VALUES ($1,'Keep original',NOW()::text)",[resource]);
    await pool.query('UPDATE goals SET archived_at=NOW()::text WHERE id=$1',[goal]);
    await expect(getPlanningContext(scope)).rejects.toMatchObject({code:'not_found'});
    await pool.query('UPDATE goals SET archived_at=NULL WHERE id=$1',[goal]);expect((await getPlanningContext(scope)).plan?.id).toBe(plan.id);
    await pool.query('DELETE FROM tasks WHERE id=$1',[root]);
    expect((await pool.query('SELECT plan_id FROM planning_plan_revisions WHERE plan_id=$1',[plan.id])).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM resources WHERE id=$1',[resource])).rows).toHaveLength(1);
  });
  it('P02.3-I01 archive/restore/forget preserve source tasks and revision lineage',async()=>{
    const {plan,scope,context,root}=await setupPlan();await savePlanRevision(plan.id,scope,edit(context));
    await changePlanLifecycle(plan.id,'archive',1,randomUUID());expect((await getPlanningContext(scope)).plan?.state).toBe('archived');
    expect((await pool.query('SELECT completed FROM tasks WHERE id=$1',[root])).rows[0].completed).toBe(false);
    await changePlanLifecycle(plan.id,'restore',2,randomUUID());expect((await getPlanningContext(scope)).plan?.state).toBe('draft');
    await changePlanLifecycle(plan.id,'archive',3,randomUUID());await changePlanLifecycle(plan.id,'forget',4,randomUUID());
    const rows=(await pool.query('SELECT content,previous_version,version FROM planning_plan_revisions WHERE plan_id=$1 ORDER BY version',[plan.id])).rows;
    expect(rows).toHaveLength(6);expect(rows.every(row=>row.content.outcome==='')).toBe(true);
    expect(rows.slice(1).every(row=>row.previous_version===row.version-1)).toBe(true);
    expect((await pool.query('SELECT id FROM tasks WHERE id=$1',[root])).rows).toHaveLength(1);
  });
  it('P02.3-I02 source removal immediately hides derived work on new reads',async()=>{
    const {plan,scope}=await setupPlan();const r=randomUUID();resources.push(r);const edge=randomUUID();
    await pool.query("INSERT INTO resources(id,title,created_at) VALUES ($1,'Source',NOW()::text)",[r]);
    await pool.query("INSERT INTO edges(id,source_id,source_type,target_id,target_type,relationship,created_at) VALUES ($1,$2,'resource',$3,'task','attached_to',NOW()::text)",[edge,r,scope.root.id]);
    try {
      const context=await getPlanningContext(scope);const input=edit(context);
      input.content.work_items=[{reference:{kind:'work_item',id:'temporary'},title:'Derived private passage',task:null,effort:{state:'known',minutes:30,basis:'estimate'},evidence:[{resource:{kind:'resource',id:r},state:'partial',generation:null,pages:null}]}];
      await savePlanRevision(plan.id,scope,input);
      await pool.query('DELETE FROM resources WHERE id=$1',[r]);
      const after=await getPlanningContext(scope);expect(after.plan?.redacted_items).toBe(1);
      expect(JSON.stringify(after)).not.toContain('Derived private passage');expect(after.plan?.state).toBe('stale');
    }finally{await pool.query('DELETE FROM edges WHERE id=$1',[edge]);}
  });
  it('P02.3-S01 cleanup resumes in bounded batches and leaves plan versions intact',async()=>{
    const {plan,scope,context}=await setupPlan();const ids=await Promise.all(Array.from({length:3},()=>beginScenario(plan.id,scope,context.snapshot_token)));
    await pool.query("UPDATE planning_scenarios SET updated_at=NOW()-INTERVAL '1 hour' WHERE id=ANY($1)",[ids]);
    expect((await getPlanningContext(scope)).evaluations.every(row=>row.state==='failed'&&row.evaluation===null)).toBe(true);
    expect(await prunePlanningArtifacts(1)).toBe(1);expect(await prunePlanningArtifacts(100)).toBe(2);expect(await prunePlanningArtifacts(100)).toBe(0);
    expect((await pool.query('SELECT state,result FROM planning_scenarios WHERE plan_id=$1',[plan.id])).rows.every(row=>row.state==='failed'&&row.result===null)).toBe(true);
    expect((await planHistory(plan.id)).revisions).toHaveLength(1);
  });
  it('P02.1-S01 10,000 roots retain indexed lookup and race-safe uniqueness',async()=>{
    const prefix=`p02-scale-${randomUUID()}-`;const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO tasks(id,title,created_at,updated_at) SELECT $1||i,'Scale fixture',NOW()::text,NOW()::text FROM generate_series(1,10000) i",[prefix]);
      await client.query('INSERT INTO planning_plans(id,task_id) SELECT $1||i,$1||i FROM generate_series(1,10000) i',[prefix]);
      await client.query("INSERT INTO planning_plan_revisions(plan_id,version,content,origin,operation,idempotency_key,request_hash) SELECT $1||i,0,$2::jsonb,'system','create','create','fixture' FROM generate_series(1,10000) i",[prefix,JSON.stringify(emptyPlanContent())]);
      await client.query('COMMIT');await client.query('ANALYZE planning_plans');
      const explains=await client.query('EXPLAIN (FORMAT JSON,ANALYZE) SELECT id FROM planning_plans WHERE task_id=$1',[`${prefix}5000`]);
      expect(JSON.stringify(explains.rows)).toContain('Index');
      const outcomes=await Promise.all(Array.from({length:20},()=>createPlan({kind:'task',id:`${prefix}5000`})));
      expect(outcomes.every(row=>row.id===`${prefix}5000`&&!row.created)).toBe(true);
      expect((await client.query('SELECT count(*)::int AS count FROM planning_plans WHERE task_id LIKE $1',[`${prefix}%`])).rows[0].count).toBe(10000);
    }finally{await client.query('ROLLBACK');await client.query('DELETE FROM tasks WHERE id LIKE $1',[`${prefix}%`]);client.release();}
  },60000);
});
