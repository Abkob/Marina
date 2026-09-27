import { z } from 'zod';

const date = z.iso.date({ error: 'Use a valid YYYY-MM-DD date' });
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
  .refine(v => !v.preferred_time || Number(v.preferred_time.slice(0, 2)) * 60 + Number(v.preferred_time.slice(3)) + v.planned_minutes <= 1440, 'The preferred time and planned duration must fit before midnight')
  .describe('Native routine. For target_unit=minutes, target_count MUST equal planned_minutes (e.g. 20 minutes means both are 20). Weekdays must be unique ISO numbers. For weekly cadence, weekly_target cannot exceed selected weekdays. A preferred time plus planned duration must finish before midnight.');
export const updateRoutineSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), note: note.optional(), archived: z.literal(true).optional() }).strict().refine(v => Object.keys(v).length > 0, 'No changes supplied');
export const routineCheckInSchema = z.object({
  date, status: z.enum(['completed', 'skipped', 'pending']), completed_count: z.number().int().min(0).max(10000).optional(), notes: note.optional(),
}).strict();
export const routineSessionSchema = z.object({
  id: uuid, date, started_at: z.iso.datetime({ offset: true }), ended_at: z.iso.datetime({ offset: true }),
  minutes: z.number().int().min(1).max(1440), notes: note.optional(),
}).strict().refine(v => Date.parse(v.ended_at) >= Date.parse(v.started_at), 'Session end must follow start')
  .refine(v => v.minutes <= Math.ceil((Date.parse(v.ended_at) - Date.parse(v.started_at)) / 60000) + 1, 'Minutes exceed elapsed session time');
