/** Synthetic data only. --live measures provider tokens and fact reading with two
 * small completions. No database calls or real workspace information is sent.
 * node --env-file=.env --import tsx scripts/benchmark-copilot-context.ts --live
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { packContext, unpackContext, CONTEXT_WIRE_GUIDE } from '../server/services/copilotContextWire.js';
import { CONTRACT_GUIDE, compactSchema } from '../server/services/copilotContracts.js';
import { ActionParamsSchemas } from '../server/services/actionValidation.js';
import { createCopilotTools } from '../server/services/copilotTools.js';
import { CHAT_MODEL, chat, parseJSON, type ChatCallTrace } from '../server/ollama.js';

const date = (i: number) => `2026-10-${String(i + 1).padStart(2, '0')}`;
const tasks = Array.from({ length: 120 }, (_, i) => ({
  id: `task-${String(i).padStart(3, '0')}`, title: `Research experiment ${i}`,
  goal_id: `goal-${Math.floor(i / 30)}`, parent_task_id: i % 30 ? `task-${String(Math.floor(i / 30) * 30).padStart(3, '0')}` : null,
  milestone_id: `milestone-${Math.floor(i / 30)}`, status: i % 4 ? 'todo' : 'in_progress', priority: i % 3 ? 'medium' : 'high',
  start_date: null, due_date: date(i % 14), target_date: null, hard_deadline: null, deadline: date(i % 14), deadline_kind: 'due_date',
  estimated_minutes: i === 97 ? null : 120, remaining_minutes: i === 97 ? null : 90, logged_minutes: 30,
  feel_score: null, scheduling_enabled: true, kind: 'task', is_rollup: i % 30 === 0,
  blocker_ids: i % 30 > 1 ? [`task-${String(i - 1).padStart(3, '0')}`] : [], scheduled_blocks: [],
}));
const context = {
  today: '2026-09-24', planning_coverage: { total_incomplete: 120, tasks_in_context: 120, task_overview_limit: 200 },
  graph: { goals: Array.from({ length: 4 }, (_, i) => ({ id: `goal-${i}`, title: `Research project ${i}`, deadline: date(13), status: 'active' })), tasks },
  schedule_prefs: { daily_capacity_minutes: 480, buffer_ratio: 0.15, timezone: 'Asia/Beirut', work_days: [1, 2, 3, 4, 5] },
  capacity: Array.from({ length: 14 }, (_, i) => ({ date: date(i), raw_capacity_minutes: 480, reserved_buffer_minutes: 72, effective_capacity_minutes: 408, fixed_commitment_minutes: 60, available_after_fixed_minutes: 348, scheduled_minutes: i * 15, free_minutes: 348 - i * 15 })),
};
const packed = packContext(context);
assert.deepEqual(unpackContext(packed), context);

const tools = createCopilotTools({ workspace: async () => ({}), previewSchedule: async () => ({}), previewRoutine: async () => ({}), scheduleDay: async () => null, overdueTasks: async () => ({}) });
const schemas = { tools: Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, tool.parameters])), actions: Object.fromEntries(Object.entries(ActionParamsSchemas).filter(([name]) => !['plan_schedule', 'create_block_series'].includes(name))) };
const fullSchemas = JSON.stringify(Object.fromEntries(Object.entries(schemas).map(([group, entries]) => [group, Object.fromEntries(Object.entries(entries).map(([name, schema]) => [name, z.toJSONSchema(schema, { unrepresentable: 'any' })]))])));
const smallSchemas = CONTRACT_GUIDE + JSON.stringify(Object.fromEntries(Object.entries(schemas).map(([group, entries]) => [group, Object.fromEntries(Object.entries(entries).map(([name, schema]) => [name, compactSchema(schema)]))])));
const full = JSON.stringify(context);
const small = JSON.stringify(packed);
const report: Record<string, unknown> = {
  fixture: '120 synthetic tasks, 4 goals, 14 capacity days; identical facts before/after',
  fact_roundtrip: true,
  context_chars: { before: full.length, after: small.length, reduction_percent: +(100 * (1 - small.length / full.length)).toFixed(1) },
  schema_chars: { before: fullSchemas.length, after: smallSchemas.length, reduction_percent: +(100 * (1 - smallSchemas.length / fullSchemas.length)).toFixed(1) },
};
let failures = 0;
if (process.argv.includes('--live')) {
  const question = 'Return JSON only with these exact fields from the supplied facts: task096_parent, task096_blockers (array), task097_remaining_minutes, october03_free_minutes, timezone. Do not propose changes.';
  const expected = { task096_parent: 'task-090', task096_blockers: ['task-095'], task097_remaining_minutes: null, october03_free_minutes: 318, timezone: 'Asia/Beirut' };
  const live: unknown[] = [];
  for (const [name, data, guide] of [['plain_json', full, ''], ['compact_json', small, CONTEXT_WIRE_GUIDE]]) {
    const traces: ChatCallTrace[] = [];
    const output = await chat([{ role: 'system', content: `Read the synthetic workspace facts. ${guide}` }, { role: 'user', content: `${question}\nFacts: ${data}` }], { model: CHAT_MODEL, thinking: false, max_tokens: 350, jsonMode: false, allowFallback: false, allowLocalFallback: false, onTrace: trace => traces.push(trace) });
    let passed = false;
    try { assert.deepEqual(parseJSON(output), expected); passed = true; } catch { failures++; }
    live.push({ name, passed, traces, answer: parseJSON(output) });
  }
  report.live = live;
}
await mkdir('tmp', { recursive: true });
await writeFile(`tmp/copilot-context-benchmark${process.argv.includes('--live') ? '-live' : ''}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = failures ? 1 : 0;
