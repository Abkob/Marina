import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { logRoutineSession, routineSessionSchema } from './routines.js';
import { routineEligibleOn } from '../../src/utils/routines.js';
import type { DBRoutine } from '../../src/types/routines.js';
import { finishScheduleTimer, reconcileScheduleSessions } from './scheduleReview.js';
import type { ScheduleOccurrence } from '../../shared/scheduleReview.js';

const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
const id = z.string().min(1).max(200);
export const startTimerSchema = z.object({
  sessionId: z.string().uuid(), taskId: z.string().max(200).default(''), routineId: id.optional(),
  notes: z.string().max(10_000).default(''),
}).refine(input => Boolean(input.taskId) !== Boolean(input.routineId), 'Choose one task or routine');
export const importTimerSchema = z.object({
  taskId: z.string().max(200), routineId: id.optional(), sessionId: id.optional(),
  startedAt: z.string().datetime({ offset: true }), notes: z.string().max(10_000).default(''),
}).refine(input => Boolean(input.taskId) !== Boolean(input.routineId), 'Choose one task or routine')
  .refine(input => !input.routineId || z.string().uuid().safeParse(input.sessionId).success, 'Routine timers need their original session ID');
export const stopTimerSchema = z.object({ minutes: z.number().int().min(1).max(1440).optional(), notes: z.string().max(10_000).optional(), ended_at:z.string().datetime({offset:true}).transform(s=>new Date(s).toISOString()).optional() });
export const timerNotesSchema = z.object({ notes: z.string().max(10_000) });

type TimerRow = { id: string; task_id: string | null; routine_id: string | null; routine_date: string | null; started_at: string; ended_at: string | null; notes: string; status: string; title?: string; goal_id?: string | null; schedule_occurrence_id?:string; schedule_date?:string; schedule_occurrence?:ScheduleOccurrence };
type Client = { query:(sql:string,params?:any[])=>Promise<{rows:any[]}> };
const selectTimer = `SELECT wt.*, COALESCE(t.title,r.title,wt.schedule_occurrence->>'title','Focus session') AS title,
  COALESCE(t.goal_id,r.goal_id) AS goal_id FROM work_timers wt
  LEFT JOIN tasks t ON t.id=wt.task_id LEFT JOIN routines r ON r.id=wt.routine_id`;

export async function getWorkTimer(client?: Client) {
  const { rows } = await (client ?? { query }).query(`${selectTimer} WHERE wt.status='running'`);
  const row = rows[0] as TimerRow | undefined;
  return { timer: row ? {
    sessionId: row.id, taskId: row.task_id ?? '', startedAt: row.started_at, notes: row.notes,
    title: row.title, goalId: row.goal_id,
    ...(row.schedule_occurrence_id ? {scheduleOccurrenceId:row.schedule_occurrence_id,scheduleDate:row.schedule_date} : {}),
    ...(row.routine_id ? { routineId: row.routine_id, routineTitle: row.title, routineDate: row.routine_date } : {}),
  } : null, serverNow: new Date().toISOString() };
}

async function lock(client: Client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('marina-active-work-timer'))");
}

export async function startWorkTimer(input: z.infer<typeof startTimerSchema> | z.infer<typeof importTimerSchema>, importing = false) {
  const sessionId = input.sessionId ?? `import-${crypto.createHash('sha256').update(`${input.taskId}|${input.routineId ?? ''}|${'startedAt' in input ? input.startedAt : ''}`).digest('hex')}`;
  return transaction(async client => {
    await lock(client);
    const current = await getWorkTimer(client);
    if (current.timer) return { ...current, started: false };
    const { rows: seen } = await client.query('SELECT id FROM work_timers WHERE id=$1 UNION ALL SELECT id FROM work_sessions WHERE id=$1', [sessionId]);
    if (seen.length) return { ...current, started: false };
    const now = new Date().toISOString();
    const startedAt = importing && 'startedAt' in input ? new Date(input.startedAt).toISOString() : now;
    if (Date.parse(startedAt) > Date.now() + 30_000) fail(400, 'This timer starts in the future. Check this device’s clock.');
    let routineDate: string | null = null;
    if (input.routineId) {
      const { rows: prefs } = await client.query("SELECT timezone FROM user_schedule_prefs WHERE id='default'");
      routineDate = new Intl.DateTimeFormat('en-CA', { timeZone: prefs[0]?.timezone ?? 'Asia/Beirut' }).format(new Date(startedAt));
      const { rows } = await client.query('SELECT * FROM routines WHERE id=$1', [input.routineId]);
      const routine = rows[0] as DBRoutine | undefined;
      if (!routine) fail(404, 'Routine not found');
      if (!routineEligibleOn(routine!, routineDate) || (routine!.archived_at && Date.parse(startedAt) > Date.parse(routine!.archived_at))) fail(409, 'This routine is not available for focus on that day');
    } else {
      const { rows } = await client.query('SELECT id FROM tasks WHERE id=$1', [input.taskId]);
      if (!rows.length) fail(404, 'Task not found');
    }
    await client.query(`INSERT INTO work_timers (id,task_id,routine_id,routine_date,started_at,notes,status,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'running',$7)`, [sessionId, input.taskId || null, input.routineId ?? null, routineDate, startedAt, input.notes, now]);
    await reconcileScheduleSessions(client);
    return { ...await getWorkTimer(client), started: true };
  });
}

