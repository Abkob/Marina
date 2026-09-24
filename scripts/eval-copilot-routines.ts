/** Real-model feature eval with synthetic data only; no DB calls or mutations.
 * node --env-file=.env --import tsx scripts/eval-copilot-routines.ts
 * Optional EVAL_CASE=case-name[,case-name].
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createCopilotTools } from '../server/services/copilotTools.js';
import { runCopilotConversation } from '../server/services/copilotConversation.js';
import { addRoutineDays, routineProgress, routineReservations } from '../src/utils/routines.js';
import { CHAT_MODEL, chat } from '../server/ollama.js';
import type { DBRoutine, DBRoutineEntry } from '../src/types/routines.js';

const clock = { today: '2026-09-24', time: '10:00', timezone: 'Asia/Beirut' };
const routine: DBRoutine = { id: '11111111-1111-4111-8111-111111111111', title: 'Evening reading', note: '', goal_id: null,
  cadence: 'weekly', weekdays: [1,2,3,4,5,6,7], weekly_target: 3, target_count: 10, target_unit: 'pages', planned_minutes: 20,
  preferred_time: '20:00', start_date: '2026-09-21', archived_at: null, created_at: '', updated_at: '' };
const entries: DBRoutineEntry[] = [{ id: 'entry1', routine_id: routine.id, date: '2026-09-21', status: 'completed',
  minutes: 20, completed_count: 10, notes: '', created_at: '', updated_at: '' }];
type Result = Awaited<ReturnType<typeof runCopilotConversation>>;
type Calls = Array<{ name: string; args: Record<string, unknown> }>;
const nativeOnly = (r: Result, c: Calls) => !('plan' in r) && !c.some(call => call.name.startsWith('preview_'));
const validCreate = (r: Result, c: Calls) => nativeOnly(r,c) && !r.conversation.needs_clarification && r.actions.length === 1 && r.actions[0].type === 'create_routine' && !r.actions[0].rejected_reason;
const cases: Array<{ name: string; text: string; check: (r: Result, c: Calls) => boolean }> = [
  { name: 'daily-routine-typos', text: 'add a routin for 20min catchup evry weekday starting tomorow anytime, use the app routine feature',
    check: (r,c) => validCreate(r,c) && r.actions[0].params.cadence === 'daily' && JSON.stringify(r.actions[0].params.weekdays) === '[1,2,3,4,5]' && r.actions[0].params.target_count === 20 && r.actions[0].params.planned_minutes === 20 && r.actions[0].params.start_date === '2026-09-25' },
  { name: 'flexible-weekly-native', text: 'Create a Practice routine starting tomorrow: 3 sessions per week, any day is eligible, 5 problems per session, reserve 25 minutes, no fixed time.',
    check: (r,c) => validCreate(r,c) && r.actions[0].params.cadence === 'weekly' && r.actions[0].params.weekly_target === 3 && (r.actions[0].params.weekdays as unknown[]).length === 7 && r.actions[0].params.target_count === 5 && r.actions[0].params.target_unit === 'problems' && r.actions[0].params.planned_minutes === 25 && r.actions[0].params.preferred_time === null },
  { name: 'feature-discovery', text: 'Does this app have a feature for habits with progress tracking so missed days dont become overdue tasks? Explain it; dont add anything.',
    check: (r,c) => nativeOnly(r,c) && !r.actions.length && /routine/i.test(r.reply) && !/does not (?:currently )?(?:have|support)/i.test(r.reply) },
  { name: 'read-weekly-progress', text: 'How many Evening reading sessions do I have left this week? Do not change anything.',
    check: (r,c) => nativeOnly(r,c) && !r.actions.length && c.some(call => call.name === 'read_routines') && /(?:2|two)\b[^.]{0,60}\bsessions?\s+(?:left|remaining)/i.test(r.reply.replaceAll('**', '')) },
  { name: 'native-check-in', text: 'Mark my Evening reading routine complete for today. I read the 10 pages; do not log focus minutes or create a task.',
    check: (r,c) => nativeOnly(r,c) && r.actions.length === 1 && !r.actions[0].rejected_reason && r.actions[0].type === 'check_in_routine' && r.actions[0].params.routine_id === routine.id && (r.actions[0].params.entry as Record<string, unknown>).date === clock.today && (r.actions[0].params.entry as Record<string, unknown>).status === 'completed' },
  { name: 'honest-edit-limit', text: 'Change Evening reading from 3 to 4 times per week. Do not archive, replace, or recreate it.',
    check: (r,c) => nativeOnly(r,c) && !r.actions.length && /cannot|can’t|can't|immutable|not.*(?:edit|change|support)/i.test(r.reply) },
  { name: 'repeat-calendar-events', text: 'Make repeating calendar events called Office hours, Monday and Wednesday 9 to 10 AM, September 28 through October 9 2026. I want calendar blocks only, not a tracked routine.',
    check: (r,c) => !r.actions.length && 'plan' in r && c.some(call => call.name === 'preview_repeating_blocks' && call.args.start_date === '2026-09-28' && call.args.end_date === '2026-10-09' && call.args.start_hour === 9 && call.args.end_hour === 10) },
  { name: 'underspecified-routine', text: 'make me a routine for practice',
    check: (r,c) => nativeOnly(r,c) && !r.actions.length && r.conversation.needs_clarification },
  { name: 'archive-native-routine', text: 'Archive my Evening reading routine and preserve its history.',
    check: (r,c) => nativeOnly(r,c) && r.actions.length === 1 && !r.actions[0].rejected_reason && r.actions[0].type === 'update_routine' && r.actions[0].params.routine_id === routine.id && (r.actions[0].params.changes as Record<string, unknown>).archived === true },
];
const report: unknown[] = [];
let failures = 0;
for (const test of cases.filter(test => !process.env.EVAL_CASE || process.env.EVAL_CASE.split(',').includes(test.name))) {
  const calls: Calls = [];
  const tools = createCopilotTools({
    workspace: async () => ({ graph: { goals: [], tasks: [], milestones: [] } }),
    previewSchedule: async () => ({ blocks: [] }),
    previewRoutine: async args => ({ status: 'pending', from: args.start_date, to: args.end_date, blocks: [{ title: args.title, date: args.start_date, start_hour: args.start_hour, duration_hours: 1 }], unplaced: [] }),
    scheduleDay: async date => ({ date, events: [] }), overdueTasks: async () => ({ tasks: [] }),
  });
  // Replace every DB-backed read with an explicit synthetic observation.
  tools.read_routines.execute = async args => {
    const from = String(args.from ?? clock.today); const to = String(args.to ?? addRoutineDays(from, 6));
    return { data: { from, to, routines: [routine], entries,
      progress_on_from: [{ routine_id: routine.id, ...routineProgress(routine, entries, from) }],
      reservations: routineReservations([routine], entries, from, to, clock.today), coverage: { has_more: false, next_after: null } } };
  };
  for (const name of ['find_tasks','task_details','schedule_range','research_search']) tools[name].execute = async () => ({ data: { tasks: [], events: [], meetings: [], evidence: [], coverage: { has_more: false } } });
  for (const [name, tool] of Object.entries(tools)) { const execute = tool.execute; tool.execute = async args => { calls.push({ name, args }); return execute(args); }; }
  const started = Date.now();
  const rawResponses: string[] = [];
  try {
    const result = await runCopilotConversation({ turns: [{ role: 'user', content: test.text }], clock, tools, model: CHAT_MODEL,
      complete: async (messages, options) => { const raw = await chat(messages, options); rawResponses.push(raw); return raw; } });
    const passed = test.check(result,calls);
    if (!passed) failures++;
    const row = { name: test.name, passed, duration_ms: Date.now()-started, calls, result };
    report.push({ ...row, rawResponses }); console.log(JSON.stringify(row));
  } catch (error) { failures++; const row = { name: test.name, passed: false, error: String(error), calls }; report.push({ ...row, rawResponses }); console.log(JSON.stringify(row)); }
}
await mkdir('tmp', { recursive: true });
await writeFile('tmp/copilot-routines-eval.json', JSON.stringify({ model: CHAT_MODEL, failures, cases: report }, null, 2));
console.log(`Routine feature eval: ${report.length-failures}/${report.length} passed with ${CHAT_MODEL}`);
process.exitCode = failures ? 1 : 0;
