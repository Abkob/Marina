import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { calendarEventRange, calendarInstant } from '../../src/utils/calendarTime.js';
import { addRoutineDays, isRoutineDate, routineReservations, routineWeekStart } from '../../src/utils/routines.js';
import { timeDate } from '../../src/utils/timeHeatmap.js';
import { matchingSessions, uncoveredRanges, type ScheduleOccurrence, type ScheduleOutcome, type ScheduleReviewDay, type ScheduleSession } from '../../shared/scheduleReview.js';
import type { DBRoutine, DBRoutineEntry } from '../../src/types/routines.js';
import { activeEventSql, activeGoalSql, activeMeetingSql } from '../utils/archiveVisibility.js';

type Client = { query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }> };
const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
export const reviewDateSchema = z.string().refine(isRoutineDate, 'Choose a valid schedule date');
export const checkInSchema = z.object({
  command_id: z.string().uuid(), date: reviewDateSchema, occurrence_id: z.string().min(1).max(250),
  expected_revision: z.number().int().min(0), status: z.enum(['unknown','confirmed','skipped']),
  actual_start: z.string().datetime({ offset: true }).transform(s=>new Date(s).toISOString()).nullable().optional(),
  actual_end: z.string().datetime({ offset: true }).transform(s=>new Date(s).toISOString()).nullable().optional(),
  session_id: z.string().max(200).nullable().optional(),
});
export async function lockScheduleAccounting(client: Client) {
  // Same lock as timer start/stop: two devices cannot claim the same span twice.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('marina-active-work-timer'))");
}
async function timezone(client: Client) {
  const { rows } = await client.query("SELECT timezone FROM user_schedule_prefs WHERE id='default'");
  return String(rows[0]?.timezone || 'Asia/Beirut');
}
async function currentOccurrences(date: string, zone: string, client: Client): Promise<ScheduleOccurrence[]> {
  // Transactions share one pg connection; do not queue concurrent queries on it.
  const events=await client.query(`SELECT e.*,COALESCE((SELECT json_agg(l.task_id ORDER BY l.task_id) FROM event_task_links l WHERE l.event_id=e.id),'[]') AS task_ids FROM events e WHERE week_start IS NOT NULL AND ${activeEventSql('e.id')}`);
  const meetings=await client.query(`SELECT m.*,COALESCE((SELECT json_agg(e.target_id ORDER BY e.target_id) FROM edges e WHERE e.source_type='meeting' AND e.source_id=m.id AND e.target_type='task' AND e.relationship='linked_to'),'[]') AS task_ids FROM meetings m WHERE ${activeMeetingSql('m.id')}`);
  const routines=await client.query(`SELECT * FROM routines WHERE ${activeGoalSql()}`);
  const entries=await client.query('SELECT * FROM routine_entries WHERE date >= $1 AND date <= $2', [routineWeekStart(date), addRoutineDays(routineWeekStart(date),6)]);
  const result: ScheduleOccurrence[] = [];
  for (const e of events.rows) {
    const range = calendarEventRange({week_start:e.week_start,day_index:Number(e.day_index),start_hour:Number(e.start_hour),duration_hours:Number(e.duration_hours)},zone);
    if (range && timeDate(range.start,zone)===date) result.push({id:`event:${e.id}:${date}`,source:'event',sourceId:e.id,title:e.title,start:new Date(range.start).toISOString(),end:new Date(range.end).toISOString(),taskIds:e.task_ids,goalId:null,routineId:null});
  }
  for (const m of meetings.rows) {
    const start=Date.parse(m.scheduled_at),end=start+Number(m.duration_minutes)*60_000;
    if(Number.isFinite(start)&&end>start&&timeDate(start,zone)===date)result.push({id:`meeting:${m.id}:${date}`,source:'meeting',sourceId:m.id,title:m.title,start:new Date(start).toISOString(),end:new Date(end).toISOString(),taskIds:m.task_ids,goalId:m.goal_id??null,routineId:null});
  }
  for(const r of routineReservations(routines.rows as DBRoutine[],entries.rows as DBRoutineEntry[],date,date,date)) {
    if(!r.preferred_time) continue;
    const [h,m]=r.preferred_time.split(':').map(Number),start=calendarInstant(date,h+m/60,zone),end=start+r.minutes*60_000;
    const original=routines.rows.find(row=>row.id===r.routine_id);
    if(Number.isFinite(start)&&end>start)result.push({id:`routine:${r.routine_id}:${date}`,source:'routine',sourceId:r.routine_id,title:r.title,start:new Date(start).toISOString(),end:new Date(end).toISOString(),taskIds:[],goalId:original?.goal_id??null,routineId:r.routine_id});
  }
  return result.sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id));
}

