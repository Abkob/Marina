/** Defaults to local prompt accounting. --live sends ONLY synthetic greetings and
 * app instructions to the selected model. No DB/Drive reads or fallback model.
 * node --env-file=.env --import tsx scripts/check-copilot-latency.ts [model] --live
 */
import fs from 'node:fs/promises';
import { chat, type ChatCallTrace, type ChatMessage } from '../server/ollama.js';
import { KIMI_MODEL } from '../server/config/nvidiaModels.js';
import { createCopilotTools } from '../server/services/copilotTools.js';
import { runCopilotConversation, COPILOT_CONVERSATION_POLICY } from '../server/services/copilotConversation.js';
import { compactSchema, CONTRACT_GUIDE } from '../server/services/copilotContracts.js';
import { CONTEXT_WIRE_GUIDE } from '../server/services/copilotContextWire.js';
import { COPILOT_FEATURES } from '../server/services/copilotFeatures.js';
import { ActionParamsSchemas } from '../server/services/actionValidation.js';
import { NvidiaError } from '../server/services/nvidiaTransport.js';

const unavailable = async () => { throw new Error('Real workspace access disabled in latency diagnostic'); };
const tools = createCopilotTools({ workspace: unavailable, previewSchedule: unavailable, previewRoutine: unavailable, scheduleDay: unavailable, overdueTasks: unavailable });
for (const tool of Object.values(tools)) tool.execute = unavailable;
let full: ChatMessage[] = [];
await runCopilotConversation({ turns: [{ role: 'user', content: 'hi' }], tools,
  clock: { today: '2026-10-02', time: '12:00', timezone: 'Asia/Beirut' },
  complete: async messages => {
    full = structuredClone(messages);
    return '{"reply":"Hi!","actions":[],"display":[],"needs_clarification":false}';
  },
});
const size = (value: unknown) => JSON.stringify(value).length;
const accounting = {
  policy: COPILOT_CONVERSATION_POLICY.length, features: size(COPILOT_FEATURES),
  contract_guide: CONTRACT_GUIDE.length, context_guide: CONTEXT_WIRE_GUIDE.length,
  tools: size(Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, { description: tool.description, parameters: compactSchema(tool.parameters) }]))),
  actions: size(Object.fromEntries(Object.entries(ActionParamsSchemas).filter(([name]) => !['plan_schedule', 'create_block_series'].includes(name)).map(([name, schema]) => [name, compactSchema(schema)]))),
  total_prompt_chars: full.reduce((sum, message) => sum + message.content.length, 0),
  tool_executions: 0, retrieved_document_chars: 0,
};
console.log(JSON.stringify({ accounting }));
if (process.argv.includes('--live')) {
  const model = process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? KIMI_MODEL;
  const cases: Array<Record<string, unknown>> = [];
  // Sequential sandwich helps expose provider changes without self-contention.
  for (const [name, messages] of [
    ['bare-hi', [{ role: 'user', content: 'hi' }]],
    ['marina-hi', full],
    ['bare-hi-repeat', [{ role: 'user', content: 'hi' }]],
  ] as Array<[string, ChatMessage[]]>) {
    const traces: ChatCallTrace[] = []; const started = Date.now();
    try {
      const answer = await chat(messages, { model, max_tokens: 16384, allowFallback: false, allowLocalFallback: false,
        deadlineMs: started + 90000, onTrace: trace => traces.push(trace) });
      cases.push({ name, success: true, answer_chars: answer.length, ms: Date.now() - started, traces });
    } catch (error) {
      cases.push({ name, success: false, ms: Date.now() - started, traces,
        ...(error instanceof NvidiaError ? { code: error.code, status: error.status, request_id: error.requestId } : { code: 'DIAGNOSTIC_FAILED' }) });
    }
    console.log(JSON.stringify(cases.at(-1)));
    await fs.mkdir('tmp', { recursive: true });
    await fs.writeFile(`tmp/copilot-latency-${model.replace(/[^a-z0-9-]/gi, '-')}.json`, JSON.stringify({ at: new Date().toISOString(), model, accounting, cases }, null, 2));
  }
  process.exitCode = cases.every(test => test.success) ? 0 : 1;
}
