import crypto from 'node:crypto';
import { activeGoalSql } from '../utils/archiveVisibility.js';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import type { DBRoutine, DBRoutineEntry } from '../../src/types/routines.js';
import { addRoutineDays, isRoutineDate, routineEligibleOn } from '../../src/utils/routines.js';
import { localDateStr } from '../utils/localDate.js';

const date = z.string().refine(isRoutineDate, 'Use a valid YYYY-MM-DD date');
const uuid = z.string().uuid();
const note = z.string().max(10000);
export const routineIdSchema = uuid;
export const routineRangeSchema = z.object({ from: date, to: date }).refine(v => v.from <= v.to, 'from must not be after to');
export const createRoutineSchema = z.object({
  title: z.string().trim().min(1).max(200), note: note.default(''), goal_id: z.string().trim().min(1).max(200).nullable().default(null),
  cadence: z.enum(['daily', 'weekly']),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(days => new Set(days).size === days.length, 'Weekdays must be unique'),
  weekly_target: z.number().int().min(1).max(7).default(3),
  target_count: z.number().int().min(1).max(10000), target_unit: z.enum(['minutes', 'problems', 'pages', 'sessions']),
  planned_minutes: z.number().int().min(1).max(1440),
  preferred_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().default(null), start_date: date,
}).strict().refine(v => v.cadence !== 'weekly' || v.weekly_target <= v.weekdays.length, 'Weekly target cannot exceed selected days')
  .refine(v => v.target_unit !== 'minutes' || (v.target_count <= 1440 && v.planned_minutes === v.target_count), 'For minute targets, planned minutes must match the target and fit in one day')
  .refine(v => !v.preferred_time || Number(v.preferred_time.slice(0, 2)) * 60 + Number(v.preferred_time.slice(3)) + v.planned_minutes <= 1440, 'The preferred time and planned duration must fit before midnight');
export const updateRoutineSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), note: note.optional(), archived: z.literal(true).optional() }).strict().refine(v => Object.keys(v).length > 0, 'No changes supplied');
export const routineCheckInSchema = z.object({
  date, status: z.enum(['completed', 'skipped', 'pending']), completed_count: z.number().int().min(0).max(10000).optional(), notes: note.optional(),
}).strict();
export const routineSessionSchema = z.object({
  id: uuid, date, started_at: z.iso.datetime({ offset: true }), ended_at: z.iso.datetime({ offset: true }),
  minutes: z.number().int().min(1).max(1440), notes: note.optional(),
}).strict().refine(v => Date.parse(v.ended_at) >= Date.parse(v.started_at), 'Session end must follow start')
  .refine(v => v.minutes <= Math.ceil((Date.parse(v.ended_at) - Date.parse(v.started_at)) / 60000) + 1, 'Minutes exceed elapsed session time');

export class RoutineError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function routineTimezone(): Promise<string> {
  const { rows } = await query("SELECT timezone FROM user_schedule_prefs WHERE id='default'");
  return typeof rows[0]?.timezone === 'string' ? rows[0].timezone : 'Asia/Beirut';
}

async function routineToday(): Promise<string> {
  return localDateStr(await routineTimezone());
}

export function isRoutinesSchemaMissing(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  return (err.code === '42P01' && /(?:routines|routine_entries)/.test(err.message ?? ''))
    || (err.code === '42703' && /routine_id/.test(err.message ?? ''));
}

export async function listRoutines(): Promise<DBRoutine[]> {
  const { rows } = await query(`SELECT * FROM routines WHERE ${activeGoalSql()} ORDER BY created_at, id`);
  return rows as unknown as DBRoutine[];
}

export async function listRoutineEntries(from: string, to: string): Promise<DBRoutineEntry[]> {
  const { rows } = await query('SELECT * FROM routine_entries WHERE date >= $1 AND date <= $2 ORDER BY date, routine_id', [from, to]);
  return rows as unknown as DBRoutineEntry[];
}