export async function stopWorkTimer(sessionId: string, input: z.infer<typeof stopTimerSchema>, existingClient?:PoolClient, preserveAttendance=false) {
  const apply=async (client:PoolClient) => {
    await lock(client);
    const { rows } = await client.query('SELECT * FROM work_timers WHERE id=$1 FOR UPDATE', [sessionId]);
    const timer = rows[0] as (TimerRow & {attendance_only?:boolean;focus_ended_at?:string|null}) | undefined;
    if (!timer) fail(404, 'This timer no longer exists');
    if (timer!.status === 'discarded') fail(409, 'This timer was discarded on another device');
    if (timer!.status === 'stopped') {
      const saved = await client.query('SELECT minutes FROM work_sessions WHERE id=$1', [sessionId]);
      return { ...await getWorkTimer(client), minutes: Number(saved.rows[0]?.minutes ?? 0), duplicate: true };
    }
    const endedAt = input.ended_at??new Date().toISOString();
    if(Date.parse(endedAt)>Date.now()+1000||(input.ended_at&&Date.parse(endedAt)<=Date.parse(timer!.started_at)))fail(400,'Choose an actual end after the recorded start, in the past.');
    if(timer!.attendance_only&&timer!.schedule_occurrence_id&&timer!.schedule_occurrence){
      // Ending attendance never rewrites its earlier focus segment or stops
      // whichever task/routine happens to be running now.
      if(input.minutes!==undefined)fail(400,'Correct attendance boundaries rather than focus minutes.');
      if(Date.parse(endedAt)-Date.parse(timer!.started_at)>86_400_000)fail(400,'Choose the actual attendance end within 24 hours of its start.');
      await finishScheduleTimer(client,{id:sessionId,date:timer!.schedule_date!,occurrence:timer!.schedule_occurrence,start:timer!.started_at,end:endedAt});
      await client.query("UPDATE work_timers SET status='stopped',ended_at=$2,updated_at=$2 WHERE id=$1",[sessionId,endedAt]);
      await reconcileScheduleSessions(client);
      return {...await getWorkTimer(client),minutes:0,duplicate:false};
    }
    if(timer!.schedule_occurrence_id||timer!.status==='awaiting_end'||input.ended_at){
      const overlaps=await client.query(`SELECT id FROM work_sessions WHERE source<>'schedule_checkin' AND id<>$1 AND ended_at IS NOT NULL AND started_at<$3 AND ended_at>$2 LIMIT 1`,[sessionId,timer!.started_at,endedAt]);
      const running=await client.query("SELECT id FROM work_timers WHERE status='running' AND id<>$1 AND started_at<$2 LIMIT 1",[sessionId,endedAt]);
      if(overlaps.rows.length||running.rows.length)fail(409,'These times overlap another recorded or running activity. Choose the actual boundary between them; this end is still unconfirmed.');
    }
    const elapsed = Math.max(0, Date.parse(endedAt) - Date.parse(timer!.started_at));
    const minutes = input.minutes ?? Math.max(1, Math.round(elapsed / 60_000));
    if (input.minutes !== undefined && (!timer!.routine_id || input.minutes > Math.ceil(elapsed / 60_000) + 1)) fail(400, 'Corrected minutes must fit the elapsed routine session');
    const notes = input.notes ?? timer!.notes;
    let savedMinutes = minutes;
    if(timer!.schedule_occurrence_id&&timer!.schedule_occurrence){
      const occurrence=timer!.schedule_occurrence;
      const routine=occurrence.routineId?await client.query('SELECT id FROM routines WHERE id=$1',[occurrence.routineId]):{rows:[]};
      const task=occurrence.taskIds.length===1?await client.query('SELECT id,goal_id FROM tasks WHERE id=$1',[occurrence.taskIds[0]]):{rows:[]};
      if(routine.rows.length){
        const saved=await logRoutineSession(occurrence.routineId!,routineSessionSchema.parse({id:sessionId,date:timer!.schedule_date,started_at:timer!.started_at,ended_at:endedAt,minutes,notes}),client);
        savedMinutes=saved.minutes;
        await client.query('UPDATE work_sessions SET schedule_occurrence_id=$2 WHERE id=$1',[sessionId,occurrence.id]);
      }else await client.query(`INSERT INTO work_sessions(id,task_id,goal_id,started_at,ended_at,minutes,notes,source,created_at,schedule_occurrence_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'timer',$5,$8)`,[sessionId,task.rows[0]?.id??null,task.rows[0]?.goal_id??occurrence.goalId??null,timer!.started_at,endedAt,minutes,notes,occurrence.id]);
      if(!preserveAttendance)await finishScheduleTimer(client,{id:sessionId,date:timer!.schedule_date!,occurrence,start:timer!.started_at,end:endedAt});
      if(task.rows[0])await client.query(`UPDATE tasks SET actual_minutes=(SELECT COALESCE(SUM(minutes),0) FROM work_sessions WHERE task_id=$1),updated_at=$2 WHERE id=$1`,[task.rows[0].id,endedAt]);
    } else if (timer!.routine_id) {
      const session = routineSessionSchema.parse({ id: sessionId, date: timer!.routine_date, started_at: timer!.started_at, ended_at: endedAt, minutes, notes });
      const saved = await logRoutineSession(timer!.routine_id, session, client);
      savedMinutes = saved.minutes;
    } else {
      const task = await client.query('SELECT id,goal_id FROM tasks WHERE id=$1 FOR UPDATE', [timer!.task_id]);
      if (!task.rows.length) fail(409, 'The task was removed. Your timer is preserved.');
      await client.query(`INSERT INTO work_sessions (id,task_id,goal_id,started_at,ended_at,minutes,notes,source,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'timer',$5)`, [sessionId, timer!.task_id, task.rows[0].goal_id, timer!.started_at, endedAt, minutes, notes]);
      await client.query(`UPDATE tasks SET actual_minutes=(SELECT COALESCE(SUM(minutes),0) FROM work_sessions WHERE task_id=$1),
        status=CASE WHEN status IN ('todo','not_started','planned') THEN 'in_progress' ELSE status END, updated_at=$2 WHERE id=$1`, [timer!.task_id, endedAt]);
    }
    if(preserveAttendance&&timer!.schedule_occurrence_id){
      await client.query("UPDATE work_timers SET status='awaiting_end',attendance_only=true,focus_ended_at=$2,ended_at=NULL,notes=$3,updated_at=$2 WHERE id=$1",[sessionId,endedAt,notes]);
    }else await client.query("UPDATE work_timers SET status='stopped',ended_at=$2,notes=$3,updated_at=$2 WHERE id=$1", [sessionId, endedAt, notes]);
    await reconcileScheduleSessions(client);
    return { ...await getWorkTimer(client), minutes: savedMinutes, duplicate: false };
  };
  return existingClient?apply(existingClient):transaction(apply);
}

export async function changeWorkTimer(sessionId: string, notes: string | null) {
  return transaction(async client => {
    await lock(client);
    const result = notes === null
      ? await client.query("UPDATE work_timers SET status='discarded',ended_at=$2,updated_at=$2 WHERE id=$1 AND status IN ('running','awaiting_end') RETURNING id", [sessionId, new Date().toISOString()])
      : await client.query("UPDATE work_timers SET notes=$2,updated_at=$3 WHERE id=$1 AND status='running' RETURNING id", [sessionId, notes, new Date().toISOString()]);
    if (!result.rowCount && notes !== null) fail(409, 'This timer has stopped on another device');
    if(notes===null)await reconcileScheduleSessions(client);
    return getWorkTimer(client);
  });
}
