import { z } from 'zod';

export const PLANNING_LIMITS = { bytes: 256 * 1024, depth: 16, nodes: 10000, array: 1000 } as const;
export const planningId = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\u0000-\u001f]/.test(value), 'Invalid identifier');
const ref = <K extends string>(kind: K) => z.object({ kind: z.literal(kind), id: planningId }).strict();
export const taskReferenceSchema = ref('task');
export const goalReferenceSchema = ref('goal');
export const resourceReferenceSchema = ref('resource');
export const workItemReferenceSchema = ref('work_item');
export const planningReferenceSchema = z.discriminatedUnion('kind', [taskReferenceSchema, goalReferenceSchema, resourceReferenceSchema, workItemReferenceSchema]);
export const entityReferenceSchema = z.discriminatedUnion('kind', [taskReferenceSchema, goalReferenceSchema, resourceReferenceSchema, ref('milestone'), ref('routine')]);
export type EntityReference = z.infer<typeof entityReferenceSchema>;
export type PlanningReference = z.infer<typeof planningReferenceSchema>;
export const referenceKey = (value: { kind: string; id: string }) => JSON.stringify([value.kind, value.id]);

export const planningMinutesSchema = z.number().finite().nonnegative().max(365 * 24 * 60);
export const effortSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown'), minutes: z.null() }).strict(),
  z.object({ state: z.literal('known'), minutes: planningMinutesSchema, basis: z.enum(['user', 'measured', 'estimate']) }).strict(),
  z.object({ state: z.literal('range'), low: planningMinutesSchema, central: planningMinutesSchema, high: planningMinutesSchema }).strict()
    .refine(value => value.low <= value.central && value.central <= value.high, 'Effort range must be ordered'),
]);
export type PlanningEffort = z.infer<typeof effortSchema>;
export function effortLabel(value: PlanningEffort): string {
  if (value.state === 'unknown') return 'Not estimated';
  return value.state === 'range' ? `${value.low}–${value.high} min` : `${value.minutes} min`;
}
const pages = z.object({ from: z.number().int().positive(), to: z.number().int().positive() }).strict()
  .refine(value => value.to >= value.from, 'Page range must be ordered');
export const planningEvidenceSchema = z.object({
  resource: resourceReferenceSchema, state: z.enum(['unknown', 'partial', 'current', 'stale']),
  generation: z.number().int().positive().nullable(), pages: pages.nullable(),
}).strict().refine(value => value.state !== 'current' || value.generation !== null, 'Current evidence needs a source generation');
export const planningWorkItemSchema = z.object({
  reference: workItemReferenceSchema, title: z.string().trim().min(1).max(500),
  task: taskReferenceSchema.nullable(), effort: effortSchema,
  evidence: z.array(planningEvidenceSchema).max(100),
}).strict();
export const planningContextSchema = z.object({
  version: z.literal(1), root: z.discriminatedUnion('kind', [taskReferenceSchema, goalReferenceSchema]),
  references: z.array(planningReferenceSchema).max(200), work_items: z.array(planningWorkItemSchema).max(100),
}).strict().superRefine((value, ctx) => {
  const ids = value.work_items.map(item => referenceKey(item.reference));
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Duplicate work-item identifier' });
  const refs = value.references.map(referenceKey);
  if (new Set(refs).size !== refs.length) ctx.addIssue({ code: 'custom', message: 'Duplicate typed reference' });
});

/** Iterative guard runs before recursive schema parsing or tool execution. */
export function assertBoundedPayload(value: unknown, limits: { bytes: number; depth: number; nodes: number; array: number } = PLANNING_LIMITS): void {
  const stack = [{ value, depth: 0 }]; const seen = new WeakSet<object>(); let nodes = 0; let bytes = 0;
  const encoder = new TextEncoder();
  while (stack.length) {
    const current = stack.pop()!;
    if (++nodes > limits.nodes || current.depth > limits.depth) throw new Error('Payload exceeds structural limits');
    const item = current.value;
    if (typeof item === 'string') bytes += encoder.encode(item).byteLength + 2;
    else if (item && typeof item === 'object') {
      if (seen.has(item)) throw new Error('Payload must not contain cycles or shared object references');
      seen.add(item);
      if (Array.isArray(item) && item.length > limits.array) throw new Error('Payload contains too many entries');
      const entries = Object.entries(item);
      if (entries.length > limits.array) throw new Error('Payload contains too many entries');
      if (nodes + stack.length + entries.length > limits.nodes) throw new Error('Payload exceeds structural limits');
      bytes += 2;
      for (const [key, child] of entries) { bytes += encoder.encode(key).byteLength + 4; stack.push({ value: child, depth: current.depth + 1 }); }
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Payload numbers must be finite');
      bytes += 24;
    } else if (item === null || typeof item === 'boolean') bytes += 5;
    else if (item !== undefined) throw new Error('Payload must contain JSON values');
    if (bytes > limits.bytes) throw new Error('Payload exceeds size limit');
  }
  // Escaping can expand control characters sixfold. The iterative walk first
  // bounds allocation/depth; this final check enforces actual JSON wire bytes.
  if (encoder.encode(JSON.stringify(value)).byteLength > limits.bytes) throw new Error('Payload exceeds size limit');
}
export function readPlanningContext(value: unknown) {
  try { assertBoundedPayload(value); return { ok: true as const, data: planningContextSchema.parse(value) }; }
  catch { return { ok: false as const, error: 'Planning details could not be read. Reload the conversation to try again.' }; }
}
