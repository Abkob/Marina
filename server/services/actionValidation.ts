import { z } from 'zod';
import { createRoutineSchema, updateRoutineSchema, routineCheckInSchema, routineIdSchema } from './routineContracts.js';

// ─── Model action validation ─────────────────────────────────────────────────
// The model's proposed actions are untrusted output. Strict discriminated
// schemas reject unknown action types and unknown fields before anything is
// stored as a proposal.

const isoDate = z.iso.date({ error: 'must be a valid YYYY-MM-DD date' });
// Long-running study/research tasks already exist in the product and are
// intentionally split across many sessions. The old 24-hour cap rejected
// legitimate updates such as "this task needs 60 hours".
const taskEstimateMinutes = z.number().int().positive().max(365 * 24 * 60);

export const ActionParamsSchemas: Record<string, z.ZodTypeAny> = {
  create_routine: createRoutineSchema,
  update_routine: z.object({ routine_id: routineIdSchema, changes: updateRoutineSchema }).strict(),
  check_in_routine: z.object({ routine_id: routineIdSchema, entry: routineCheckInSchema }).strict(),
  create_task: z.object({
    goal_id: z.string().optional(),
    parent_task_id: z.string().optional(),
    milestone_id: z.string().optional(),
    title: z.string().min(1).max(500),
    due_date: isoDate.optional(),
    start_date: isoDate.optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    estimated_minutes: taskEstimateMinutes.optional(),
    status: z.enum(['todo', 'in_progress', 'blocked', 'done']).optional(),
  }).strict(),
  break_down_task: z.object({
    parent_task_id: z.string().min(1),
    tasks: z.array(z.object({
      title: z.string().min(1).max(500),
      due_date: isoDate.optional(),
      start_date: isoDate.optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      estimated_minutes: taskEstimateMinutes.optional(),
    }).strict()).min(2).max(12),
  }).strict(),
  update_task: z.object({
    task_id: z.string().min(1),
    due_date: isoDate.nullable().optional(),
    start_date: isoDate.nullable().optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    status: z.enum(['todo', 'in_progress', 'blocked', 'done']).optional(),
    estimated_minutes: taskEstimateMinutes.optional(),
    milestone_id: z.string().nullable().optional(),
  }).strict(),
  create_goal: z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(5000).optional(),
    deadline: isoDate.optional(),
    start_date: isoDate.optional(),
    category: z.string().max(100).optional(),
  }).strict(),
  create_goal_with_tasks: z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(5000).optional(),
    deadline: isoDate.optional(),
    start_date: isoDate.optional(),
    category: z.string().max(100).optional(),
    tasks: z.array(z.object({
      title: z.string().min(1).max(500),
      due_date: isoDate.optional(),
      start_date: isoDate.optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      estimated_minutes: taskEstimateMinutes.optional(),
      status: z.enum(['todo', 'in_progress', 'blocked', 'done']).optional(),
    }).strict()).min(1).max(20),
  }).strict(),
  update_goal: z.object({
    goal_id: z.string().min(1),
    deadline: isoDate.nullable().optional(),
    status: z.enum(['Safe', 'Watch', 'Risky']).optional(),
  }).strict(),
  create_milestone: z.object({
    goal_id: z.string().min(1),
    title: z.string().min(1).max(500),
    description: z.string().max(5000).optional(),
    due_date: isoDate.optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }).strict(),
  // Attach an existing library resource to a goal/task/milestone (creates an
  // 'attached_to' edge). Used when the user uploads a file in chat and asks
  // for it to be filed somewhere.
  attach_resource: z.object({
    resource_id: z.string().min(1),
    target_type: z.enum(['goal', 'task', 'milestone']),
    target_id: z.string().min(1),
  }).strict(),
  // Ask for a visual schedule plan: the server runs the deterministic
  // scheduler over the requested window and the chat response carries an
  // interactive calendar payload. NOT a durable proposal — the user applies
  // or discards it from the plan widget in the conversation. The window is
  // whatever the user meant: a horizon, a specific day, a date range, part of
  // a day, or "the next N hours" (resolved against the server clock).
  plan_schedule: z.object({
    task_id: z.string().min(1).optional(),
    task_ids: z.array(z.string().min(1)).min(1).max(30).optional(),
    max_daily_minutes: z.number().int().min(15).max(960).optional(),
    horizon_days: z.number().int().min(1).max(90).optional(),
    from_date: isoDate.optional(),
    to_date: isoDate.optional(),
    start_hour: z.number().min(0).max(23.75).optional(),
    end_hour: z.number().min(0.25).max(24).optional(),
    relative_hours: z.number().min(0.5).max(16).optional(),
  }).strict(),
  // Model-selected semantic move of records already assigned to one date.
  // Canonical database matching happens only after the user confirms it.
  move_schedule_items: z.object({
    source_date: isoDate,
    target_date: isoDate,
    entity_types: z.array(z.enum(['tasks', 'deadlines', 'events'])).min(1).max(3),
    preserve_event_times: z.literal(true),
  }).strict().refine(params => params.source_date !== params.target_date, {
    message: 'source_date and target_date must differ',
  }),
  // Repeating calendar events are separate from native tracked routines.
  // Used only by the repeating-block preview, never to emulate create_routine.
  create_block_series: z.object({
    title: z.string().min(1).max(200),
    start_date: isoDate,
    end_date: isoDate,
    start_hour: z.number().min(0).max(23.75),
    end_hour: z.number().min(0.25).max(24),
    days_of_week: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    task_id: z.string().optional(),
  }).strict(),
};

