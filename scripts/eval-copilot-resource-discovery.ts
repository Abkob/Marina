/** Opt-in real-model evaluation using entirely fictional source fixtures.
 * node --env-file=.env --import tsx scripts/eval-copilot-resource-discovery.ts
 * No database, Drive or application writes. Report goes to ignored tmp/.
 */
import fs from 'node:fs/promises';
import { createCopilotTools } from '../server/services/copilotTools.js';
import { runCopilotConversation, type ConversationTurn } from '../server/services/copilotConversation.js';
import { CHAT_MODEL } from '../server/ollama.js';

const url = (id: string) => `https://drive.google.com/file/d/synthetic-${id}/view`;
const book = { id: 'geometry', title: 'Foundations of Abstract Algebra', status: 'ready' };
const other = { id: 'workbook', title: 'Algebra Workbook', status: 'ready' };
const unrelated = { id: 'gardening', title: 'Garden notebook', status: 'ready' };
const passage = (id: string, title: string, page: number, text: string) => ({ resource_id: id, title, chunk_id: `${id}-${page}`, passage: text, page_start: page, page_end: page, source_url: url(id) });
const mainEvidence = passage(book.id, book.title, 37, 'Section 4.2: Rigid motions. These motions preserve distances between points. Rotations and reflections that preserve a regular polygon form its dihedral group.');
const misleadingEvidence = passage(book.id, book.title, 65, 'Section 6: Group isomorphisms. An isomorphism is a bijective homomorphism between groups. This section concerns algebraic structure, not distance-preserving geometric motions.');
const secondEvidence = passage(other.id, other.title, 82, 'Lesson 8: Symmetries of polygons. Distance-preserving rotations and reflections form dihedral groups.');
const question = 'which pages in introduction to linear algebra are introducing isometric groups';
const cases: Array<{ name: string; turns: ConversationTurn[]; ambiguous?: boolean }> = [
  { name: 'approximate-title-and-topic', turns: [{ role: 'user', content: question }] },
  { name: 'correction-after-title-dead-end', turns: [{ role: 'user', content: question }, { role: 'assistant', content: 'No file has that exact title. Please provide the exact document name.' }, { role: 'user', content: 'its in the resource librarr=y' }] },
  { name: 'topic-without-a-filename', turns: [{ role: 'user', content: 'where in my resources does it explain motions that keep distances unchanged?' }] },
  { name: 'two-plausible-books', turns: [{ role: 'user', content: question }], ambiguous: true },
];
const report: Array<{ passed: boolean; [key: string]: unknown }> = [];
for (const test of cases.filter(test => !process.argv[2] || test.name === process.argv[2])) {
  const sources = [book, ...(test.ambiguous ? [other] : []), unrelated];
  const evidence = [mainEvidence, ...(test.ambiguous ? [secondEvidence] : [])];
  // Real embeddings can confuse similar terms. The assistant must follow the
  // contents or reformulate the topic instead of equating isometry/isomorphism.
  const rankedEvidence = (query: unknown) => /rigid|distance|rotation|reflection|symmetr/i.test(String(query)) || test.ambiguous ? evidence : [misleadingEvidence];
  const preview = (source: typeof book, page: number) => ({ resource_id: source.id, title: source.title, source_url: url(source.id), status: 'ready',
    passages: [passage(source.id, source.title, 1, `${source.title}. Fictional author: Avery Example.`), passage(source.id, source.title, 4, `Contents: Rigid motions and dihedral groups begin on physical PDF page ${page}.`)], has_more: true, next_after_chunk: 1 });
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const unavailable = async () => { throw new Error('Unavailable in synthetic evaluation'); };
  const tools = createCopilotTools({ workspace: unavailable, previewSchedule: unavailable, previewRoutine: unavailable, scheduleDay: unavailable, overdueTasks: unavailable });
  // Override every tool before opting in fixtures. Future tools cannot reach DB.
  for (const tool of Object.values(tools)) tool.execute = unavailable;
  tools.find_resources.execute = async args => ({ data: {
    resources: sources.filter(row => !args.search || String(args.search).toLowerCase().split(/\s+/).every(word => row.title.toLowerCase().includes(word)) || rankedEvidence(args.query ?? args.search).some(hit => hit.resource_id === row.id)),
    title_matches: sources.filter(row => !args.search || String(args.search).toLowerCase().split(/\s+/).every(word => row.title.toLowerCase().includes(word))),
    has_more: false, next_after: null,
    ...(args.search || args.query ? { evidence: rankedEvidence(args.query ?? args.search), previews: [preview(book, 37), ...(test.ambiguous ? [preview(other, 82)] : [])], semantic_discovery: { vector_degraded: false, coverage: { exhaustive: false }, candidate_resource_ids: evidence.map(row => row.resource_id) },
      hint: 'resources are discovered candidates; title_matches lists literal matches separately. Empty title_matches does not mean a source is missing. Evaluate the evidence and opening previews; follow relevant contents sections with read_document without asking permission. Disclose title differences; similarity is not proof of identity.' } : {}),
  } });
  tools.workspace_context.execute = async () => ({ data: { resources: sources } });
  tools.search_documents.execute = async args => ({ data: { evidence: rankedEvidence(args.query).filter(row => !(args.resource_ids as string[] | undefined)?.length || (args.resource_ids as string[]).includes(row.resource_id)), coverage: { exhaustive: false } } });
  tools.read_document.execute = async args => {
    const source = sources.find(row => row.id === args.resource_id);
    if (!source) throw new Error('Unknown synthetic source');
    const relevant = evidence.find(row => row.resource_id === source.id);
    const page = args.page as number | undefined;
    const rows = relevant ? page === undefined
      ? [passage(source.id, source.title, 1, `${source.title}. Fictional author: Avery Example.`), passage(source.id, source.title, 4, `Contents: Rigid motions and dihedral groups begin on physical PDF page ${relevant.page_start}.`)]
      : page === relevant.page_start ? [relevant] : page === 65 && source.id === book.id ? [misleadingEvidence] : [] : [passage(source.id, source.title, 1, 'Notes on watering basil.')];
    return { data: { resource_id: source.id, title: source.title, source_url: url(source.id), status: 'ready', passages: rows.map((row, index) => ({ ...row, chunk_index: index })), has_more: false } };
  };
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    tool.execute = async args => { calls.push({ name, args }); return execute(args); };
  }
  const start = Date.now();
  try {
    const result = await runCopilotConversation({ turns: test.turns, clock: { today: '2026-10-02', time: '12:00', timezone: 'UTC' }, model: CHAT_MODEL, tools });
    const read = result.document_citations.some(row => row.entity_id === book.id && row.page_start === 37);
    const answered = /37/.test(result.reply) && result.reply.includes(book.title) && !/isometr(?:y|ies|ic).*\b65\b/.test(result.reply);
    const ambiguityHandled = result.conversation.needs_clarification || [book, other].every(source => result.reply.includes(source.title) && result.document_citations.some(row => row.entity_id === source.id));
    report.push({ name: test.name, passed: result.actions.length === 0 && read && (test.ambiguous ? ambiguityHandled : answered && !result.conversation.needs_clarification), ms: Date.now() - start, calls, result });
  } catch (error) { report.push({ name: test.name, passed: false, ms: Date.now() - start, calls, error: String(error) }); }
  const row = report.at(-1)!;
  console.log(JSON.stringify(row));
  await fs.mkdir('tmp', { recursive: true });
  await fs.writeFile('tmp/copilot-resource-discovery-eval.json', JSON.stringify({ model: CHAT_MODEL, at: new Date().toISOString(), cases: report }, null, 2));
}
process.exitCode = report.every(row => row.passed) ? 0 : 1;
