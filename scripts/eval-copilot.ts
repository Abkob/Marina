/** Live model eval using synthetic data only. No database reads or writes.
 * Run: node --env-file=.env --import tsx scripts/eval-copilot.ts
 * Optional EVAL_CASE selects one case by name. Uses the configured chat model.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { runCopilotConversation, type ConversationTurn } from '../server/services/copilotConversation.js';
import { createCopilotTools } from '../server/services/copilotTools.js';
import { CHAT_MODEL, chat } from '../server/ollama.js';

const clock = { today: '2026-09-24', time: '10:00', timezone: 'Asia/Beirut' };
const tasks = [
  { id: 'thesis', title: 'Thesis draft', goal_id: 'phd', parent_task_id: null, due_date: '2026-09-30', estimated_minutes: 360, status: 'in_progress' },
  { id: 'slides', title: 'Seminar slides', goal_id: 'phd', parent_task_id: null, due_date: '2026-09-25', estimated_minutes: 120, status: 'todo' },
  { id: 'errands', title: 'Buy groceries', goal_id: null, parent_task_id: null, due_date: '2026-09-24', estimated_minutes: 45, status: 'todo' },
];
type Result = Awaited<ReturnType<typeof runCopilotConversation>>;
type Calls = Array<{ name: string; args: Record<string, unknown> }>;
const user = (content: string): ConversationTurn => ({ role: 'user', content });
const assistant = (content: string): ConversationTurn => ({ role: 'assistant', content });
const noChanges = (result: Result, calls: Calls) => result.actions.length === 0 && !calls.some(call => call.name.startsWith('preview_'));
const cases: Array<{ name: string; turns: ConversationTurn[]; check: (result: Result, calls: Calls) => boolean }> = [
  { name: 'casual-typos', turns: [user('heyy how r u')], check: (r, c) => noChanges(r, c) && c.length === 0 },
  { name: 'explanation-not-planning', turns: [user('what is the difference between a task deadline and putting it on my calendar?')], check: noChanges },
  { name: 'correction-stops-workflow', turns: [user('plan all my work next week'), assistant('I can distribute your tasks across the week.'), user('no stop i only wanted you to explain what scheduling enabled means dont plan anything')], check: noChanges },
  { name: 'ambiguous-referent', turns: [user('I have the thesis and seminar slides to handle.'), assistant('Both need time this week.'), user('move it to friday')], check: (r, c) => r.conversation.needs_clarification && noChanges(r, c) },
  { name: 'read-tomorrow', turns: [user('can i see my schedule for tomorow')], check: (r, c) => noChanges(r, c) && c.some(call => (call.name === 'show_schedule_day' && call.args.date === '2026-09-25') || (call.name === 'schedule_range' && call.args.from === '2026-09-25')) },
  { name: 'narrow-plan', turns: [user('Plan only my Thesis draft from September 28 to October 2, at most an hour a day. Leave everything else alone.')], check: (r, c) => c.some(call => call.name === 'preview_schedule' && (call.args.task_id === 'thesis' || JSON.stringify(call.args.task_ids) === '["thesis"]') && call.args.max_daily_minutes === 60 && call.args.from_date === '2026-09-28' && call.args.to_date === '2026-10-02') && !r.actions.length && 'plan' in r },
  { name: 'correction-keeps-target', turns: [user('Move the Thesis draft deadline to September 30.'), assistant('I can propose September 30 for Thesis draft.'), user('actually october 2 not september 30, and dont touch the slides')], check: (r, c) => r.actions.length === 1 && r.actions[0].type === 'update_task' && r.actions[0].params.task_id === 'thesis' && r.actions[0].params.due_date === '2026-10-02' && !r.actions[0].rejected_reason && !c.some(call => call.name.startsWith('preview_')) },
  // A bulk proposal uses the user's exact predicate; individual task changes
  // must use IDs grounded by a read. Do not prescribe a fixed tool sequence.
  { name: 'deadlines-only', turns: [user('Move every task deadline on September 25 to September 28, but keep calendar events and task start dates exactly where they are.')], check: (r, c) => r.actions.length > 0 && r.actions.every(action => !action.rejected_reason && (action.type === 'move_schedule_items' ? JSON.stringify(action.params.entity_types) === '["deadlines"]' && action.params.source_date === '2026-09-25' && action.params.target_date === '2026-09-28' : c.length > 0 && action.type === 'update_task' && action.params.task_id === 'slides' && action.params.due_date === '2026-09-28' && !('start_date' in action.params))) },
  { name: 'inspect-without-changing', turns: [user('Please list overdue work. Dont change any dates or make a plan.')], check: (r, c) => noChanges(r, c) && c.length > 0 },
  { name: 'resolved-followup', turns: [user('I need to adjust one deadline.'), assistant('Which task: Thesis draft or Seminar slides?'), user('the second one, next monday please, leave the first alone')], check: (r, c) => !c.some(call => call.name.startsWith('preview_')) && r.actions.length === 1 && r.actions[0].type === 'update_task' && r.actions[0].params.task_id === 'slides' && r.actions[0].params.due_date === '2026-09-28' && !r.actions[0].rejected_reason },
  { name: 'compare-not-change', turns: [user('Is my thesis due before or after the seminar slides? Just compare them.')], check: (r, c) => noChanges(r, c) && c.some(call => ['workspace_context', 'task_details'].includes(call.name)) },
];

const report: unknown[] = [];
let failures = 0;
for (const test of cases.filter(test => !process.env.EVAL_CASE || process.env.EVAL_CASE.split(',').includes(test.name))) {
  const calls: Calls = [];
  const tools = createCopilotTools({
    workspace: async () => ({ active_goals: [{ id: 'phd', title: 'PhD' }], tasks, planning_coverage: { total_incomplete: 3, tasks_in_context: 3 } }),
    previewSchedule: async args => ({ from: args.from_date, to: args.to_date, status: 'pending', blocks: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'].map(date => ({ task_id: 'thesis', title: 'Thesis draft', date, start_hour: 9, planned_minutes: 60 })), unplaced: [{ task_id: 'thesis', title: 'Thesis draft', minutes: 60 }], scheduler: { status: 'at_risk', gap_minutes: 60, deadline_conflict: 'Two blocks fall after the existing September 30 deadline; changing a deadline requires a separate proposal.' }, excluded_tasks: [] }),
    previewRoutine: async args => ({ from: args.start_date, to: args.end_date, status: 'pending', blocks: [] }),
    scheduleDay: async date => ({ date, capacity_minutes: 480, scheduled_events: [{ id: 'seminar', title: 'Seminar', start_hour: 11, duration_hours: 1 }], tasks_due: date === '2026-09-25' ? [tasks[1]] : [] }),
    overdueTasks: async () => ({ tasks: [] }),
  });
  tools.task_details.execute = async args => ({ data: { tasks: tasks.filter(task => (args.task_ids as string[]).includes(task.id)), missing_ids: (args.task_ids as string[]).filter(id => !tasks.some(task => task.id === id)) } });
  tools.find_tasks.execute = async args => ({ data: { tasks: tasks.filter(task => !args.search || String(args.search).toLowerCase().split(/\s+/).every(word => task.title.toLowerCase().includes(word))), coverage: { has_more: false, next_after: null } } });
  tools.schedule_range.execute = async args => ({ data: { from: args.from, to: args.to, tasks: tasks.filter(task => task.due_date >= String(args.from) && task.due_date <= String(args.to)), events: [{ id: 'seminar', title: 'Seminar', date: '2026-09-25', start_hour: 11, duration_hours: 1 }], meetings: [] } });
  tools.research_search.execute = async () => ({ data: { evidence: [] } });
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    tool.execute = async args => { calls.push({ name, args }); return execute(args); };
  }
  const started = Date.now();
  const modelCalls: Array<{ model: string; duration_ms: number }> = [];
  const rawResponses: string[] = [];
  try {
    const result = await runCopilotConversation({ turns: test.turns, clock, tools, model: CHAT_MODEL,
      complete: async (messages, options) => { const raw = await chat(messages, process.env.EVAL_UNCONSTRAINED_JSON === 'true' ? { ...options, jsonMode: false } : options); rawResponses.push(raw); return raw; },
      onTrace: trace => modelCalls.push(trace),
    });
    const passed = test.check(result, calls);
    if (!passed) failures++;
    const row = { name: test.name, passed, duration_ms: Date.now() - started, modelCalls, calls, result };
    report.push({ ...row, rawResponses });
    console.log(JSON.stringify(row));
  } catch (error) {
    failures++;
    const row = { name: test.name, passed: false, calls, error: String(error) };
    report.push({ ...row, rawResponses }); console.log(JSON.stringify(row));
  }
}
await mkdir('tmp', { recursive: true });
await writeFile(`tmp/copilot-eval${process.env.EVAL_CASE ? `-${process.env.EVAL_CASE}` : ''}.json`, JSON.stringify({ model: CHAT_MODEL, evaluated_at: new Date().toISOString(), failures, cases: report }, null, 2));
console.log(`Copilot eval: ${report.length - failures}/${report.length} passed with ${CHAT_MODEL}`);
process.exitCode = failures ? 1 : 0;
