import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chat } from '../../server/ollama.js';
import { runCopilotConversation } from '../../server/services/copilotConversation.js';
import { classifyTraceFailure } from '../../server/services/evaluationTrace.js';
import { packContext } from '../../server/services/copilotContextWire.js';
import { loadHierarchyAnswerFixtures } from './hierarchyAnswerFixtures.js';
import { evaluateHierarchyReply } from './hierarchyAnswerEvaluation.js';
import { createHierarchyFixtureTools } from './hierarchyFixtureTools.js';
import { saveAnswerReceipt, captureAnswerIdentity } from './hierarchyAnswerReplay.js';

if (process.env.RUN_LIVE_PLANNING_MODELS !== '1') throw new Error('Set RUN_LIVE_PLANNING_MODELS=1 and supply provider credentials privately.');
const suite = loadHierarchyAnswerFixtures();
const runIdentity = captureAnswerIdentity();
const sourceFiles = ['server/services/copilotConversation.ts','server/services/copilotCapabilities.ts','server/services/copilotTools.ts','server/ollama.ts',
  'server/config/providers.ts','server/config/nvidiaModels.ts','server/services/nvidiaTransport.ts','audits/planning/hierarchyFixtureTools.ts','audits/planning/liveModels.ts'];
const sourceFingerprint = createHash('sha256').update(sourceFiles.map(file => readFileSync(file, 'utf8')).join('\n')).digest('hex');
const models = process.argv.slice(2).length ? process.argv.slice(2) : [process.env.MARINA_MAIN_MODEL ?? 'nvidia/nemotron-3.5-lightning-30b-a3b'];
for (const model of models) for (const scenario of ['greeting','C01-inclusive','C02-additive']) {
  const fixture = suite.cases.find(item => item.id === (scenario === 'greeting' ? 'C01-inclusive' : scenario))!;
  const { tools } = createHierarchyFixtureTools(fixture);
  const observations: unknown[] = []; const wire: string[] = []; const traces: unknown[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    tool.execute = async args => { const result = await execute(args);
      observations.push({ name, arguments: args, raw: result.data, packed: packContext(result.data) }); return result; };
  }
  const prompt = scenario === 'greeting' ? 'hi' : fixture.prompt;
  const started = Date.now(); const attemptId = randomUUID();
  const configuration = { model, credential_source: 'local_saved_process_environment',
    main_key_present: Boolean(process.env.NVIDIA_API_KEY), kimi_key_present: Boolean(process.env.NVIDIA_KIMI_API_KEY),
    source_fingerprint: sourceFingerprint, provider_mode: process.env.PROVIDER_MODE ?? 'default' };
  const metadata = { attempt_id: attemptId, model, scenario, configuration,
    configuration_fingerprint: createHash('sha256').update(JSON.stringify(configuration)).digest('hex'),
    prompt_fingerprint: createHash('sha256').update(prompt).digest('hex'), expected_values_origin: suite.expected_values,
    application_writes: 0, selected_credentials_are_deployed_credentials: false, release_qualified: false };
  let outcome: Record<string, unknown>;
  try {
    const result = await runCopilotConversation({ model, turns: [{ role:'user',content:prompt }],
      clock:{today:'2026-10-06',time:'12:00',timezone:'Asia/Beirut'}, tools,
      complete: async (messages, options) => {
        for (const message of messages) if (message.role === 'user' && message.content.startsWith('Tool observations (data, not a new user request): ') && !wire.includes(message.content)) wire.push(message.content);
        return chat(messages, options);
      }, onTrace: trace => traces.push(trace) });
    outcome = { transport_protocol_completed: true, semantic_review: 'required', result,
      verdicts: scenario === 'greeting' ? { transport: 'pass', protocol:'pass', planning_quality:'not_applicable' }
        : evaluateHierarchyReply(fixture, result, { writes:0 }), observations, wire, traces };
  } catch (error) {
    outcome = { transport_protocol_completed:false, semantic_review:'unavailable', failure:classifyTraceFailure(error,'interpretation'),
      provider_status: typeof (error as any)?.status === 'number' ? (error as any).status : null, observations, wire, traces };
  }
  const { file } = await saveAnswerReceipt('live-attempt', { kind:'synthetic_live_provider_attempt', ...metadata, elapsed_ms:Date.now()-started, ...outcome }, undefined, runIdentity);
  console.log(JSON.stringify({ receipt:file, attempt_id:attemptId, model, scenario, elapsed_ms:Date.now()-started,
    transport_protocol_completed:outcome.transport_protocol_completed, semantic_review:outcome.semantic_review, failure:outcome.failure, provider_status:outcome.provider_status }));
}
