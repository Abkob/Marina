import { z } from 'zod';
import { assertBoundedPayload, planningId, planningMinutesSchema } from './planningContracts.js';

const date = z.iso.date();
const hour = z.number().finite().min(0).max(24);
const duration = z.number().finite().positive().max(24);
const text = z.string().max(2000);
const count = z.number().int().nonnegative();
const shape = {
  kind: z.enum(['plan', 'series']).optional(), from: date, to: date,
  work_start: hour, work_end: hour,
  days: z.array(z.object({ date, available_minutes: planningMinutesSchema })).max(120),
  busy: z.array(z.object({ date, start_hour: hour, duration_hours: duration, title: text, kind: z.enum(['meeting', 'block']) })).max(1000),
  blocks: z.array(z.object({
    task_id: planningId.optional(), title: text, date, start_hour: hour, duration_hours: duration,
    planned_minutes: planningMinutesSchema.optional(), due_date: date.nullable().optional(),
    planning_role: z.enum(['overdue', 'due_on_block_day', 'due_in_window', 'before_deadline', 'no_deadline']).optional(),
  })).max(1000),
  unplaced: z.array(z.object({ task_id: planningId, title: text, minutes: planningMinutesSchema })).max(1000),
  needs_estimate: z.array(z.object({ task_id: planningId, title: text, suggested_minutes: planningMinutesSchema, basis: text, needs_date: z.boolean().optional() })).max(1000).optional(),
  // A negative gap is a shortage, not negative work effort.
  scheduler: z.object({ status: z.string().min(1).max(40), gap_minutes: z.number().finite(), unestimated_count: count, overflow_count: count }),
  status: z.enum(['pending', 'applied', 'discarded']).optional(),
  adjustments: z.record(z.string().regex(/^\d{1,4}$/), z.object({ date, start_hour: hour, removed: z.boolean().optional() })).optional(),
  clear_task_dates: z.array(date).max(120).optional(),
};
function validWindow(value: { from: string; to: string; work_start: number; work_end: number }) {
  const days = (Date.parse(value.to) - Date.parse(value.from)) / 86400000;
  return days >= 0 && days < 120 && value.work_start < value.work_end;
}
export const calendarPlanSchema = z.object(shape).refine(validWindow, 'Invalid calendar window');
export const calendarOptionsSchema = z.object({
  kind: z.literal('plan_options'), title: text, summary: text, advisory: text.nullable().optional(),
  options: z.array(z.object({ ...shape, option_id: planningId, name: text, description: text }).refine(validWindow, 'Invalid calendar window')).max(10),
}).refine(value => new Set(value.options.map(option => option.option_id)).size === value.options.length, 'Duplicate option identifier');
export const INVALID_PREVIEW_MESSAGE = 'This schedule preview could not be read. Reload the conversation to try again.';
export function readCalendarPreview(value: unknown) {
  try { assertBoundedPayload(value); return { ok: true as const, data: calendarPlanSchema.parse(value) }; }
  catch { return { ok: false as const, error: INVALID_PREVIEW_MESSAGE }; }
}
export function readCalendarOptions(value: unknown) {
  try { assertBoundedPayload(value); return { ok: true as const, data: calendarOptionsSchema.parse(value) }; }
  catch { return { ok: false as const, error: INVALID_PREVIEW_MESSAGE }; }
}