export async function getScheduleReviewDay(date: string, client: Client = {query}): Promise<ScheduleReviewDay> {
  const plan=await client.query('SELECT * FROM schedule_day_plans WHERE date=$1',[date]);
  const saved=plan.rows[0],zone=saved?.timezone??await timezone(client);
  const start=new Date(calendarInstant(date,0,zone)).toISOString(),end=new Date(calendarInstant(addRoutineDays(date,1),0,zone)).toISOString();
  const current=await currentOccurrences(date,zone,client);
  const outcomes=await client.query('SELECT * FROM schedule_occurrence_outcomes WHERE date=$1 ORDER BY occurrence_id',[date]);
  const sessions=await client.query(`SELECT id,started_at,ended_at,minutes,task_id,routine_id,source,schedule_occurrence_id FROM work_sessions WHERE (started_at < $2 AND COALESCE(ended_at,started_at) >= $1) OR id IN (SELECT session_id FROM schedule_occurrence_outcomes WHERE date=$3) ORDER BY started_at,id`,[start,end,date]);
  const effectiveOutcomes=(outcomes.rows as ScheduleOutcome[]).map(o=>{const session=sessions.rows.find(s=>s.id===o.session_id);return session&&session.ended_at?{...o,actual_start:session.started_at,actual_end:session.ended_at}:o;});
  const pending=await client.query(`SELECT wt.id,wt.started_at,COALESCE(wt.schedule_occurrence->>'title',t.title,r.title,'Study session') AS title,wt.schedule_occurrence_id,wt.schedule_date
    FROM work_timers wt LEFT JOIN tasks t ON t.id=wt.task_id LEFT JOIN routines r ON r.id=wt.routine_id WHERE wt.status='awaiting_end'`);
  return {date,timezone:zone,today:timeDate(Date.now(),zone),proposed:saved?{saved_at:saved.saved_at,frozen:saved.frozen,occurrences:saved.occurrences}:null,current,outcomes:effectiveOutcomes,sessions:sessions.rows as ScheduleSession[],pendingTimers:pending.rows.filter(t=>t.schedule_date===date||(!t.schedule_date&&timeDate(Date.parse(t.started_at),zone)===date))};
}

export async function saveProposedSchedule(date: string, automatic=false) {
  return transaction(async client=>{
    await lockScheduleAccounting(client);
    const zone=await timezone(client),now=new Date(),today=timeDate(now.getTime(),zone);
    if(date!==addRoutineDays(today,1))fail(400,'Save tomorrow’s proposed schedule. Past plans cannot be reconstructed from today’s calendar.');
    const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',hourCycle:'h23'}).format(now));
    const existing=await client.query('SELECT * FROM schedule_day_plans WHERE date=$1 FOR UPDATE',[date]);
    if(existing.rows[0]?.frozen)return {saved_at:existing.rows[0].saved_at,frozen:true};
    if(automatic&&hour<21)return {skipped:true};
    const occurrences=await currentOccurrences(date,zone,client);
    await client.query(`INSERT INTO schedule_day_plans(date,timezone,saved_at,frozen,occurrences) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(date) DO UPDATE SET timezone=EXCLUDED.timezone,saved_at=EXCLUDED.saved_at,frozen=EXCLUDED.frozen,occurrences=EXCLUDED.occurrences`,[date,zone,now.toISOString(),hour>=21,JSON.stringify(occurrences)]);
    return {saved_at:now.toISOString(),frozen:hour>=21};
  });
}
export async function freezeTomorrowSchedule() {
  const zone=await timezone({query});
  return saveProposedSchedule(addRoutineDays(timeDate(Date.now(),zone),1),true);
}

/** Only uncovered reported intervals become canonical work rows. Timer rows
 * remain intact and take precedence, including their corrected work minutes.
 * Called under the shared accounting lock after check-ins and timer mutations. */
