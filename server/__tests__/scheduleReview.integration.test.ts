import 'express-async-errors';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initSchema, pool, query } from '../db.js';
import { scheduleReviewRouter } from '../routes/schedule-review.js';
import { workTimerRouter } from '../routes/work-timer.js';
import { checkInSchedule, getScheduleReviewDay, saveProposedSchedule } from '../services/scheduleReview.js';
import { importTimerSchema, startWorkTimer, stopWorkTimer } from '../services/workTimer.js';
import { correctScheduleTime } from '../services/scheduleTimeCorrection.js';
import { scheduleShortcutsRouter } from '../routes/schedule-shortcuts.js';
import { createScheduleShortcutKey, revokeScheduleShortcutKey } from '../services/scheduleShortcuts.js';
import { createApp } from '../app.js';

describe.skipIf(!process.env.DATABASE_URL_TEST)('proposed/actual schedule against PostgreSQL',()=>{
 let server:Server,origin:string;
 const date='2026-10-18',occurrence='event:schedule-a:2026-10-18';
 const at=(time:string)=>`2026-10-18T${time}:00.000Z`;
 const input=(extra:Record<string,unknown>={})=>({command_id:crypto.randomUUID(),date,occurrence_id:occurrence,expected_revision:0,status:'confirmed' as const,actual_start:at('06:00'),actual_end:at('07:00'),...extra});
 async function post(path:string,body:unknown){const r=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
 const start=(id:string,sessionId=crypto.randomUUID(),expected:string|null=null)=>post(`/api/schedule-review/${date}/start`,{session_id:sessionId,occurrence_id:id,expected_running_id:expected});
 beforeAll(async()=>{
  await initSchema();const app=express();app.use(express.json());app.use('/api/schedule-shortcuts',scheduleShortcutsRouter);app.use('/api/schedule-review',scheduleReviewRouter);app.use('/api/work-timer',workTimerRouter);
  app.use(((e,_req,res,_next)=>res.status(e.status??(e.name==='ZodError'?400:500)).json({error:e.message}))as express.ErrorRequestHandler);
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});origin=`http://127.0.0.1:${(server.address()as {port:number}).port}`;
 });
 beforeEach(async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(at('10:00')));
  await query('TRUNCATE schedule_day_plans,schedule_occurrence_outcomes,schedule_checkin_commands,schedule_outcome_history,schedule_push_subscriptions,schedule_push_deliveries,work_timers,work_sessions,event_task_links,events,routine_entries,routines,tasks CASCADE');
  await query("INSERT INTO user_schedule_prefs(id,timezone,updated_at) VALUES('default','Asia/Beirut',$1) ON CONFLICT(id) DO UPDATE SET timezone='Asia/Beirut'",[at('00:00')]);
  await query("INSERT INTO tasks(id,title,created_at,updated_at) VALUES('schedule-task','Study',$1,$1)",[at('00:00')]);
  for(const [id,hour]of [['schedule-a',9],['schedule-b',9.5]]as const)await query("INSERT INTO events(id,title,week_start,day_index,start_hour,duration_hours,created_at,updated_at) VALUES($1,$1,'2026-10-12',6,$2,1,$3,$3)",[id,hour,at('00:00')]);
  await query("INSERT INTO event_task_links(id,event_id,task_id,created_at) VALUES('schedule-link','schedule-a','schedule-task',$1)",[at('00:00')]);
 });
 afterAll(async()=>{vi.useRealTimers();if(server)await new Promise<void>(r=>server.close(()=>r()));await query('TRUNCATE schedule_day_plans,schedule_occurrence_outcomes,schedule_checkin_commands,schedule_outcome_history,work_timers,work_sessions,event_task_links,events,routine_entries,routines,tasks CASCADE');await pool.end();});
 it('preserves the evening baseline across same-day moves and rejects invented past plans',async()=>{
  vi.setSystemTime(new Date('2026-10-17T18:00:00Z'));await saveProposedSchedule(date);
  vi.setSystemTime(new Date(at('07:00')));await query("UPDATE events SET start_hour=12 WHERE id='schedule-a'");
  const day=await getScheduleReviewDay(date);
  expect(day.proposed?.frozen).toBe(true);expect(day.proposed?.occurrences.find(o=>o.id===occurrence)?.start).toBe(at('06:00'));
  expect(day.current.find(o=>o.id===occurrence)?.start).toBe(at('09:00'));
  await expect(saveProposedSchedule(date)).rejects.toMatchObject({status:400});
 });
 it('never fabricates an earlier proposal on a read',async()=>{expect((await getScheduleReviewDay(date)).proposed).toBeNull();});
 it('records real Start/End once even for an event with no task link and late attendance',async()=>{
  const id='event:schedule-b:'+date,session=crypto.randomUUID();
  expect((await start(id,session)).status).toBe(200);
  vi.setSystemTime(new Date(at('10:20')));
  const replies=await Promise.all([post(`/api/work-timer/${session}/stop`,{}),post(`/api/work-timer/${session}/stop`,{})]);
  expect(replies.map(r=>r.status)).toEqual([200,200]);
  expect((await query('SELECT * FROM work_sessions')).rows).toEqual([expect.objectContaining({id:session,minutes:20,task_id:null})]);
  expect((await getScheduleReviewDay(date)).outcomes[0]).toMatchObject({session_id:session,actual_start:at('10:00'),actual_end:at('10:20')});
  const retry=await start(id,session);expect(retry.body.timer).toBeNull();
 });
 it('leaves a previous end unconfirmed when moving on, then accepts only a non-overlapping correction',async()=>{
  const a=crypto.randomUUID(),b=crypto.randomUUID();await start(occurrence,a);
  vi.setSystemTime(new Date(at('10:10')));
  expect((await start('event:schedule-b:'+date,b,a)).status).toBe(200);
  expect((await query('SELECT status,ended_at FROM work_timers WHERE id=$1',[a])).rows[0]).toEqual({status:'awaiting_end',ended_at:null});
  expect((await query('SELECT * FROM work_sessions')).rows).toHaveLength(0);
  expect((await start(occurrence,crypto.randomUUID(),a)).status).toBe(409);
  vi.setSystemTime(new Date(at('10:30')));await stopWorkTimer(b,{});
  await expect(stopWorkTimer(a,{ended_at:at('10:15')})).rejects.toMatchObject({status:409});
  expect((await query('SELECT status FROM work_timers WHERE id=$1',[a])).rows[0].status).toBe('awaiting_end');
  await stopWorkTimer(a,{ended_at:at('10:08')});
  expect((await query('SELECT SUM(minutes)::int AS total FROM work_sessions')).rows[0].total).toBe(28);
  const rows=(await query('SELECT * FROM work_sessions ORDER BY started_at')).rows;expect(rows[0].ended_at).toBe(at('10:08'));expect(rows[1].started_at).toBe(at('10:10'));
 });
 it('reuses a study timer instead of adding a second session',async()=>{
  const timer=await startWorkTimer(importTimerSchema.parse({taskId:'schedule-task',startedAt:at('06:20')}),true);
  vi.setSystemTime(new Date(at('07:00')));await stopWorkTimer(timer.timer!.sessionId,{});
  const body=input({session_id:timer.timer!.sessionId});await checkInSchedule(body);
  await checkInSchedule(body);
  expect((await query('SELECT COUNT(*)::int AS count FROM work_sessions')).rows[0].count).toBe(1);
  await expect(checkInSchedule(input({status:'skipped',expected_revision:1}))).rejects.toMatchObject({status:409});
 });
 it('replaces overlapping reported minutes when a timer is saved later',async()=>{
  await checkInSchedule(input());
  const timer=await startWorkTimer(importTimerSchema.parse({taskId:'schedule-task',startedAt:at('06:30')}),true);
  vi.setSystemTime(new Date(at('07:00')));await stopWorkTimer(timer.timer!.sessionId,{});
  const result=await query('SELECT SUM(minutes)::int AS total FROM work_sessions');expect(result.rows[0].total).toBe(60);
  expect((await query("SELECT minutes FROM work_sessions WHERE source='schedule_checkin'")).rows[0].minutes).toBe(30);
 });
 it('does not restore corrected-away timer minutes through a reported calendar block',async()=>{
  await query("INSERT INTO work_sessions(id,task_id,started_at,ended_at,minutes,source,created_at) VALUES('corrected','schedule-task',$1,$2,30,'timer',$2)",[at('06:00'),at('07:00')]);
  await checkInSchedule(input());expect((await query('SELECT SUM(minutes)::int AS total FROM work_sessions')).rows[0].total).toBe(30);
 });
 it('credits overlapping reported events once and Undo removes only reported work',async()=>{
  await checkInSchedule(input());await checkInSchedule(input({occurrence_id:'event:schedule-b:'+date,actual_start:at('06:30'),actual_end:at('07:30')}));
  expect((await query('SELECT SUM(minutes)::int AS total FROM work_sessions')).rows[0].total).toBe(90);
  await checkInSchedule(input({expected_revision:1,status:'unknown',actual_start:null,actual_end:null}));
  expect((await query('SELECT SUM(minutes)::int AS total FROM work_sessions')).rows[0].total).toBe(60);
 });
 it('serializes competing check-ins, preserves history, and rejects reused IDs with changed payloads',async()=>{
  const command=input();const replies=await Promise.all([post('/api/schedule-review/check-in',command),post('/api/schedule-review/check-in',input())]);
  expect(replies.map(r=>r.status).sort()).toEqual([200,409]);
  await expect(checkInSchedule({...command,status:'skipped'})).rejects.toMatchObject({status:409});
  expect((await query('SELECT * FROM schedule_outcome_history')).rows).toHaveLength(1);
 });
 it('keeps running timers intact when someone tries to confirm an elapsed block',async()=>{
  await startWorkTimer(importTimerSchema.parse({taskId:'schedule-task',startedAt:at('06:30')}),true);
  await expect(checkInSchedule(input())).rejects.toMatchObject({status:409});
  expect((await query("SELECT * FROM work_timers WHERE status='running'")).rows).toHaveLength(1);
  expect((await query('SELECT * FROM schedule_occurrence_outcomes')).rows).toHaveLength(0);
 });
 it('records a past start without extrapolating work, and permits a later explicit start correction',async()=>{
  const session=crypto.randomUUID();
  const reply=await post(`/api/schedule-review/${date}/start`,{session_id:session,occurrence_id:occurrence,started_at:at('06:10'),track_live:false});
  expect(reply.body.timer).toBeNull();expect((await getScheduleReviewDay(date)).pendingTimers[0].id).toBe(session);
  const old=(await getScheduleReviewDay(date)).outcomes[0];
  await correctScheduleTime({occurrence_id:occurrence,date,expected_revision:old.revision,actual_start:at('06:15')});
  expect((await query('SELECT * FROM work_sessions')).rows).toHaveLength(0);
  await stopWorkTimer(session,{ended_at:at('06:45')});
  expect((await query('SELECT minutes FROM work_sessions')).rows[0].minutes).toBe(30);
 });
 it('corrects a finished session in place with history, safe retry, and no second log',async()=>{
  const session=crypto.randomUUID();await start(occurrence,session);vi.setSystemTime(new Date(at('10:20')));await stopWorkTimer(session,{});
  const old=(await getScheduleReviewDay(date)).outcomes[0];
  const correction={occurrence_id:occurrence,date,expected_revision:old.revision,actual_start:at('10:05'),actual_end:at('10:15')};
  await correctScheduleTime(correction);await correctScheduleTime(correction);
  const rows=(await query('SELECT * FROM work_sessions')).rows;expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:session,minutes:10,started_at:at('10:05'),ended_at:at('10:15')});
  expect((await query('SELECT * FROM schedule_outcome_history')).rows).toHaveLength(3);
 });
 it('connects Shortcuts with hashed, expiring, revocable credentials and idempotent explicit times',async()=>{
  const key=await createScheduleShortcutKey('Test iPhone');
  const stored=(await query('SELECT * FROM schedule_shortcut_keys WHERE id=$1',[key.id])).rows[0];
  expect(stored.token_hash).not.toBe(key.token);expect(stored.token_hash).toHaveLength(64);
  const headers={Authorization:`Bearer ${key.token}`,'Content-Type':'application/json'};
  expect((await fetch(origin+'/api/schedule-shortcuts/context')).status).toBe(401);
  const context=await fetch(origin+'/api/schedule-shortcuts/context',{headers}).then(r=>r.json());
  expect(context.events).toHaveLength(2);expect(context.events[0]).not.toHaveProperty('taskIds');
  const session=crypto.randomUUID();
  const body={session_id:session,occurrence_id:occurrence,date,started_at:at('06:10'),track_live:false,expected_running_id:null};
  const send=(path:string,data:unknown)=>fetch(origin+'/api/schedule-shortcuts/'+path,{method:'POST',headers,body:JSON.stringify(data)});
  expect((await send('start',body)).status).toBe(200);expect((await send('start',body)).status).toBe(200);
  expect((await send('start',{...body,session_id:crypto.randomUUID()})).status).toBe(409);
  expect((await getScheduleReviewDay(date)).pendingTimers).toHaveLength(1);
  expect((await send('end',{session_id:session,ended_at:at('06:40')})).status).toBe(200);
  expect((await send('end',{session_id:session,ended_at:at('06:40')})).status).toBe(200);
  expect((await query('SELECT id,minutes FROM work_sessions')).rows).toEqual([{id:session,minutes:30}]);
  const unrelated=await startWorkTimer({sessionId:crypto.randomUUID(),taskId:'schedule-task',notes:''});
  expect((await send('end',{session_id:unrelated.timer!.sessionId,ended_at:at('10:10')})).status).toBe(404);
  await revokeScheduleShortcutKey(key.id);
  expect((await fetch(origin+'/api/schedule-shortcuts/context',{headers})).status).toBe(401);
  const expired=await createScheduleShortcutKey('Expired');
  await query("UPDATE schedule_shortcut_keys SET expires_at=NOW()-interval '1 day' WHERE id=$1",[expired.id]);
  expect((await fetch(origin+'/api/schedule-shortcuts/context',{headers:{Authorization:`Bearer ${expired.token}`}})).status).toBe(401);
 });
 it('never accepts a Shortcuts key as a general API login in the production app',async()=>{
  const key=await createScheduleShortcutKey('Scope test',true);
  vi.stubEnv('MARINA_AUTH_REQUIRED','true');vi.stubEnv('MARINA_ACCESS_PASSWORD','integration-test-password');vi.stubEnv('MARINA_SESSION_SECRET','integration-test-session-secret-at-least-32');
  const app=createApp();const scoped=await new Promise<Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try{
    const base=`http://127.0.0.1:${(scoped.address()as {port:number}).port}`,headers={Authorization:`Bearer ${key.token}`};
    expect((await fetch(base+'/api/schedule-shortcuts/context',{headers})).status).toBe(200);
    expect((await fetch(base+'/api/tasks',{headers})).status).toBe(401);
    expect((await fetch(base+'/api/schedule-review/shortcuts/keys',{headers})).status).toBe(401);
    expect((await fetch(base+'/api/work-timer',{headers})).status).toBe(401);
  }finally{await new Promise<void>(resolve=>scoped.close(()=>resolve()));vi.unstubAllEnvs();}
 });
});
