/** Explicit opt-in; synthetic prompts only, no DB/Drive reads or writes.
 * node --env-file=.env --import tsx scripts/check-nvidia-model.ts [model]
 * Does not substitute another model when the requested endpoint fails.
 */
import fs from 'node:fs/promises';
import { z } from 'zod';
import { chat, type ChatCallTrace } from '../server/ollama.js';
import { KIMI_MODEL } from '../server/config/nvidiaModels.js';
import { NvidiaError } from '../server/services/nvidiaTransport.js';
import { runCopilotConversation } from '../server/services/copilotConversation.js';

const model = process.argv[2] ?? KIMI_MODEL;
const report: Array<Record<string, unknown>> = [];
const traces: ChatCallTrace[] = [];
let started = Date.now();
try {
  const answer = await chat([{ role: 'user', content: 'What is 45 minus 25? Reply with the number only.' }],
    { model, max_tokens: 16_384, allowFallback: false, allowLocalFallback: false, onTrace: trace => traces.push(trace) });
  if (answer.trim() !== '20') throw new Error('Synthetic arithmetic answer did not match 20');
  report.push({ case: 'arithmetic', passed: true, ms: Date.now() - started });
  started = Date.now();
  let reads = 0;
  const result = await runCopilotConversation({ model,
    turns: [{ role: 'user', content: 'Read the synthetic-fixture document using read_document and tell me its test code and physical page number. Do not propose any changes.' }],
    clock: { today: '2026-10-02', time: '12:00', timezone: 'UTC' },
    onTrace: trace => traces.push(trace),
    tools: { read_document: {
      description: 'Read the only document, resource_id synthetic-fixture.',
      parameters: z.object({ resource_id: z.literal('synthetic-fixture') }),
      execute: async () => {
        reads++;
        return { data: { resource_id: 'synthetic-fixture', title: 'Synthetic test document', passages: [{ passage: 'The test code is NEBULA-731.', page_start: 13, page_end: 13 }] } };
      },
    } },
  });
  report.push({ case: 'read-and-answer', passed: reads === 1 && result.actions.length === 0 && /NEBULA-731/.test(result.reply) && /\b13\b/.test(result.reply), reads, ms: Date.now() - started });
} catch (error) {
  report.push({ case: report.length ? 'read-and-answer' : 'arithmetic', passed: false, ms: Date.now() - started,
    ...(error instanceof NvidiaError ? { code: error.code, status: error.status, request_id: error.requestId } : { code: 'EVALUATION_FAILED' }) });
}
const result = { model, at: new Date().toISOString(), cases: report, traces };
await fs.mkdir('tmp', { recursive: true });
const path = `tmp/nvidia-${model.replace(/[^a-z0-9-]/gi, '-')}-check.json`;
await fs.writeFile(path, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = report.length === 2 && report.every(row => row.passed) ? 0 : 1;
