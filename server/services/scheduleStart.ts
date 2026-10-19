import { z } from 'zod';
import { transaction } from '../db.js';
import { getWorkTimer } from './workTimer.js';
import { getScheduleReviewDay, lockScheduleAccounting } from './scheduleReview.js';
import { timeDate } from '../../src/utils/timeHeatmap.js';
export const scheduleStartSchema=z.object({session_id:z.string().uuid(),occurrence_id:z.string().min(1).max(250),expected_running_id:z.string().max(200).nullable().default(null),started_at:z.string().datetime({offset:true}).transform(s=>new Date(s).toISOString()).optional(),track_live:z.boolean().default(true),attendance_only:z.boolean().default(false)});
export async function startScheduleActivity(date:string,input:z.infer<typeof scheduleStartSchema>) {
  const result=await transaction(async client=>{
    await lockScheduleAccounting(client);
    const current=await getWorkTimer(client);
    const seen=await client.query('SELECT id FROM work_timers WHERE id=$1',[input.session_id]);
    if(seen.rows.length)return {...current,started:false};
    if(!input.attendance_only&&(current.timer?.sessionId??null)!==input.expected_running_id)throw Object.assign(new Error('The running activity changed on another device. Refresh before switching.'),{status:409});
    const day=await getScheduleReviewDay(date,client);
    if(date>day.today)throw Object.assign(new Error('Choose a day that has started.'),{status:400});
    const occurrence=[...day.current,...(day.proposed?.occurrences??[]),...day.outcomes.map(o=>o.occurrence)].find(o=>o.id===input.occurrence_id);
    if(!occurrence)throw Object.assign(new Error('This occurrence is no longer available. Refresh the day.'),{status:404});
    const previous=day.outcomes.find(o=>o.occurrence_id===occurrence.id);
    if(previous?.actual_start||previous?.status==='confirmed')throw Object.assign(new Error('This event already has a recorded start. Correct its existing times instead.'),{status:409});
    const now=new Date().toISOString();
    const startedAt=input.started_at??now;
    if(Date.parse(startedAt)>Date.now()+1000||timeDate(Date.parse(startedAt),day.timezone)!==date)throw Object.assign(new Error('Choose an actual start on this day, in the past.'),{status:400});
    // Moving on is not evidence that the previous activity ended. Preserve its
    // real start, with no end and no saved minutes, until the user fixes it.
    const live=!input.attendance_only&&input.track_live&&date===day.today;
    if(current.timer&&live)await client.query("UPDATE work_timers SET status='awaiting_end',updated_at=$2 WHERE id=$1 AND status='running'",[current.timer.sessionId,now]);
    await client.query(`INSERT INTO work_timers(id,started_at,notes,status,updated_at,schedule_occurrence_id,schedule_date,schedule_occurrence,attendance_only)
      VALUES($1,$2,'',$7,$6,$3,$4,$5::jsonb,$8)`,[input.session_id,startedAt,occurrence.id,date,JSON.stringify(occurrence),now,live?'running':'awaiting_end',input.attendance_only]);
    const revision=Number(day.outcomes.find(o=>o.occurrence_id===occurrence.id)?.revision??0)+1;
    const outcome={occurrence_id:occurrence.id,date,revision,status:'unknown',actual_start:startedAt,actual_end:null,session_id:input.session_id,occurrence,updated_at:now};
    await client.query(`INSERT INTO schedule_occurrence_outcomes(occurrence_id,date,revision,status,actual_start,actual_end,session_id,occurrence,updated_at)
      VALUES($1,$2,$3,'unknown',$4,NULL,$5,$6::jsonb,$7) ON CONFLICT(occurrence_id) DO UPDATE SET revision=EXCLUDED.revision,status='unknown',actual_start=EXCLUDED.actual_start,actual_end=NULL,session_id=EXCLUDED.session_id,updated_at=EXCLUDED.updated_at`,[occurrence.id,date,revision,startedAt,input.session_id,JSON.stringify(occurrence),now]);
    await client.query('INSERT INTO schedule_outcome_history(occurrence_id,revision,outcome) VALUES($1,$2,$3::jsonb)',[occurrence.id,revision,JSON.stringify(outcome)]);
    return {...await getWorkTimer(client),started:true};
  });
  return result;
}
