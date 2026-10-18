import { Router } from 'express';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { authenticateScheduleShortcut } from '../services/scheduleShortcuts.js';
import { getScheduleReviewDay, lockScheduleAccounting, reviewDateSchema } from '../services/scheduleReview.js';
import { scheduleStartSchema, startScheduleActivity } from '../services/scheduleStart.js';
import { getWorkTimer, stopWorkTimer } from '../services/workTimer.js';
import { timeDate } from '../../src/utils/timeHeatmap.js';
import { applyDayWorkCommand, dayWorkCommandSchema, dayWorkContext, pickDayWork } from '../services/dayWork.js';

// This router is mounted before cookie authentication. Its bearer key is valid
// ONLY on these schedule endpoints, never on the general API or key management.
const router=Router();
router.use(async(req,res,next)=>{
  res.setHeader('Cache-Control','private, no-store');
  if(!await authenticateScheduleShortcut(req.get('authorization'))){res.status(401).json({error:'Reconnect this shortcut in Marina. Its connection is missing, expired or revoked.'});return;}
  next();
});
// Separate opt-in capability: existing schedule-only keys cannot control work.
router.use('/work',async(req,res,next)=>{
  if(!await authenticateScheduleShortcut(req.get('authorization'),true)){res.status(403).json({error:'Reconnect the widget with task timer access in Marina.'});return;}
  next();
});
router.get('/work/context',async(req,res)=>{res.json(await dayWorkContext(undefined,req.query.available==='1'));});
router.post('/work/pick',async(req,res)=>{
  const body=z.object({task_id:z.string().min(1).max(200),selected:z.boolean()}).parse(req.body);
  res.json(await pickDayWork(body.task_id,body.selected));
});
router.post('/work/command',async(req,res)=>{res.json(await applyDayWorkCommand(dayWorkCommandSchema.parse(req.body)));});
router.get('/context',async(req,res)=>{
  const prefs=await query("SELECT timezone FROM user_schedule_prefs WHERE id='default'");
  const timezone=String(prefs.rows[0]?.timezone??'Asia/Beirut');
  const date=req.query.date===undefined?timeDate(Date.now(),timezone):reviewDateSchema.parse(req.query.date);
  const day=await getScheduleReviewDay(date),running=(await getWorkTimer()).timer;
  const all=[...(day.proposed?.occurrences??[]),...day.current,...day.outcomes.map(o=>o.occurrence)];
  const events=[...new Map(all.map(o=>[o.id,o])).values()].map(o=>({
    occurrence_id:o.id,title:o.title,date,planned_start:o.start,planned_end:o.end,
    actual_start:day.outcomes.find(r=>r.occurrence_id===o.id)?.actual_start??null,
    status:day.outcomes.find(r=>r.occurrence_id===o.id)?.status??'unknown',
  }));
  const pending=await query("SELECT id,schedule_occurrence_id AS occurrence_id,schedule_date AS date,started_at,schedule_occurrence->>'title' AS title FROM work_timers WHERE schedule_occurrence_id IS NOT NULL AND status IN ('running','awaiting_end') ORDER BY started_at");
  res.json({date,timezone,server_now:new Date().toISOString(),running_id:running?.sessionId??null,events,pending:pending.rows});
});
router.post('/start',async(req,res)=>{
  const body=z.object({date:reviewDateSchema}).parse(req.body);
  res.json(await startScheduleActivity(body.date,scheduleStartSchema.parse(req.body)));
});
router.post('/end',async(req,res)=>{
  const body=z.object({session_id:z.string().uuid(),ended_at:z.string().datetime({offset:true}).transform(s=>new Date(s).toISOString())}).parse(req.body);
  res.json(await transaction(async client=>{
    await lockScheduleAccounting(client);
    const timer=await client.query('SELECT schedule_occurrence_id FROM work_timers WHERE id=$1',[body.session_id]);
    if(!timer.rows[0]?.schedule_occurrence_id)throw Object.assign(new Error('Choose a schedule check-in. This shortcut cannot change other timers.'),{status:404});
    return stopWorkTimer(body.session_id,{ended_at:body.ended_at},client);
  }));
});
export {router as scheduleShortcutsRouter};