export async function createRoutine(input: z.infer<typeof createRoutineSchema>): Promise<DBRoutine> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const { rows } = await query(`INSERT INTO routines
    (id,title,note,goal_id,cadence,weekdays,weekly_target,target_count,target_unit,planned_minutes,preferred_time,start_date,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
  [id, input.title, input.note, input.goal_id, input.cadence, JSON.stringify(input.weekdays), input.weekly_target,
    input.target_count, input.target_unit, input.planned_minutes, input.preferred_time, input.start_date, now]);
  return rows[0] as unknown as DBRoutine;
}

export async function updateRoutine(id: string, input: z.infer<typeof updateRoutineSchema>): Promise<DBRoutine> {
  const now = new Date().toISOString();
  const cutoff = input.archived ? addRoutineDays(await routineToday(), 1) : null;
  const { rows } = await query(`UPDATE routines SET title=COALESCE($2,title), note=COALESCE($3,note),
    archived_at=CASE WHEN $4 THEN COALESCE(archived_at,$5) ELSE archived_at END,
    archived_on=CASE WHEN $4 THEN COALESCE(archived_on,$6) ELSE archived_on END,updated_at=$5 WHERE id=$1 RETURNING *`,
  [id, input.title ?? null, input.note ?? null, input.archived ?? false, now, cutoff]);
  if (!rows[0]) throw new RoutineError(404, 'Routine not found');
  return rows[0] as unknown as DBRoutine;
}

function requireActionable(routine: DBRoutine | undefined, date: string, sessionStartedAt?: string): asserts routine is DBRoutine {
  if (!routine) throw new RoutineError(404, 'Routine not found');
  // Archiving prevents new activity, but must not strand an already-running
  // timer. Its original eligible calendar date and pre-archive start survive.
  if (routine.archived_at && (!sessionStartedAt || !(Date.parse(sessionStartedAt) <= Date.parse(routine.archived_at)))) {
    throw new RoutineError(409, 'This routine is archived; its history is preserved');
  }
  if (!routineEligibleOn(routine, date)) throw new RoutineError(400, 'This date is not one of the routine’s selected days');
}

export async function checkInRoutine(id: string, input: z.infer<typeof routineCheckInSchema>): Promise<DBRoutineEntry | null> {
  if (input.status === 'completed' && input.date > await routineToday()) throw new RoutineError(400, 'Future routine days cannot be completed yet');
  return transaction(async client => {
    const { rows: routines } = await client.query('SELECT * FROM routines WHERE id=$1 FOR UPDATE', [id]);
    const routine = routines[0] as DBRoutine | undefined;
    requireActionable(routine, input.date);
    if (input.status === 'completed' && input.completed_count !== undefined && input.completed_count < routine.target_count) {
      throw new RoutineError(400, 'Completed count must reach the routine target');
    }
    const { rows: entries } = await client.query('SELECT * FROM routine_entries WHERE routine_id=$1 AND date=$2', [id, input.date]);
    const existing = entries[0] as DBRoutineEntry | undefined;
    const minutes = Number(existing?.minutes ?? 0);
    // Undo never deletes logged focus time: only the explicit completion/skip is undone.
    if (input.status === 'pending' && minutes === 0) {
      await client.query('DELETE FROM routine_entries WHERE routine_id=$1 AND date=$2', [id, input.date]);
      return null;
    }
    const status = input.status === 'pending' ? 'partial' : input.status;
    const count = status === 'completed' ? input.completed_count ?? routine.target_count
      : (routine.target_unit === 'minutes' ? minutes : 0);
    const now = new Date().toISOString();
    const { rows } = await client.query(`INSERT INTO routine_entries (id,routine_id,date,status,minutes,completed_count,notes,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
      ON CONFLICT (routine_id,date) DO UPDATE SET status=EXCLUDED.status,completed_count=EXCLUDED.completed_count,notes=EXCLUDED.notes,updated_at=EXCLUDED.updated_at RETURNING *`,
    [existing?.id ?? crypto.randomUUID(), id, input.date, status, minutes, count, input.notes ?? existing?.notes ?? '', now]);
    return rows[0] as DBRoutineEntry;
  });
}

export async function logRoutineSession(id: string, input: z.infer<typeof routineSessionSchema>) {
  const timezone = await routineTimezone();
  if (input.date > localDateStr(timezone)) throw new RoutineError(400, 'Future routine days cannot have logged sessions');
  const startedAt = Date.parse(input.started_at);
  const endedAt = Date.parse(input.ended_at);
  if (startedAt > Date.now() + 30_000 || endedAt > Date.now() + 30_000) {
    throw new RoutineError(400, 'A focus session cannot start or finish in the future');
  }
  const startedDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(startedAt));
  if (input.date !== startedDate) throw new RoutineError(400, 'The routine date must match the focus start date in your schedule timezone');
  return transaction(async client => {
    const { rows: routines } = await client.query('SELECT * FROM routines WHERE id=$1 FOR UPDATE', [id]);
    const routine = routines[0] as DBRoutine | undefined;
    if (!routine) throw new RoutineError(404, 'Routine not found');
    const { rows: existingSession } = await client.query('SELECT id,routine_id,minutes FROM work_sessions WHERE id=$1', [input.id]);
    if (existingSession[0]) {
      if (existingSession[0].routine_id !== id) throw new RoutineError(409, 'Session ID belongs to a different activity');
      const { rows } = await client.query('SELECT * FROM routine_entries WHERE routine_id=$1 AND date=$2', [id, input.date]);
      return { id: input.id, entry: (rows[0] ?? null) as DBRoutineEntry | null, duplicate: true, minutes: Number(existingSession[0].minutes) };
    }
    requireActionable(routine, input.date, input.started_at);
    const now = new Date().toISOString();
    await client.query(`INSERT INTO work_sessions (id,routine_id,goal_id,started_at,ended_at,minutes,notes,source,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'timer',$8)`,
    [input.id, id, routine.goal_id, input.started_at, input.ended_at, input.minutes, input.notes ?? '', now]);
    const { rows: entries } = await client.query('SELECT * FROM routine_entries WHERE routine_id=$1 AND date=$2', [id, input.date]);
    const existing = entries[0] as DBRoutineEntry | undefined;
    const minutes = Number(existing?.minutes ?? 0) + input.minutes;
    const completed = existing?.status === 'completed' || (routine.target_unit === 'minutes' && minutes >= routine.target_count);
    const count = routine.target_unit === 'minutes' ? minutes : Number(existing?.completed_count ?? 0);
    const { rows } = await client.query(`INSERT INTO routine_entries (id,routine_id,date,status,minutes,completed_count,notes,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
      ON CONFLICT (routine_id,date) DO UPDATE SET status=EXCLUDED.status,minutes=EXCLUDED.minutes,completed_count=EXCLUDED.completed_count,updated_at=EXCLUDED.updated_at RETURNING *`,
    [existing?.id ?? crypto.randomUUID(), id, input.date, completed ? 'completed' : 'partial', minutes, count, existing?.notes ?? input.notes ?? '', now]);
    return { id: input.id, entry: rows[0] as DBRoutineEntry, duplicate: false, minutes: input.minutes };
  });
}