export async function reconcileScheduleSessions(client: Client) {
  const {rows:outcomes}=await client.query("SELECT * FROM schedule_occurrence_outcomes WHERE status='confirmed' ORDER BY updated_at,occurrence_id");
  const {rows:external}=await client.query("SELECT id,started_at,ended_at,minutes FROM work_sessions WHERE source<>'schedule_checkin' AND ended_at IS NOT NULL");
  const occupied=external.map(s=>({start:Date.parse(s.started_at),end:Date.parse(s.ended_at)}));
  const existing=await client.query("SELECT id,task_id FROM work_sessions WHERE source='schedule_checkin'");
  const tasks=await client.query('SELECT id FROM tasks'),routines=await client.query('SELECT id FROM routines'),goals=await client.query('SELECT id FROM goals');
  const taskIds=new Set(tasks.rows.map(t=>t.id)),routineIds=new Set(routines.rows.map(r=>r.id));
  const desired:string[]=[],affected=new Set<string>(existing.rows.map(s=>s.task_id).filter(Boolean));
  for(const raw of outcomes){
    const o=raw as ScheduleOutcome;
    // A linked timer is already a canonical session; confirmation adds no row.
    if(o.session_id)continue;
    const span={start:Date.parse(o.actual_start!),end:Date.parse(o.actual_end!)};
    for(const part of uncoveredRanges(span,occupied)){
      const id='schedule-'+crypto.createHash('sha256').update(`${o.occurrence_id}|${part.start}|${part.end}`).digest('hex');
      const task=o.occurrence.taskIds.length===1&&taskIds.has(o.occurrence.taskIds[0])?o.occurrence.taskIds[0]:null;
      const routine=routineIds.has(o.occurrence.routineId)?o.occurrence.routineId:null;
      const minutes=Math.floor((part.end-part.start)/60_000+1e-8);
      if(!minutes)continue;
      desired.push(id);if(task)affected.add(task);
      const goal=goals.rows.some(g=>g.id===o.occurrence.goalId)?o.occurrence.goalId:null;
      await client.query(`INSERT INTO work_sessions(id,task_id,routine_id,started_at,ended_at,minutes,notes,source,created_at,goal_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'schedule_checkin',$8,$9) ON CONFLICT(id) DO NOTHING`,
      [id,task,routine,new Date(part.start).toISOString(),new Date(part.end).toISOString(),minutes,`Schedule check-in: ${o.occurrence.title}`,o.updated_at,goal]);
    }
    occupied.push(span);
  }
  await client.query("DELETE FROM work_sessions WHERE source='schedule_checkin' AND NOT(id=ANY($1::text[]))",[desired]);
  if(affected.size)await client.query(`UPDATE tasks SET actual_minutes=(SELECT COALESCE(SUM(minutes),0) FROM work_sessions WHERE task_id=tasks.id) WHERE id=ANY($1::text[])`,[[...affected]]);
}

