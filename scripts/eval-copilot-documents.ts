/** Opt-in live NVIDIA evaluation against synthetic fixtures. No application DB access.
 * node --env-file=.env --import tsx scripts/eval-copilot-documents.ts
 * Saves only synthetic responses to ignored tmp/. Uses the current chat default.
 */
import fs from 'node:fs/promises';
import { createCopilotTools } from '../server/services/copilotTools.js';
import { runCopilotConversation } from '../server/services/copilotConversation.js';
import { inspectRenderedDocumentImage } from '../server/services/documentReading.js';
import { CHAT_MODEL } from '../server/ollama.js';

const image = `data:image/png;base64,${(await fs.readFile('audits/copilot/fixtures/visual-evidence.png')).toString('base64')}`;
const sources = [{ id: 'scan', title: 'Recovery scan', status: 'no_text' }, { id: 'a', title: 'Before study', status: 'ready' }, { id: 'b', title: 'After study', status: 'ready' }];
const sourceUrl = (id: string) => `https://drive.google.com/file/d/synthetic-${id}/view`;
const cases = [
  { name: 'scanned-identifier', question: 'In Recovery scan, transcribe the calibration code on page 1. Cite the page.', expected: /NEBULA-731/, mode: 'ocr' },
  { name: 'chart-comparison', question: 'In Recovery scan, visually inspect the chart on page 1. What are the before and after values, and their difference? Cite the page.', expected: /20/, mode: 'vision' },
  { name: 'multiple-files', question: 'Compare recovery in Before study and After study. Calculate the change in percentage points and cite both files.', expected: /20/, mode: null },
];
const report: unknown[] = [];
for (const test of cases) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tools = createCopilotTools({ workspace: async () => ({}), previewSchedule: async () => ({}), previewRoutine: async () => ({}), scheduleDay: async () => ({}), overdueTasks: async () => ({}) });
  // Override EVERY tool first: a new tool can never accidentally reach live data.
  for (const tool of Object.values(tools)) tool.execute = async () => { throw new Error('Unavailable in synthetic document evaluation'); };
  tools.workspace_context.execute = async () => ({ data: { resources: sources } });
  tools.find_resources.execute = async args => ({ data: { resources: sources.filter(row => !args.search || String(args.search).toLowerCase().split(/\s+/).every(word => row.title.toLowerCase().includes(word))), has_more: false } });
  tools.search_documents.execute = async args => ({ data: {
    evidence: sources.filter(row => ['a', 'b'].includes(row.id) && (args.resource_ids as string[] | undefined)?.includes(row.id)).map(row => ({ resource_id: row.id, title: row.title, chunk_id: `${row.id}-1`, passage: row.id === 'a' ? 'Before treatment recovery was 25%.' : 'After treatment recovery was 45%.', page_start: 1, page_end: 1, source_url: sourceUrl(row.id) })), coverage: { exhaustive: false },
  } });
  tools.read_document.execute = async args => {
    const row = sources.find(row => row.id === args.resource_id);
    if (!row) throw new Error('Unknown synthetic file');
    return { data: { resource_id: row.id, title: row.title, source_url: sourceUrl(row.id), status: row.status, has_more: false,
      passages: row.id === 'scan' ? [] : [{ chunk_id: `${row.id}-1`, chunk_index: 0, passage: row.id === 'a' ? 'Before treatment recovery was 25%.' : 'After treatment recovery was 45%.', page_start: 1, page_end: 1 }] } };
  };
  tools.inspect_document_page.execute = async args => {
    if (args.resource_id !== 'scan' || args.page !== 1) throw new Error('Unknown synthetic page');
    const result = await inspectRenderedDocumentImage({ dataUrl: image, question: String(args.question), mode: args.mode as 'ocr' | 'vision' | 'structure' });
    return { data: { ...result, resource_id: 'scan', title: 'Recovery scan', page_start: 1, page_end: 1, source_url: sourceUrl('scan'), coverage: 'Only page 1 inspected' } };
  };
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    tool.execute = async args => { calls.push({ name, args }); return execute(args); };
  }
  const start = Date.now();
  try {
    const result = await runCopilotConversation({ turns: [{ role: 'user', content: test.question }], clock: { today: '2026-10-02', time: '12:00', timezone: 'Asia/Beirut' }, tools, model: CHAT_MODEL });
    const serialized = JSON.stringify(result);
    const sourceCheck = test.mode ? calls.some(call => call.name === 'inspect_document_page' && call.args.mode === test.mode) && serialized.includes(sourceUrl('scan'))
      : ['a', 'b'].every(id => calls.some(call => call.name === 'read_document' && call.args.resource_id === id || call.name === 'search_documents' && (call.args.resource_ids as string[])?.includes(id)) && serialized.includes(sourceUrl(id)));
    const row = { name: test.name, passed: test.expected.test(serialized) && sourceCheck && result.actions.length === 0, ms: Date.now() - start, calls, result };
    report.push(row); console.log(JSON.stringify(row));
  } catch (error) { const row = { name: test.name, passed: false, ms: Date.now() - start, calls, error: String(error) }; report.push(row); console.log(JSON.stringify(row)); }
}
await fs.mkdir('tmp', { recursive: true });
await fs.writeFile('tmp/copilot-document-eval.json', JSON.stringify({ model: CHAT_MODEL, at: new Date().toISOString(), cases: report }, null, 2));
process.exitCode = report.some(row => !(row as { passed: boolean }).passed) ? 1 : 0;
