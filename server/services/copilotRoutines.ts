import { z } from 'zod';
import { query } from '../db.js';
import { activeGoalSql } from '../utils/archiveVisibility.js';
import { listRoutineEntries } from './routines.js';
import { addRoutineDays, routineWeekStart, routineProgress, routineReservations } from '../../src/utils/routines.js';
import type { DBRoutine } from '../../src/types/routines.js';

export const readRoutinesSchema = z.object({
  from: z.iso.date().optional(), to: z.iso.date().optional(),
  routine_ids: z.array(z.string().uuid()).min(1).max(20).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  include_archived: z.boolean().optional(), after: z.string().uuid().optional(),
}).strict().refine(v => (!v.from && !v.to) || (v.from && v.to && v.to >= v.from && Date.parse(v.to) - Date.parse(v.from) <= 31 * 86_400_000),
  'Supply both from and to for an ordered range of at most 32 days, or omit both for today through the next six days.');

export async function readCopilotRoutines(args: z.infer<typeof readRoutinesSchema>, today: string) {
  const from = args.from ?? today;
  const to = args.to ?? addRoutineDays(from, 6);
  const limit = args.limit ?? 50;
  const values: unknown[] = [];
  const where = [activeGoalSql('r.goal_id')];
  if (!args.include_archived) where.push('r.archived_at IS NULL');
  if (args.routine_ids) { values.push(args.routine_ids); where.push(`r.id = ANY($${values.length})`); }
  if (args.search) {
    values.push(`%${args.search.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(r.title ILIKE $${values.length} OR r.note ILIKE $${values.length})`);
  }
  if (args.after) { values.push(args.after); where.push(`r.id > $${values.length}`); }
  values.push(limit + 1);
  const { rows } = await query(`SELECT r.*, g.title AS goal_title FROM routines r LEFT JOIN goals g ON g.id=r.goal_id
    WHERE ${where.join(' AND ')} ORDER BY r.id LIMIT $${values.length}`, values);
  const routines = rows.slice(0, limit) as unknown as DBRoutine[];
  const ids = new Set(routines.map(routine => routine.id));
  // Whole boundary weeks are required for flexible weekly quotas. Use exactly
  // the same deterministic progress/reservations as the routine UI and scheduler.
  const historyFrom = routineWeekStart(from);
  const historyTo = addRoutineDays(routineWeekStart(to), 6);
  const entries = (await listRoutineEntries(historyFrom, historyTo)).filter(entry => ids.has(entry.routine_id));
  return { from, to, routines, entries, history_from: historyFrom, history_to: historyTo,
    progress_on_from: routines.map(routine => ({ routine_id: routine.id, date: from, ...routineProgress(routine, entries, from) })),
    reservations: routineReservations(routines, entries, from, to, today),
    coverage: { returned: routines.length, limit, has_more: rows.length > limit, next_after: rows.length > limit ? routines.at(-1)!.id : null,
      include_archived: args.include_archived ?? false },
  };
}