export interface ValidatedAction {
  id: string;
  type: string;
  description: string | null;
  params: Record<string, unknown>;
  proposal_id?: string;
  rejected_reason?: string;
}

// Fields where an explicit null on an UPDATE is a meaningful "clear this value".
// Everywhere else, real models emit null to mean "not set" (they routinely
// ignore "omit null fields" instructions), so nulls are stripped pre-validation.
const NULLABLE_UPDATE_FIELDS = new Set(['due_date', 'start_date', 'milestone_id', 'deadline']);

function normalizeParams(actionType: string, params: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...params };
  if (actionType === 'update_task') {
    // Models sometimes mirror the context vocabulary (`deadline`,
    // `remaining_minutes`) instead of the mutation schema. These two cases
    // are safe and unambiguous: deadline is an alias for the visible due date,
    // while remaining_minutes is derived/read-only and must never be written.
    if (!('due_date' in normalized) && 'deadline' in normalized) {
      normalized.due_date = normalized.deadline;
    }
    delete normalized.deadline;
    delete normalized.remaining_minutes;
  }
  const out: Record<string, unknown> = {};
  const isUpdate = actionType.startsWith('update_');
  for (const [k, v] of Object.entries(normalized)) {
    if (v === null && !(isUpdate && NULLABLE_UPDATE_FIELDS.has(k))) continue;
    out[k] = v;
  }
  return out;
}

/** Validates raw model actions; invalid ones are kept with a rejected_reason so the UI can be honest about what was dropped. */
export function validateModelActions(rawActions: unknown[]): ValidatedAction[] {
  const out: ValidatedAction[] = [];
  for (let i = 0; i < rawActions.length; i++) {
    const a = rawActions[i] as { id?: string; type?: string; description?: string; params?: Record<string, unknown> };
    const id = typeof a?.id === 'string' ? a.id : `a${i + 1}`;
    if (!a || typeof a.type !== 'string') {
      out.push({ id, type: String(a?.type ?? 'unknown'), description: null, params: {}, rejected_reason: 'missing action type' });
      continue;
    }
    const schema = ActionParamsSchemas[a.type];
    if (!schema) {
      out.push({ id, type: a.type, description: a.description ?? null, params: {}, rejected_reason: `unknown action type '${a.type}'` });
      continue;
    }
    const result = schema.safeParse(normalizeParams(a.type, a.params ?? {}));
    if (!result.success) {
      out.push({
        id, type: a.type, description: a.description ?? null, params: {},
        rejected_reason: result.error.issues.map(iss => `${iss.path.join('.')}: ${iss.message}`).join('; ').slice(0, 300),
      });
      continue;
    }
    out.push({ id, type: a.type, description: a.description ?? null, params: result.data as Record<string, unknown> });
  }
  return out;
}
