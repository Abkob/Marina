import { z } from 'zod';

// Test-only contracts. These are not the proposed P01 runtime planning schema.
const id = z.string().regex(/^f0000000-0000-4000-8000-\d{12}$/);
const minutes = z.number().int().nonnegative().max(100000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');
const interval = z.object({ id, day, start_minute: minutes.max(1439), end_minute: minutes.max(1440) }).strict()
  .refine(value => value.end_minute > value.start_minute, 'Interval must have positive length');
export const planningFixtureSchema = z.object({
  version: z.literal(1), key: z.enum(['no-resource', 'book', 'client-deliverable', 'mixed-work-study']),
  clock: z.object({ now: z.string().datetime(), timezone: z.literal('Asia/Beirut'), today: day }).strict(),
  goals: z.array(z.object({ id, title: z.string().min(1), deadline: day.nullable() }).strict()),
  tasks: z.array(z.object({ id, goal_id: id.nullable(), title: z.string().min(1), estimated_minutes: minutes.nullable(),
    logged_minutes: minutes, completed: z.boolean(), due_date: day.nullable() }).strict()),
  resources: z.array(z.object({ id, title: z.string(), task_id: id, generation: z.number().int().positive(),
    role: z.enum(['required', 'reference', 'optional']), content_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  evidence: z.array(z.object({ id, resource_id: id, generation: z.number().int().positive(), page: z.number().int().positive(),
    kind: z.enum(['text', 'visual']), excerpt: z.string().min(1) }).strict()),
  windows: z.array(interval), busy: z.array(z.object({ ...interval.shape, kind: z.enum(['reservation', 'meeting']), task_id: id.nullable() }).strict()
    .refine(value => value.end_minute > value.start_minute, 'Interval must have positive length')),
  work: z.array(z.object({ id, task_id: id, title: z.string().min(1), minutes, completed: z.boolean() }).strict()),
  expected: z.object({ free_minutes: minutes, remaining_minutes: minutes.nullable(),
    mandatory_evidence_ids: z.array(id), explanation: z.string().min(1) }).strict(),
}).strict().superRefine((fixture, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const all = [...fixture.goals, ...fixture.tasks, ...fixture.resources, ...fixture.evidence, ...fixture.windows, ...fixture.busy, ...fixture.work];
  if (new Set(all.map(row => row.id)).size !== all.length) fail('Duplicate fixture entity ID');
  for (const task of fixture.tasks) if (task.goal_id && !fixture.goals.some(goal => goal.id === task.goal_id)) fail('Task goal missing');
  for (const resource of fixture.resources) if (!fixture.tasks.some(task => task.id === resource.task_id)) fail('Resource requires a task identity');
  for (const row of [...fixture.work, ...fixture.busy]) if (row.task_id && !fixture.tasks.some(task => task.id === row.task_id)) fail('Work/calendar row requires a task identity');
  for (const evidence of fixture.evidence) if (!fixture.resources.some(resource => resource.id === evidence.resource_id && resource.generation === evidence.generation)) fail('Evidence source/version missing');
  for (const evidence of fixture.expected.mandatory_evidence_ids) if (!fixture.evidence.some(row => row.id === evidence)) fail('Expected evidence missing');
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: fixture.clock.timezone }).format(new Date(fixture.clock.now));
  if (local !== fixture.clock.today) fail('Clock day disagrees with timezone');
});
export type PlanningFixture = z.infer<typeof planningFixtureSchema>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
export function parsePlanningFixture(text: string): PlanningFixture {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid planning fixture JSON; no rows loaded'); }
  const parsed = planningFixtureSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid planning fixture: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
  return deepFreeze(parsed.data);
}
export function fixtureId(n: number) { return `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`; }

const clock = { now: '2026-10-06T09:00:00Z', timezone: 'Asia/Beirut', today: '2026-10-06' };
const makeInterval = (n: number, day: string, start: number, end: number) => ({ id: fixtureId(n), day, start_minute: start, end_minute: end });
const makeTask = (n: number, title: string, estimate: number | null, goal: number | null) => ({ id: fixtureId(n), goal_id: goal === null ? null : fixtureId(goal), title,
  estimated_minutes: estimate, logged_minutes: 0, completed: false, due_date: '2026-10-07' });
const base = { version: 1, clock, goals: [], tasks: [], resources: [], evidence: [], windows: [], busy: [], work: [] };
const report = { ...base, key: 'client-deliverable', goals: [{ id: fixtureId(30), title: 'Synthetic client report', deadline: '2026-10-07' }],
  tasks: [makeTask(31, 'Prepare the report', 120, 30)],
  resources: [{ id: fixtureId(32), title: 'Synthetic report brief', task_id: fixtureId(31), generation: 2, role: 'required', content_hash: 'b'.repeat(64) }],
  evidence: [{ id: fixtureId(33), resource_id: fixtureId(32), generation: 2, page: 1, kind: 'text', excerpt: 'Deliver calculations, figures, writing and review.' }],
  windows: [makeInterval(34, '2026-10-06', 1080, 1200), makeInterval(35, '2026-10-07', 1080, 1200)],
  busy: [{ ...makeInterval(36, '2026-10-06', 1080, 1110), kind: 'reservation', task_id: fixtureId(31) },
    { ...makeInterval(37, '2026-10-06', 1110, 1140), kind: 'meeting', task_id: null }],
  work: [
    { id: fixtureId(41), task_id: fixtureId(31), title: 'Calculations', minutes: 40, completed: true },
    { id: fixtureId(42), task_id: fixtureId(31), title: 'Figures', minutes: 30, completed: false },
    { id: fixtureId(43), task_id: fixtureId(31), title: 'Writing', minutes: 30, completed: false },
    { id: fixtureId(44), task_id: fixtureId(31), title: 'Review', minutes: 20, completed: false },
  ],
  expected: { free_minutes: 180, remaining_minutes: 80, mandatory_evidence_ids: [fixtureId(33)], explanation: 'Calculations confirmed complete; remaining work is 80; the 30-minute reservation is not completion.' } };

export const planningFixtures: readonly PlanningFixture[] = deepFreeze([
  { ...base, key: 'no-resource', tasks: [{ ...makeTask(1, 'Arrange an errand', null, null), due_date: null }],
    expected: { free_minutes: 0, remaining_minutes: null, mandatory_evidence_ids: [], explanation: 'No estimate, no deadline and no supplied calendar window; none is zero remaining work.' } },
  { ...base, key: 'book', goals: [{ id: fixtureId(10), title: 'Algebra practice', deadline: '2026-10-07' }], tasks: [makeTask(11, 'Prepare selected exercises', null, 10)],
    resources: [{ id: fixtureId(12), title: 'Synthetic Introduction to Algebra', task_id: fixtureId(11), generation: 1, role: 'reference', content_hash: 'a'.repeat(64) }],
    evidence: [{ id: fixtureId(13), resource_id: fixtureId(12), generation: 1, page: 94, kind: 'text', excerpt: 'Compare modular arithmetic and logical statements.' },
      { id: fixtureId(14), resource_id: fixtureId(12), generation: 1, page: 95, kind: 'visual', excerpt: 'Synthetic figure: three connected regions.' }],
    expected: { free_minutes: 0, remaining_minutes: null, mandatory_evidence_ids: [fixtureId(13)], explanation: 'A reference book does not imply reading every page or a known work duration.' } },
  report,
  { ...report, key: 'mixed-work-study', tasks: [...report.tasks, makeTask(38, 'Existing study commitment', 100, null)],
    busy: [...report.busy, { ...makeInterval(39, '2026-10-06', 1140, 1200), kind: 'reservation', task_id: fixtureId(38) },
      { ...makeInterval(40, '2026-10-07', 1080, 1120), kind: 'reservation', task_id: fixtureId(38) }],
    expected: { ...report.expected, free_minutes: 80 } },
].map(value => parsePlanningFixture(JSON.stringify(value))));

export function permuteFixture(fixture: PlanningFixture, seed: number): PlanningFixture {
  const copy = JSON.parse(JSON.stringify(fixture));
  let state = seed >>> 0;
  for (const key of ['goals', 'tasks', 'resources', 'evidence', 'windows', 'busy', 'work']) {
    for (let i = copy[key].length - 1; i > 0; i--) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const j = state % (i + 1); [copy[key][i], copy[key][j]] = [copy[key][j], copy[key][i]];
    }
  }
  return parsePlanningFixture(JSON.stringify(copy));
}

// Reusable test stories; they describe future planning states without claiming
// a P02/P16 plan UI has been built. Current cards are exercised with this evidence.
export const planningUiStates = deepFreeze([
  { state: 'absent', plan: null, evidence: [], actionEnabled: false },
  { state: 'loading', plan: null, evidence: [], actionEnabled: false },
  { state: 'partial_evidence', plan: null, evidence: planningFixtures[1].evidence.slice(0, 1), actionEnabled: false },
  { state: 'ready_plan', plan: { revision: 1 }, evidence: planningFixtures[1].evidence, actionEnabled: true },
  { state: 'stale_proposal', plan: { revision: 2, proposalRevision: 1 }, evidence: [], actionEnabled: false },
  { state: 'provider_failure', plan: null, evidence: [], actionEnabled: false },
]);