export async function checkInSchedule(input:z.infer<typeof checkInSchema>) {
  return transaction(async client=>{
    await lockScheduleAccounting(client);
    const hash=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const command=await client.query('SELECT * FROM schedule_checkin_commands WHERE id=$1',[input.command_id]);
    if(command.rows[0]){
      if(command.rows[0].request_hash!==hash)fail(409,'This check-in ID was already used. Refresh and try again.');
      return command.rows[0].result as ScheduleOutcome;
    }
    const old=await client.query('SELECT * FROM schedule_occurrence_outcomes WHERE occurrence_id=$1 FOR UPDATE',[input.occurrence_id]);
    const previous=old.rows[0] as ScheduleOutcome|undefined;
    if((previous?.revision??0)!==input.expected_revision)fail(409,'This event was checked on another device. Refresh before changing it.');
    const day=await getScheduleReviewDay(input.date,client);
    const occurrence=previous?.date===input.date?previous.occurrence:[...(day.proposed?.occurrences??[]),...day.current].find(e=>e.id===input.occurrence_id);
    if(!occurrence)fail(404,'This scheduled occurrence was not found. Refresh the day.');
    if(input.date>day.today)fail(400,'Future events cannot be checked in yet.');
    const matches=matchingSessions(occurrence!,day.sessions);
    let start=input.actual_start??null,end=input.actual_end??null,sessionId=input.session_id??null;
    if(input.status==='confirmed'){
      if(sessionId){
        const session=matches.find(s=>s.id===sessionId);
        if(!session)fail(409,'The suggested study session changed. Refresh the day.');
        start=session!.started_at;end=session!.ended_at;
      }
      if(!start||!end||Date.parse(end)<=Date.parse(start)||Date.parse(end)>Date.now()+1000||Date.parse(end)-Date.parse(start)>86_400_000)fail(400,'Choose actual times in the past, with an end after the start (up to 24 hours).');
      if(timeDate(Date.parse(start!),day.timezone)!==input.date)fail(400,'The actual start must be on this schedule day.');
      const running=await client.query("SELECT started_at FROM work_timers WHERE status='running'");
      if(running.rows.some(t=>Date.parse(t.started_at)<Date.parse(end!)))fail(409,'Stop the running timer first so its recorded time can be reused.');
    }else{
      start=null;end=null;sessionId=null;
      if(input.status==='skipped'&&matches.length)fail(409,'A study session is recorded for this event. Use its time, or clear the session separately before marking it skipped.');
    }
    const result:ScheduleOutcome={occurrence_id:input.occurrence_id,date:input.date,revision:(previous?.revision??0)+1,status:input.status,actual_start:start,actual_end:end,session_id:sessionId,occurrence:occurrence!,updated_at:new Date().toISOString()};
    await client.query(`INSERT INTO schedule_occurrence_outcomes(occurrence_id,date,revision,status,actual_start,actual_end,session_id,occurrence,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(occurrence_id) DO UPDATE SET revision=EXCLUDED.revision,status=EXCLUDED.status,actual_start=EXCLUDED.actual_start,actual_end=EXCLUDED.actual_end,session_id=EXCLUDED.session_id,updated_at=EXCLUDED.updated_at`,
    [result.occurrence_id,result.date,result.revision,result.status,start,end,sessionId,JSON.stringify(occurrence),result.updated_at]);
    await client.query('INSERT INTO schedule_outcome_history(occurrence_id,revision,outcome) VALUES($1,$2,$3::jsonb)',[result.occurrence_id,result.revision,JSON.stringify(result)]);
    await reconcileScheduleSessions(client);
    await client.query('INSERT INTO schedule_checkin_commands(id,occurrence_id,request_hash,result,created_at) VALUES($1,$2,$3,$4::jsonb,$5)',[input.command_id,input.occurrence_id,hash,JSON.stringify(result),result.updated_at]);
    return result;
  });
}

  /** End preserves explicit clock boundaries and the canonical timer session ID. */
export async function finishScheduleTimer(client:Client,input:{id:string;date:string;occurrence:ScheduleOccurrence;start:string;end:string}) {
  const previous=await client.query('SELECT revision FROM schedule_occurrence_outcomes WHERE occurrence_id=$1 FOR UPDATE',[input.occurrence.id]);
  const outcome:ScheduleOutcome={occurrence_id:input.occurrence.id,date:input.date,revision:Number(previous.rows[0]?.revision??0)+1,status:'confirmed',actual_start:input.start,actual_end:input.end,session_id:input.id,occurrence:input.occurrence,updated_at:input.end};
  await client.query(`INSERT INTO schedule_occurrence_outcomes(occurrence_id,date,revision,status,actual_start,actual_end,session_id,occurrence,updated_at)
    VALUES($1,$2,$3,'confirmed',$4,$5,$6,$7::jsonb,$5) ON CONFLICT(occurrence_id) DO UPDATE SET revision=EXCLUDED.revision,status='confirmed',actual_start=EXCLUDED.actual_start,actual_end=EXCLUDED.actual_end,session_id=EXCLUDED.session_id,updated_at=EXCLUDED.updated_at`,
  [outcome.occurrence_id,outcome.date,outcome.revision,input.start,input.end,input.id,JSON.stringify(input.occurrence)]);
  await client.query('INSERT INTO schedule_outcome_history(occurrence_id,revision,outcome) VALUES($1,$2,$3::jsonb)',[outcome.occurrence_id,outcome.revision,JSON.stringify(outcome)]);
}
