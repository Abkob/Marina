import crypto from 'node:crypto';
import webpush from 'web-push';
import { z } from 'zod';
import { query } from '../db.js';
import { getScheduleReviewDay } from './scheduleReview.js';
import { getWorkTimer } from './workTimer.js';
import { timeDate } from '../../src/utils/timeHeatmap.js';
import type { ScheduleOccurrence } from '../../shared/scheduleReview.js';

const hosts=new Set(['web.push.apple.com','fcm.googleapis.com','updates.push.services.mozilla.com']);
export const pushSubscriptionSchema=z.object({endpoint:z.string().url().max(2048).refine(value=>{const u=new URL(value);return u.protocol==='https:'&&(!u.port||u.port==='443')&&!u.username&&!u.password&&(hosts.has(u.hostname)||u.hostname.endsWith('.notify.windows.com'));},'Unsupported push service'),keys:z.object({p256dh:z.string().regex(/^[A-Za-z0-9_-]{87}$/),auth:z.string().regex(/^[A-Za-z0-9_-]{22}$/)})});
export function schedulePushConfigured(){return Boolean(process.env.MARINA_VAPID_PUBLIC_KEY&&process.env.MARINA_VAPID_PRIVATE_KEY);}
export async function schedulePushStatus(){
  const result=await query('SELECT COUNT(*)::int AS count,MAX(last_error) AS last_error FROM schedule_push_subscriptions');
  return {configured:schedulePushConfigured(),public_key:process.env.MARINA_VAPID_PUBLIC_KEY??null,devices:result.rows[0].count,last_error:result.rows[0].last_error??null};
}
export async function savePushSubscription(input:z.infer<typeof pushSubscriptionSchema>){
  if(!schedulePushConfigured())throw Object.assign(new Error('Start/end reminders are not configured on the server yet.'),{status:503});
  const id=crypto.createHash('sha256').update(input.endpoint).digest('hex');
  await query(`INSERT INTO schedule_push_subscriptions(id,subscription,updated_at) VALUES($1,$2::jsonb,$3)
    ON CONFLICT(id) DO UPDATE SET subscription=EXCLUDED.subscription,updated_at=EXCLUDED.updated_at,last_error=NULL`,[id,JSON.stringify(input),new Date().toISOString()]);
  return {ok:true};
}
export async function removePushSubscription(endpoint:string){
  await query('DELETE FROM schedule_push_subscriptions WHERE id=$1',[crypto.createHash('sha256').update(endpoint).digest('hex')]);return {ok:true};
}

/** Five-minute polling only finds prompts; actual times are explicitly chosen
 * by the user. Stable tags collapse retries. */
export async function sendScheduleReminders(now=Date.now()){
  if(!schedulePushConfigured())return {skipped:'not_configured'};
  const devices=await query<{id:string;subscription:webpush.PushSubscription}>('SELECT * FROM schedule_push_subscriptions ORDER BY id');
  if(!devices.rows.length)return {sent:0};
  const prefs=await query("SELECT timezone FROM user_schedule_prefs WHERE id='default'");
  const zone=String(prefs.rows[0]?.timezone??'Asia/Beirut'),date=timeDate(now,zone);
  const day=await getScheduleReviewDay(date),active=await getWorkTimer();
  const recent=(value:string)=>{const age=now-Date.parse(value);return age>=0&&age<10*60_000;};
  const due=day.current.filter(o=>recent(o.start)&&!day.outcomes.some(r=>r.occurrence_id===o.id&&(r.status!=='unknown'||r.actual_start))&&active.timer?.scheduleOccurrenceId!==o.id);
  const prompts:{key:string;title:string;body:string;date:string;occurrence?:string}[]=[];
  if(due.length)prompts.push({key:`start:${due.map(o=>o.id+':'+o.start).sort().join('|')}`,title:due.length>1?'Events are starting':'Starting now?',body:due.length>1?'Choose what you’re doing. Overlapping plans won’t start extra timers.':'Tap to start, choose a different time, or skip.',date,occurrence:due.length===1?due[0].id:undefined});
  if(active.timer?.scheduleOccurrenceId){
    const timer=await query<{schedule_occurrence:ScheduleOccurrence;schedule_date:string}>('SELECT schedule_occurrence,schedule_date FROM work_timers WHERE id=$1',[active.timer.sessionId]);
    const occurrence=day.current.find(o=>o.id===active.timer!.scheduleOccurrenceId)??timer.rows[0]?.schedule_occurrence;
    if(occurrence&&recent(occurrence.end))prompts.push({key:`end:${active.timer.sessionId}:${occurrence.end}`,title:'Finished this event?',body:'Tap End when you finish. Your timer keeps running until then.',date:timer.rows[0].schedule_date,occurrence:occurrence.id});
  }
  webpush.setVapidDetails(process.env.MARINA_VAPID_SUBJECT??'https://marina-demol1sin.vercel.app',process.env.MARINA_VAPID_PUBLIC_KEY!,process.env.MARINA_VAPID_PRIVATE_KEY!);
  let sent=0;
  for(const prompt of prompts)for(const device of devices.rows){
    const key=crypto.createHash('sha256').update(`${device.id}|${prompt.key}`).digest('hex');
    const claimed=await query(`INSERT INTO schedule_push_deliveries(id,claimed_at) VALUES($1,NOW())
      ON CONFLICT(id) DO UPDATE SET claimed_at=NOW() WHERE schedule_push_deliveries.sent_at IS NULL AND schedule_push_deliveries.claimed_at<NOW()-INTERVAL '4 minutes' RETURNING id`,[key]);
    if(!claimed.rows.length)continue;
    const params=new URLSearchParams({view:'schedule',checkin:'1',date:prompt.date});if(prompt.occurrence)params.set('occurrence',prompt.occurrence);
    try{
      await webpush.sendNotification(device.subscription,JSON.stringify({title:prompt.title,body:prompt.body,tag:`marina-${key}`,url:`/?${params}`}),{TTL:600,urgency:'normal',timeout:10000});
      await query('UPDATE schedule_push_deliveries SET sent_at=NOW() WHERE id=$1',[key]);
      await query('UPDATE schedule_push_subscriptions SET last_error=NULL WHERE id=$1',[device.id]);sent++;
    }catch(error){
      const status=(error as {statusCode?:number}).statusCode;
      if(status===404||status===410)await query('DELETE FROM schedule_push_subscriptions WHERE id=$1',[device.id]);
      else await query('UPDATE schedule_push_subscriptions SET last_error=$2 WHERE id=$1',[device.id,'Reminder delivery failed. Open Marina to check your connection and reminder permission.']);
    }
  }
  await query("DELETE FROM schedule_push_deliveries WHERE claimed_at<NOW()-INTERVAL '14 days'");
  return {sent};
}
