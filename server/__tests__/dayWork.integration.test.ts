import 'express-async-errors';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { beforeAll,beforeEach,afterAll,it,expect,describe,vi } from 'vitest';
import { initSchema,pool,query } from '../db.js';
import { applyDayWorkCommand,dayWorkCommandSchema,dayWorkContext,pickDayWork } from '../services/dayWork.js';
import { createScheduleShortcutKey,revokeScheduleShortcutKey } from '../services/scheduleShortcuts.js';
import { scheduleShortcutsRouter } from '../routes/schedule-shortcuts.js';
import { startWorkTimer,stopWorkTimer } from '../services/workTimer.js';
import { startScheduleActivity,scheduleStartSchema } from '../services/scheduleStart.js';
import { checkInSchedule } from '../services/scheduleReview.js';

describe.skipIf(!process.env.DATABASE_URL_TEST)('Home Screen day work PostgreSQL contract',()=>{
 let server:Server,origin:string;
 const at=(m=0)=>new Date(Date.UTC(2026,9,19,9,m)).toISOString();
 const command=(task='a',expected:string|null=null,action:'start'|'stop'='start',extra:Record<string,unknown>={})=>dayWorkCommandSchema.parse({command_id:crypto.randomUUID(),action,task_id:task,date:'2026-10-19',expected_running_id:expected,instant:new Date().toISOString(),...extra});
 beforeAll(async()=>{
  await initSchema(); const app=express();app.use(express.json());app.use('/api/schedule-shortcuts',scheduleShortcutsRouter);
  app.use(((e,_req,res,_next)=>res.status(e.status??(e.name==='ZodError'?400:500)).json({error:e.message})) as express.ErrorRequestHandler);
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});origin=`http://127.0.0.1:${(server.address()as {port:number}).port}`;
 });
 beforeEach(async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(at()));
  await query('TRUNCATE day_work_commands,day_work_picks,schedule_checkin_commands,schedule_occurrence_outcomes,schedule_outcome_history,schedule_day_plans,work_timers,work_sessions,event_task_links,events,tasks,goals CASCADE');
  await query("INSERT INTO user_schedule_prefs(id,timezone,updated_at) VALUES('default','UTC',$1) ON CONFLICT(id) DO UPDATE SET timezone='UTC'",[at()]);
  for(const id of ['a','b','c'])await query('INSERT INTO tasks(id,title,created_at,updated_at) VALUES($1,$1,$2,$2)',[id,at()]);
  await pickDayWork('a',true);await pickDayWork('b',true);
 });
 afterAll(async()=>{vi.useRealTimers();if(server)await new Promise<void>(r=>server.close(()=>r()));await pool.end();});
 it('starts an unestimated task and replays a lost-response command without another session',async()=>{
  const input=command();await applyDayWorkCommand(input);await applyDayWorkCommand(input);
  expect((await query('SELECT id FROM work_timers')).rows).toEqual([{id:input.command_id}]);
  await expect(applyDayWorkCommand({...input,task_id:'b'})).rejects.toMatchObject({status:409});
 });
 it('switches atomically at one boundary and replays an old command without replacing the newer timer',async()=>{
  const a=command();await applyDayWorkCommand(a);vi.setSystemTime(new Date(at(20)));
  const b=command('b',a.command_id);await applyDayWorkCommand(b);
  expect((await query('SELECT task_id,minutes,ended_at FROM work_sessions')).rows).toEqual([{task_id:'a',minutes:20,ended_at:at(20)}]);
  await applyDayWorkCommand(a);expect((await dayWorkContext()).running?.taskId).toBe('b');
  vi.setSystemTime(new Date(at(35)));const stop=command('b',b.command_id,'stop');await applyDayWorkCommand(stop);await applyDayWorkCommand(stop);
  expect((await query('SELECT SUM(minutes)::int AS total FROM work_sessions')).rows[0].total).toBe(35);
  expect((await query('SELECT completed FROM tasks WHERE id=$1',['b'])).rows[0].completed).toBe(false);
 });
 it('permits only one of simultaneous taps and rejects a stale stop of a newer timer',async()=>{
  const replies=await Promise.allSettled([applyDayWorkCommand(command('a')),applyDayWorkCommand(command('b'))]);
  expect(replies.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await query("SELECT id FROM work_timers WHERE status='running'")).rows).toHaveLength(1);
  await expect(applyDayWorkCommand(command('a',crypto.randomUUID(),'stop'))).rejects.toMatchObject({status:409});
 });
 it('tapping the already-running task is a durable no-op, even when retried after a later switch',async()=>{
  const a=command();await applyDayWorkCommand(a);
  const same=command('a',a.command_id);expect(await applyDayWorkCommand(same)).toHaveProperty('unchanged',true);
  vi.setSystemTime(new Date(at(10)));await applyDayWorkCommand(command('b',a.command_id));
  await applyDayWorkCommand(same);expect((await dayWorkContext()).running?.taskId).toBe('b');
  expect((await query('SELECT * FROM work_sessions')).rows).toHaveLength(1);
 });
 it('rolls back the stop when the replacement target is no longer eligible',async()=>{
  const a=command();await applyDayWorkCommand(a);vi.setSystemTime(new Date(at(10)));
  await query("UPDATE tasks SET completed=true,status='done' WHERE id='b'");
  await expect(applyDayWorkCommand(command('b',a.command_id))).rejects.toMatchObject({status:409});
  expect((await dayWorkContext()).running?.taskId).toBe('a');expect((await query('SELECT * FROM work_sessions')).rows).toHaveLength(0);
 });
 it('does not guess or auto-start; explicit picks and accepted linked descendants form a deduplicated queue',async()=>{
  await query("INSERT INTO tasks(id,title,kind,created_at,updated_at) VALUES('p','Project','critical_path',$1,$1)",[at()]);
  await query("UPDATE tasks SET parent_task_id='p' WHERE id IN ('a','b')");
  await query("INSERT INTO events(id,title,week_start,day_index,start_hour,duration_hours,created_at,updated_at) VALUES('e','Study','2026-10-19',0,9,1,$1,$1)",[at()]);
  for(const [id,task]of [['l1','p'],['l2','a']])await query('INSERT INTO event_task_links(id,event_id,task_id,created_at) VALUES($1,\'e\',$2,$3)',[id,task,at()]);
  const ctx=await dayWorkContext();expect(ctx.tasks.map(t=>t.id).sort()).toEqual(['a','b']);expect(ctx.tasks[0].context).toBe('Project');expect(ctx.running).toBeNull();
 });
 it('excludes archived goals, respects the database cycle guard and does not add every overdue task',async()=>{
  await query("INSERT INTO goals(id,title,created_at,updated_at,archived_at) VALUES('g','Old',$1,$1,$1)",[at()]);
  await query("UPDATE tasks SET goal_id='g' WHERE id='a'");await query("UPDATE tasks SET due_date='2020-01-01' WHERE id='c'");
  expect((await dayWorkContext()).tasks.map(t=>t.id)).toEqual(['b']);
  await expect(query("UPDATE tasks SET parent_task_id='b' WHERE id='b'")).rejects.toThrow('own ancestor');
  expect((await dayWorkContext()).tasks.map(t=>t.id)).toEqual(['b']);
 });
 it('unpin preserves task/history, and safe Stop works after membership or completion changes',async()=>{
  const a=command();await applyDayWorkCommand(a);await pickDayWork('a',false);
  await query("UPDATE tasks SET completed=true,status='done' WHERE id='a'");vi.setSystemTime(new Date(at(10)));
  await applyDayWorkCommand(command('a',a.command_id,'stop'));expect((await query("SELECT minutes FROM work_sessions WHERE task_id='a'")).rows[0].minutes).toBe(10);
 });
 it('guards day rollover, future clocks and delayed actions before mutating',async()=>{
  for(const extra of [{date:'2026-10-18'},{instant:at(1)},{instant:new Date(Date.parse(at())-11*60_000).toISOString()}])await expect(applyDayWorkCommand(command('a',null,'start',extra))).rejects.toHaveProperty('status');
  expect((await query('SELECT * FROM work_timers')).rows).toHaveLength(0);
 });
 it('preserves the legacy calendar timer and unknown attendance end',async()=>{
  await query("INSERT INTO events(id,title,week_start,day_index,start_hour,duration_hours,created_at,updated_at) VALUES('e','Study','2026-10-19',0,9,1,$1,$1)",[at()]);
  const id=crypto.randomUUID();await startScheduleActivity('2026-10-19',scheduleStartSchema.parse({session_id:id,occurrence_id:'event:e:2026-10-19',expected_running_id:null}));vi.setSystemTime(new Date(at(10)));
  await expect(applyDayWorkCommand(command('a',id))).rejects.toMatchObject({status:409});
  expect((await dayWorkContext()).running?.sessionId).toBe(id);expect((await query('SELECT actual_end FROM schedule_occurrence_outcomes')).rows[0].actual_end).toBeNull();
 });
 it('switches from a timer started on the web and stop does not create a second calendar credit',async()=>{
  const id=crypto.randomUUID();await startWorkTimer({sessionId:id,taskId:'a',notes:''});vi.setSystemTime(new Date(at(20)));
  await applyDayWorkCommand(command('b',id));
  await query("INSERT INTO events(id,title,week_start,day_index,start_hour,duration_hours,created_at,updated_at) VALUES('e','Study','2026-10-19',0,9,1,$1,$1)",[at()]);
  await checkInSchedule({command_id:crypto.randomUUID(),date:'2026-10-19',occurrence_id:'event:e:2026-10-19',expected_revision:0,status:'confirmed',actual_start:at(),actual_end:at(20)});
  expect((await query('SELECT SUM(minutes)::int AS total FROM work_sessions')).rows[0].total).toBe(20);
 });
 it('old scoped keys cannot control work; opt-in credentials remain expiring/revocable',async()=>{
  const old=await createScheduleShortcutKey('Schedule only'),key=await createScheduleShortcutKey('Work',true);
  const get=(token:string)=>fetch(origin+'/api/schedule-shortcuts/work/context',{headers:{Authorization:`Bearer ${token}`}});
  expect((await get(old.token)).status).toBe(403);expect((await get(key.token)).status).toBe(200);
  await revokeScheduleShortcutKey(key.id);expect((await get(key.token)).status).toBe(401);
 });
});
