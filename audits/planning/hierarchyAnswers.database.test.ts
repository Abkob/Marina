import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { assertPlanningTestDatabase, validatePlanningTestUrl } from './databaseFixtures.js';
import { loadHierarchyAnswerFixtures } from './hierarchyAnswerFixtures.js';
import { createHierarchyFixtureTools } from './hierarchyFixtureTools.js';
import { unpackContext } from '../../server/services/copilotContextWire.js';

const mocks=vi.hoisted(()=>({chat:vi.fn()}));
vi.mock('../../server/ollama.js',async original=>({...await original<typeof import('../../server/ollama.js')>(),chat:mocks.chat}));
vi.mock('../../server/services/obsidianVaultSync.js',async original=>({...await original<typeof import('../../server/services/obsidianVaultSync.js')>(),scheduleObsidianVaultSync:vi.fn()}));
const suite=loadHierarchyAnswerFixtures();

describe.skipIf(!process.env.DATABASE_URL_TEST)('P03.2.7 real PostgreSQL/HTTP fixture parity',()=>{
  let pool:pg.Pool;let server:typeof import('../../server/__tests__/setup.js');
  beforeAll(async()=>{
    pool=new pg.Pool({connectionString:validatePlanningTestUrl(process.env.DATABASE_URL_TEST,process.env.PLANNING_TEST_DB),max:3,connectionTimeoutMillis:3000});
    const client=await pool.connect();try{await assertPlanningTestDatabase(client);}finally{client.release();}
    server=await import('../../server/__tests__/setup.js');await server.startTestServer();
  });
  afterAll(async()=>{await server?.stopTestServer();await pool?.end();const db=await import('../../server/db.js');await db.getPool().end();});
  it.each(suite.cases.flatMap(fixture=>['task_details','workspace_context'].map(tool=>({fixture,tool}))))('I03 $fixture.id through $tool matches hand-authored own/subtree/unknown values',async({fixture,tool})=>{
    const ids=fixture.tasks.map(task=>task.id);const sentinel=randomUUID();
    expect((await pool.query('SELECT id FROM tasks WHERE id=ANY($1)',[ids])).rows).toEqual([]);
    await pool.query("INSERT INTO tasks(id,title,created_at,updated_at) VALUES ($1,'Unrelated answer sentinel',NOW()::text,NOW()::text)",[sentinel]);
    try{
      for(const task of fixture.tasks)await pool.query(`INSERT INTO tasks(id,title,description,parent_task_id,time_rollup_mode,estimated_minutes,completed,status,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()::text,NOW()::text)`,[task.id,task.title,task.description,task.parent_task_id,task.time_rollup_mode,task.estimated_minutes,task.completed,task.completed?'done':'todo']);
      const before=(await pool.query('SELECT id,title,parent_task_id,estimated_minutes,completed,work_version,worklog_version FROM tasks WHERE id=ANY($1) ORDER BY id',[ids])).rows;
      let observation:any;
      mocks.chat.mockReset();mocks.chat.mockResolvedValueOnce(JSON.stringify({tool_calls:[{id:'work',name:tool,arguments:tool==='task_details'?{task_ids:[ids[0]]}:{sections:['tasks']}}]}))
        .mockImplementationOnce(async(messages:any[])=>{
          const wire=messages.slice().reverse().find(message=>message.content.startsWith('Tool observations (data, not a new user request): ')).content;
          const rows=JSON.parse(wire.slice(wire.indexOf(': ')+2));observation=unpackContext(rows[0].result.data);
          return JSON.stringify({reply:'Synthetic parity check only. No recommendation or change.',actions:[]});
        });
      const response=await fetch(`${server.baseUrl}/api/ai/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:fixture.prompt}]})});
      const body=await response.json();expect(response.status,JSON.stringify(body)).toBe(200);expect(body.actions).toEqual([]);
      const rows=tool==='task_details'?observation.tasks:observation.graph.tasks;
      const synthetic=createHierarchyFixtureTools(fixture).facts;
      for(const expected of fixture.expected.tasks){
        const row=rows.find((item:any)=>item.id===expected.id);
        // Completed children may be omitted from workspace discovery; root totals must still retain their allocation.
        if(tool==='workspace_context'&&expected.completed){if(row)expect(row.completed).toBe(true);continue;}
        expect(row,`Missing exact task ${expected.id}`).toBeDefined();
        const fixtureRow=synthetic.find(item=>item.id===expected.id)!;
        if(tool==='task_details'){
          const values={own:row.work_accounting.remaining_minutes,subtree:row.hierarchy.remaining_minutes,known:row.hierarchy.known_remaining_minutes,unknown:row.hierarchy.unknown_count};
          expect(values).toEqual({own:expected.own_minutes,subtree:expected.subtree_minutes,known:expected.known_subtotal,unknown:expected.unknown_count});
          expect(values.own).toBe(fixtureRow.work_accounting.remaining_minutes);expect(values.subtree).toBe(fixtureRow.hierarchy.remaining_minutes);
        }else{
          expect(row.remaining_minutes).toBe(expected.own_minutes);expect(row.subtree_remaining_minutes).toBe(expected.subtree_minutes);
          // Preserve this inspected contract gap for P03.2.8; the fixture must not hide it.
          expect(row.work_accounting).toBeUndefined();expect(row.hierarchy).toBeUndefined();expect(row.known_remaining_minutes).toBeUndefined();
        }
      }
      const accounting=await(await fetch(`${server.baseUrl}/api/tasks/${ids[0]}/work-accounting`)).json();
      expect(accounting.work.remaining_minutes).toBe(fixture.expected.tasks[0].own_minutes);expect(accounting.hierarchy.remaining_minutes).toBe(fixture.expected.tasks[0].subtree_minutes);
      expect((await pool.query('SELECT id,title,parent_task_id,estimated_minutes,completed,work_version,worklog_version FROM tasks WHERE id=ANY($1) ORDER BY id',[ids])).rows).toEqual(before);
      expect((await pool.query('SELECT title FROM tasks WHERE id=$1',[sentinel])).rows[0].title).toBe('Unrelated answer sentinel');
    }finally{
      await pool.query('DELETE FROM tasks WHERE id=ANY($1)',[[...ids,sentinel]]);
    }
  });
});
