import { z } from 'zod';
import { transaction } from '../db.js';
import { finishScheduleTimer, lockScheduleAccounting, reconcileScheduleSessions, reviewDateSchema } from './scheduleReview.js';
import { timeDate } from '../../src/utils/timeHeatmap.js';
import type { ScheduleOutcome } from '../../shared/scheduleReview.js';

const fail=(status:number,message:string):never=>{throw Object.assign(new Error(message),{status});};
const instant=z.string().datetime({offset:true}).transform(s=>new Date(s).toISOString());
export const correctTimeSchema=z.object({occurrence_id:z.string().min(1).max(250),expected_revision:z.number().int().min(1),date:reviewDateSchema,actual_start:instant,actual_end:instant.optional()});

/** Explicit corrections update the canonical session, not a second time log.
 * Earlier values remain in the outcome history. Missing ends remain missing. */
export async function correctScheduleTime(input:z.infer<typeof correctTimeSchema>){
 return transaction(async client=>{
  await lockScheduleAccounting(client);
  const old=(await client.query('SELECT * FROM schedule_occurrence_outcomes WHERE occurrence_id=$1 FOR UPDATE',[input.occurrence_id])).rows[0] as ScheduleOutcome|undefined;
  if(!old||old.date!==input.date||!old.session_id)fail(409,'Refresh this event before correcting its recorded times.');
  if(old!.revision!==input.expected_revision){
    // A lost response may have committed exactly this correction.
    if(old!.actual_start===input.actual_start&&(old!.actual_end??undefined)===input.actual_end)return old;
    fail(409,'This time changed on another device. Refresh before correcting it.');
  }
  const prefs=await client.query("SELECT timezone FROM user_schedule_prefs WHERE id='default'");
  const plan=await client.query('SELECT timezone FROM schedule_day_plans WHERE date=$1',[input.date]);
  const zone=plan.rows[0]?.timezone??prefs.rows[0]?.timezone??'Asia/Beirut';
  if(Date.parse(input.actual_start)>Date.now()+1000||timeDate(Date.parse(input.actual_start),zone)!==input.date)fail(400,'Choose an actual start on this day, in the past.');
  const session=(await client.query('SELECT * FROM work_sessions WHERE id=$1 FOR UPDATE',[old!.session_id])).rows[0];
  if(!input.actual_end){
    if(session)fail(400,'This session already ended; enter both corrected times.');
    const updated=await client.query("UPDATE work_timers SET started_at=$2,updated_at=$3 WHERE id=$1 AND status IN ('running','awaiting_end') RETURNING id",[old!.session_id,input.actual_start,new Date().toISOString()]);
    if(!updated.rows.length)fail(409,'This timer changed. Refresh the day.');
    const result={...old!,revision:old!.revision+1,actual_start:input.actual_start,updated_at:new Date().toISOString()};
    await client.query('UPDATE schedule_occurrence_outcomes SET revision=$2,actual_start=$3,updated_at=$4 WHERE occurrence_id=$1',[old!.occurrence_id,result.revision,result.actual_start,result.updated_at]);
    await client.query('INSERT INTO schedule_outcome_history(occurrence_id,revision,outcome) VALUES($1,$2,$3::jsonb)',[result.occurrence_id,result.revision,JSON.stringify(result)]);
    return result;
  }
  if(!session)fail(400,'Record the actual end first, then correct a finished session if needed.');
  const span=Date.parse(input.actual_end)-Date.parse(input.actual_start);
  if(span<=0||span>86_400_000||Date.parse(input.actual_end)>Date.now()+1000)fail(400,'Choose an end after the start, in the past (up to 24 hours).');
  const overlaps=await client.query("SELECT id FROM work_sessions WHERE source<>'schedule_checkin' AND id<>$1 AND ended_at IS NOT NULL AND started_at<$3 AND ended_at>$2 LIMIT 1",[old!.session_id,input.actual_start,input.actual_end]);
  const running=await client.query("SELECT id FROM work_timers WHERE status='running' AND id<>$1 AND started_at<$2 LIMIT 1",[old!.session_id,input.actual_end]);
  if(overlaps.rows.length||running.rows.length)fail(409,'These times overlap another recorded activity. Adjust the actual boundary so minutes count once.');
  const previousSpan=(Date.parse(session.ended_at)-Date.parse(session.started_at))/60_000;
  const explicitlyReduced=Number(session.minutes)<Math.floor(previousSpan);
  const minutes=explicitlyReduced?Math.min(Number(session.minutes),Math.round(span/60_000)):Math.max(1,Math.round(span/60_000));
  await client.query('UPDATE work_sessions SET started_at=$2,ended_at=$3,minutes=$4 WHERE id=$1',[old!.session_id,input.actual_start,input.actual_end,minutes]);
  await finishScheduleTimer(client,{id:old!.session_id!,date:input.date,occurrence:old!.occurrence,start:input.actual_start,end:input.actual_end});
  await reconcileScheduleSessions(client);
  if(session.task_id)await client.query('UPDATE tasks SET actual_minutes=(SELECT COALESCE(SUM(minutes),0) FROM work_sessions WHERE task_id=$1) WHERE id=$1',[session.task_id]);
  if(session.routine_id)await client.query(`UPDATE routine_entries re SET minutes=GREATEST(0,re.minutes+$3),
    completed_count=CASE WHEN r.target_unit='minutes' THEN GREATEST(0,re.minutes+$3) ELSE re.completed_count END,
    status=CASE WHEN r.target_unit='minutes' AND re.status='completed' AND re.minutes+$3<r.target_count THEN 'partial' WHEN r.target_unit='minutes' AND re.status='partial' AND re.minutes+$3>=r.target_count THEN 'completed' ELSE re.status END,
    updated_at=$4 FROM routines r WHERE re.routine_id=r.id AND re.routine_id=$1 AND re.date=$2`,[session.routine_id,input.date,minutes-Number(session.minutes),new Date().toISOString()]);
  return (await client.query('SELECT * FROM schedule_occurrence_outcomes WHERE occurrence_id=$1',[old!.occurrence_id])).rows[0] as ScheduleOutcome;
 });
}
