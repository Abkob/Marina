import crypto from 'node:crypto';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { getScheduleReviewDay, lockScheduleAccounting, reviewDateSchema } from './scheduleReview.js';
import { getWorkTimer, stopWorkTimer } from './workTimer.js';
import { getWorkTasks, isOpenTask } from '../../src/utils/taskTree.js';
import { buildWorkHierarchy } from '../../shared/workHierarchy.js';
import { timeDate } from '../../src/utils/timeHeatmap.js';
import type { DBTask, DBGoal } from '../../src/db/schema.js';

const fail = (status:number,message:string):never => { throw Object.assign(new Error(message),{status}); };
type Client = {query:(sql:string,params?:any[])=>Promise<{rows:any[]}>};
export async function dayWorkContext(client:Client={query}, includeAvailable=false) {
  const prefs=await client.query("SELECT timezone FROM user_schedule_prefs WHERE id='default'");
  const timezone=String(prefs.rows[0]?.timezone??'Asia/Beirut'), now=Date.now(), date=timeDate(now,timezone);
  const tasks=(await client.query('SELECT * FROM tasks')).rows as DBTask[];
  const goals=(await client.query('SELECT * FROM goals')).rows as DBGoal[];
  const hierarchy=buildWorkHierarchy(tasks);
  const eligible=getWorkTasks(tasks,goals).filter(t=>isOpenTask(t)&&hierarchy.summaries.get(t.id)?.executable);
  const byID=new Map(tasks.map(t=>[t.id,t]));
  const picks=(await client.query('SELECT task_id,position FROM day_work_picks WHERE date=$1 ORDER BY position,task_id',[date])).rows;
  const day=await getScheduleReviewDay(date,client);
  // Only current accepted occurrences contribute membership, never unapplied proposals.
  const current=day.current.filter(o=>day.outcomes.find(r=>r.occurrence_id===o.id)?.status!=='skipped');
  const ongoing=current.filter(o=>Date.parse(o.start)<=now&&Date.parse(o.end)>now);
  const descends=(id:string,roots:Set<string>)=>{
    const seen=new Set<string>(); let cursor:string|undefined=id;
    while(cursor&&!seen.has(cursor)){if(roots.has(cursor))return true;seen.add(cursor);cursor=byID.get(cursor)?.parent_task_id??undefined;}
    return false;
  };
  const linked=new Set(current.flatMap(o=>o.taskIds)), pinned=new Set(picks.map(p=>String(p.task_id)));
  const due=new Set(ongoing.length===1?ongoing[0].taskIds:[]);
  const recent=new Map((await client.query("SELECT task_id,MAX(started_at) AS latest FROM work_timers WHERE task_id IS NOT NULL GROUP BY task_id")).rows.map(r=>[String(r.task_id),String(r.latest)]));
  const format=(t:DBTask)=>({id:t.id,title:t.title,context:byID.get(t.parent_task_id??'')?.title??goals.find(g=>g.id===t.goal_id)?.title??'',pinned:pinned.has(t.id)});
  const queue=eligible.filter(t=>descends(t.id,linked)||descends(t.id,pinned));
  const dueTasks=queue.filter(t=>descends(t.id,due));
  const suggested=dueTasks.length===1?dueTasks[0].id:null;
  queue.sort((a,b)=>Number(b.id===suggested)-Number(a.id===suggested)||
    (picks.findIndex(p=>p.task_id===a.id)<0?Infinity:picks.findIndex(p=>p.task_id===a.id))-(picks.findIndex(p=>p.task_id===b.id)<0?Infinity:picks.findIndex(p=>p.task_id===b.id))||
    (recent.get(b.id)??'').localeCompare(recent.get(a.id)??'')||a.position-b.position||a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
  return {date,timezone,server_now:new Date(now).toISOString(),tasks:queue.map(format),
    ...(includeAvailable?{available:eligible.sort((a,b)=>a.title.localeCompare(b.title)||a.id.localeCompare(b.id)).map(format)}:{}),
    running:(await getWorkTimer(client)).timer};
}
export async function pickDayWork(taskID:string,selected:boolean) {
  return transaction(async client=>{
    await lockScheduleAccounting(client);
    const ctx=await dayWorkContext(client,true);
    if(selected&&!ctx.available?.some(t=>t.id===taskID))fail(409,'This task is no longer available. Refresh the day list.');
    if(selected)await client.query('INSERT INTO day_work_picks(date,task_id,position) VALUES($1,$2,(SELECT COALESCE(MAX(position),-1)+1 FROM day_work_picks WHERE date=$1)) ON CONFLICT DO NOTHING',[ctx.date,taskID]);
    else await client.query('DELETE FROM day_work_picks WHERE date=$1 AND task_id=$2',[ctx.date,taskID]);
    return dayWorkContext(client,true);
  });
}
export const dayWorkCommandSchema=z.object({
  command_id:z.string().uuid(), action:z.enum(['start','stop']), task_id:z.string().min(1).max(200).nullable(),
  date:reviewDateSchema, expected_running_id:z.string().max(200).nullable(),
  instant:z.string().datetime({offset:true}).transform(s=>new Date(s).toISOString()),
});
export async function applyDayWorkCommand(input:z.infer<typeof dayWorkCommandSchema>) {
  const hash=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return transaction(async client=>{
    await lockScheduleAccounting(client);
    const previous=(await client.query('SELECT request_hash,result FROM day_work_commands WHERE id=$1',[input.command_id])).rows[0];
    if(previous){if(previous.request_hash!==hash)fail(409,'This command was already used for a different action.');return {...previous.result,duplicate:true};}
    const current=(await getWorkTimer(client)).timer;
    if((current?.sessionId??null)!==input.expected_running_id)fail(409,'The running timer changed on another device. Refresh and choose again.');
    const instant=Date.parse(input.instant);
    if(instant>Date.now()+1000||instant<Date.now()-10*60_000)fail(400,'This action is too old or in the future. Refresh and tap again.');
    const ctx=await dayWorkContext(client);
    if(input.action==='start'){
      if(input.date!==ctx.date||!ctx.tasks.some(t=>t.id===input.task_id))fail(409,'This task is no longer in today’s queue. Refresh and choose again.');
      if(current?.taskId===input.task_id&&!current.scheduleOccurrenceId){
        const result={timer:current,unchanged:true};
        await client.query('INSERT INTO day_work_commands(id,request_hash,result) VALUES($1,$2,$3::jsonb)',[input.command_id,hash,JSON.stringify(result)]);
        return result;
      }
    }else if(!current||current.scheduleOccurrenceId||(current.taskId||null)!==input.task_id){fail(409,'This work timer changed. Open calendar check-in for a schedule timer.');}
    // This milestone never invents an attendance end. The legacy calendar timer
    // must be explicitly ended in check-in before a work timer can replace it.
    if(current?.scheduleOccurrenceId)fail(409,'End the calendar timer in Check in first; its attendance end is still unconfirmed.');
    if(current&&instant<=Date.parse(current.startedAt))fail(409,'Wait a moment, then try again. The boundary must follow the timer start.');
    if(current)await stopWorkTimer(current.sessionId,{ended_at:input.instant},client);
    if(input.action==='start'){
      const seen=await client.query('SELECT id FROM work_timers WHERE id=$1 UNION ALL SELECT id FROM work_sessions WHERE id=$1',[input.command_id]);
      if(seen.rows.length)fail(409,'This session ID has already been used. Refresh before starting.');
      const overlap=await client.query("SELECT id FROM work_sessions WHERE source<>'schedule_checkin' AND ended_at>$1 LIMIT 1",[input.instant]);
      if(overlap.rows.length)fail(409,'This start overlaps recorded work. Refresh and start now.');
      await client.query("INSERT INTO work_timers(id,task_id,started_at,notes,status,updated_at) VALUES($1,$2,$3,'','running',$3)",[input.command_id,input.task_id,input.instant]);
    }
    const result={timer:(await getWorkTimer(client)).timer};
    await client.query('INSERT INTO day_work_commands(id,request_hash,result) VALUES($1,$2,$3::jsonb)',[input.command_id,hash,JSON.stringify(result)]);
    return result;
  });
}
