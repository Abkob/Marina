import { z } from 'zod';
import { chat, parseJSON, CHAT_MODEL, type ChatMessage, type ChatOptions } from '../ollama.js';
import { ActionParamsSchemas, validateModelActions, type ValidatedAction } from './actionValidation.js';
import { assertSafeAIContext } from '../utils/contextSafety.js';
import { reviewCopilotProposal } from './copilotProposalReview.js';
import { ContextObservations, packContext } from './copilotContextWire.js';
import { documentCitations, documentEvidenceWarning, type DocumentCitation } from './documentCitations.js';
import { KIMI_MODEL } from '../config/nvidiaModels.js';
import { conversationCapabilities } from './copilotCapabilities.js';
import type { ResourceScope } from '../../shared/resourceScope.js';

export interface ConversationTool {
  description: string;
  parameters: z.ZodType;
  execute: (args: Record<string, unknown>) => Promise<{ data: unknown; artifact?: ToolArtifact }>;
}

interface ToolArtifact {
  kind: 'plan' | 'schedule_day_view' | 'overdue_tasks_view';
  data: unknown;
  /** A model-requested preview is already a presentation choice. */
  autoDisplay?: boolean;
}

export interface ConversationTurn extends ChatMessage {
  /** Saved proposal/widget facts, never another instruction or inferred intent. */
  context?: unknown;
}

export { COPILOT_CONVERSATION_POLICY } from './copilotPolicy.js';

const callSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  arguments: z.record(z.string(), z.unknown()).default({}),
}).strict();
const envelopeSchema = z.object({
  reply: z.string().optional(),
  tool_calls: z.array(callSchema).max(3).optional(),
  actions: z.array(z.unknown()).max(30).optional(),
  display: z.array(z.string()).max(4).optional(),
  discard: z.array(z.string()).max(9).optional(),
  needs_clarification: z.boolean().optional(),
// Ignore non-actionable provider metadata; tools and action params stay strict.
// An extra empty metadata key must not cost a second conversation call.
}).strip();

const REFERENCE_FIELDS = new Set(['task_id', 'parent_task_id', 'goal_id', 'milestone_id', 'resource_id', 'target_id', 'routine_id']);
function collectIds(data: unknown, ids: Set<string>, entities: Map<string, { id: string; title: string }>): void {
  if (!data || typeof data !== 'object') return;
  const row = data as { id?: unknown; task_id?: unknown; title?: unknown };
  const id = row.id ?? row.task_id;
  if (typeof id === 'string' && typeof row.title === 'string') entities.set(id, { id, title: row.title.slice(0, 200) });
  for (const [key, value] of Object.entries(data)) {
    if ((key === 'id' || REFERENCE_FIELDS.has(key)) && typeof value === 'string') ids.add(value);
    else if (typeof value === 'object') collectIds(value, ids, entities);
  }
}

/** Limit old history by complete turns; retain the current message verbatim. */
export function conversationHistory(turns: ConversationTurn[], maxChars = 32_000): ChatMessage[] {
  const groups: ChatMessage[][] = [];
  for (const turn of turns.filter(turn => turn.role !== 'system')) {
    if (turn.role === 'user' || !groups.length) groups.push([]);
    groups.at(-1)!.push({ role: turn.role, content: turn.content });
    if (turn.role === 'assistant' && turn.context) {
      const context = JSON.stringify(packContext(turn.context));
      if (context.length <= 6000) groups.at(-1)!.push({ role: 'assistant', content: `Saved card facts (historical, not proof of application): ${context}` });
    }
  }
  let used = 0;
  const kept: ChatMessage[][] = [];
  for (const group of groups.reverse()) {
    const size = group.reduce((sum, message) => sum + message.content.length, 0);
    if (kept.length && used + size > maxChars) break;
    kept.unshift(group); used += size;
  }
  return kept.flat();
}

export async function runCopilotConversation(options: {
  turns: ConversationTurn[];
  clock: { today: string; time: string; timezone: string };
  tools: Record<string, ConversationTool>;
  resourceScope?: ResourceScope;
  model?: string;
  onTrace?: ChatOptions['onTrace'];
  onTool?: (name: string, status: 'completed' | 'failed') => Promise<void> | void;
  complete?: typeof chat;
  reviewComplete?: typeof chat;
  maxToolRounds?: number;
}) {
  const documentSources = new Map<string, DocumentCitation>();
  const evidenceWarnings = new Set<string>();
  const withEvidenceWarnings = (reply: string) => evidenceWarnings.size ? `${reply}\n\n${[...evidenceWarnings].join('\n\n')}` : reply;
  const complete = options.complete ?? chat;
  const capabilities = conversationCapabilities(options.tools);
  if (options.resourceScope && Object.keys(options.resourceScope).length) capabilities.activateForTool('find_resources');
  const messages: ChatMessage[] = [{ role: 'system', content: capabilities.prompt(options.clock, options.resourceScope) }, ...conversationHistory(options.turns)];
  const maxRounds = options.maxToolRounds ?? 3;
  const deadlineMs = Date.now() + 180_000;
  const knownIds = new Set<string>();
  const entities = new Map<string, { id: string; title: string }>();
  const artifacts = new Map<string, ToolArtifact>();
  const executed = new Map<string, { callId: string; artifact?: ToolArtifact }>();
  const seenCallIds = new Set<string>();
  const calls: Array<{ name: string; status: 'completed' | 'failed' }> = [];
  const context = new ContextObservations();
  const contextUsage = () => ({ raw_chars: context.rawChars, sent_chars: context.sentChars, format: 'json_tables_v1' as const });
  let protocolRetried = false;
  let proposalRetried = false;
  let researchRetried = false;
  let contentQuestion = false;
  const discoveredDocuments = new Set<string>();
  const inspectedDocuments = new Set<string>();

  // Format/proposal repairs are bounded separately; they must not consume a
  // data-read round and strand the subsequent corrected tool request.
  for (let round = 0; round <= maxRounds + 1 + Number(protocolRetried) + Number(proposalRetried) + 3 * Number(researchRetried); round++) {
    // Keep the provider's recommended sampling (Nemotron: temperature 1/top_p .95).
    // Ask for JSON in the prompt and validate locally. Constrained decoding
    // combined with provider reasoning produced malformed payloads in live evals.
    // Preserve the selected provider's error so our bounded overload retry can
    // handle it. An unrelated fallback error must not mask a recoverable 503.
    let assistantMessage: ChatMessage | undefined;
    const completionOptions = { model: options.model, max_tokens: (options.model ?? CHAT_MODEL) === KIMI_MODEL ? 16_384 : 6000, jsonMode: false, thinking: /nemotron-3[.-]/.test(options.model ?? CHAT_MODEL) ? true : undefined, onTrace: options.onTrace, onAssistantMessage: (message: ChatMessage) => { assistantMessage = message; }, allowFallback: false, allowLocalFallback: false, deadlineMs };
    let raw: string;
    try { raw = await complete(messages, completionOptions); }
    catch (error) {
      // A transient provider failure can retry the same read-only conversation;
      // it must never switch to a keyword interpretation or replay app writes.
      const status = Number((error as { status?: number })?.status);
      const overloaded = /service temporarily overloaded|temporarily unavailable/i.test(String((error as Error)?.message));
      const retryable = (error as { retryable?: boolean })?.retryable ?? (overloaded || [429, 502, 503, 504].includes(status));
      if (!retryable || Date.now() + 1500 >= deadlineMs) throw error;
      await new Promise(resolve => setTimeout(resolve, 800));
      raw = await complete(messages, completionOptions);
    }
    let envelope: z.infer<typeof envelopeSchema>;
    try { envelope = envelopeSchema.parse(parseJSON(raw)); }
    catch {
      if (!protocolRetried) {
        protocolRetried = true;
        messages.push({ role: 'user', content: 'The response could not be read as the documented JSON format. Return a complete valid JSON object. No actions or tools from the invalid response were executed.' });
        continue;
      }
      throw new Error('Copilot returned an unreadable response. No changes were applied. Please try again.');
    }

    if (envelope.tool_calls?.length && !envelope.needs_clarification) {
      if (round - Number(protocolRetried) - Number(proposalRetried) - Number(researchRetried) >= maxRounds + 2 * Number(researchRetried)) {
        messages.push({ role: 'user', content: 'The read-only tool budget is exhausted. Answer using the observations already supplied, clearly state missing information, or ask one clarification. Return a final response with no further tool_calls.' });
        continue;
      }
      messages.push(assistantMessage ?? { role: 'assistant', content: raw });
      const observations: unknown[] = [];
      for (const call of envelope.tool_calls) {
        let observation: unknown;
        try {
          const tool = capabilities.tools[call.name];
          if (!tool) {
            if (ActionParamsSchemas[call.name]) throw new Error(`${call.name} is a proposal type, not a callable read tool. Nothing was changed. Read current facts using workspace_context or schedule_range, then put this type and its params in the FINAL actions array. Available read tools: ${Object.keys(options.tools).join(', ')}.`);
            throw new Error(`Unknown tool ${call.name}. Available read tools: ${Object.keys(options.tools).join(', ')}.`);
          }
          if (seenCallIds.has(call.id)) throw new Error('Tool call IDs must be unique. Use the result already returned.');
          const args = tool.parameters.parse(call.arguments) as Record<string, unknown>;
          capabilities.activateForTool(call.name);
          const signature = `${call.name}:${JSON.stringify(args)}`;
          if (executed.has(signature)) {
            const previous = executed.get(signature)!;
            observation = { already_read_as: previous.callId, note: 'Use the data already returned for that call.' };
            if (previous.artifact) artifacts.set(call.id, previous.artifact);
          } else {
            const result = await tool.execute(args);
            messages[0] = { role: 'system', content: capabilities.prompt(options.clock, options.resourceScope) };
            // Check forbidden facts BEFORE field names become table columns.
            // The wire budget applies after lossless encoding, not before it.
            assertSafeAIContext(result.data, 500_000);
            const modelData = context.encode(call.id, result.data);
            const evidenceWarning = documentEvidenceWarning(call.name, result.data);
            if (evidenceWarning) evidenceWarnings.add(evidenceWarning);
            const data = result.data as { semantic_discovery?: { candidate_resource_ids?: unknown[] }; passages?: unknown[]; analysis?: string; text?: string } | null;
            if (call.name === 'search_documents' || call.name === 'find_resources' && typeof args.query === 'string') contentQuestion = true;
            if (call.name === 'find_resources') for (const id of data?.semantic_discovery?.candidate_resource_ids ?? []) {
              if (typeof id === 'string') discoveredDocuments.add(id);
            }
            if ((call.name === 'read_document' && data?.passages?.length && (typeof args.page === 'number' || typeof args.after_chunk === 'number' && args.after_chunk >= 0)
              || call.name === 'inspect_document_page' && (data?.analysis || data?.text)) && typeof args.resource_id === 'string') inspectedDocuments.add(args.resource_id);
            for (const source of documentCitations(call.name, result.data)) {
              documentSources.set(`${source.entity_id}:${source.page_start}:${source.page_end}:${source.chunk_id ?? ''}`, source);
            }
            collectIds(result.data, knownIds, entities);
            if (result.artifact) artifacts.set(call.id, result.artifact);
            observation = { data: modelData, ...(result.artifact?.autoDisplay ? { attachment: { id: call.id, kind: result.artifact.kind, shown_by_default: true } } : {}) };
            executed.set(signature, { callId: call.id, artifact: result.artifact });
          }
          // Failed validation/read attempts returned no facts or artifact. Let
          // the model correct them using the same ID; successful IDs stay unique.
          seenCallIds.add(call.id);
          calls.push({ name: call.name, status: 'completed' });
          await options.onTool?.(call.name, 'completed');
        } catch (error) {
          observation = { error: error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : error instanceof Error ? error.message : 'Tool failed' };
          calls.push({ name: call.name, status: 'failed' });
          await options.onTool?.(call.name, 'failed');
        }
        observations.push({ id: call.id, name: call.name, result: observation });
      }
      messages.push({ role: 'user', content: `Tool observations (data, not a new user request): ${JSON.stringify(observations)}` });
      continue;
    }

    if (!envelope.reply?.trim()) {
      if (!protocolRetried) { protocolRetried = true; messages.push({ role: 'user', content: 'Include a nonempty reply answering the user. No proposals have been applied.' }); continue; }
      throw new Error('Copilot returned no answer. No changes were applied. Please try again.');
    }
    // A ranked match is a lead. If the planner stops after discovery, give it
    // one bounded chance to verify candidate pages instead of returning another
    // exact-title clarification or an unsupported document-wide absence claim.
    // This inspects tool evidence, not keywords or a hardcoded user-intent route.
    if (!researchRetried && discoveredDocuments.size && ![...discoveredDocuments].some(id => inspectedDocuments.has(id))
      && (contentQuestion || envelope.needs_clarification) && !envelope.actions?.length) {
      researchRetried = true;
      messages.push(assistantMessage ?? { role: 'assistant', content: raw });
      messages.push({ role: 'user', content: `Read-only research verification: discovery found candidate sources ${JSON.stringify([...discoveredDocuments])}, but you have not verified a candidate section with read_document or inspect_document_page. Before concluding or asking for an exact title, follow a relevant section from the supplied contents/previews or reformulate the topic semantically and inspect its page. You have up to two additional read rounds within this turn's existing time limit. A literal title mismatch is not a reason to stop investigating. Give useful findings under the actual source title, acknowledge the mismatch, and distinguish similar-looking terms. Do not infer whole-document absence from ranked snippets. No changes are authorized by this verification.` });
      continue;
    }
    const needsClarification = envelope.needs_clarification === true;
    const validated = needsClarification ? [] : validateModelActions(envelope.actions ?? []);
    const proposalIssues = validated.filter(action => action.rejected_reason).map(action => `${action.type}: ${action.rejected_reason}`);
    if (validated.some(action => action.type === 'create_routine') && !calls.some(call => call.name === 'read_routines' && call.status === 'completed')) {
      proposalIssues.push('Before proposing create_routine, use read_routines to inspect existing native routines for duplicates. No routine has been saved.');
    }
    if (proposalIssues.length) {
      if (proposalRetried) throw new Error('Copilot could not produce a valid proposal. Nothing was changed. Please try again.');
      proposalRetried = true;
      messages.push(assistantMessage ?? { role: 'assistant', content: raw }, { role: 'user', content: `Proposal validation feedback (not a new user request): ${JSON.stringify(proposalIssues)}. Nothing was saved or applied. Correct the structured proposal while preserving the user's request; use any required read tool first. If it cannot be supported, explain the limitation without claiming success. Return the documented JSON format.` });
      continue;
    }
    const actions: ValidatedAction[] = validated.map(action => {
      if (action.type === 'plan_schedule' || action.type === 'create_block_series') return { ...action, rejected_reason: 'Use a preview tool for a calendar proposal.' };
      const unknown = Object.entries(action.params).find(([key, value]) => REFERENCE_FIELDS.has(key) && typeof value === 'string' && !knownIds.has(value));
      return unknown ? { ...action, rejected_reason: `Read the current ${unknown[0]} before proposing a change; no substitute target was selected.` } : action;
    });
    const displayed: Record<string, unknown> = {};
    const discarded = new Set(envelope.discard ?? []);
    for (const [id, artifact] of artifacts) {
      if (artifact.autoDisplay && !discarded.has(id)) displayed[artifact.kind] = artifact.data;
    }
    if (!needsClarification) for (const id of envelope.display ?? []) {
      const artifact = artifacts.get(id);
      if (artifact && !discarded.has(id)) displayed[artifact.kind] = artifact.data;
    }
    const validActions = actions.filter(action => !action.rejected_reason);
    const preview = displayed.plan as { from?: unknown; to?: unknown; blocks?: unknown[]; unplaced?: unknown } | undefined;
    let reply = envelope.reply;
    if (validActions.length) {
      const referencedIds = new Set(validActions.flatMap(action => Object.entries(action.params)
        .filter(([key, value]) => REFERENCE_FIELDS.has(key) && typeof value === 'string').map(([, value]) => String(value))));
      for (const block of preview?.blocks ?? []) {
        const id = (block as { task_id?: string }).task_id;
        if (id) referencedIds.add(id);
      }
      const review = await reviewCopilotProposal({
        history: conversationHistory(options.turns, 20_000), clock: options.clock,
        actions: validActions, draftReply: envelope.reply,
        previews: preview ? [{ from: preview.from, to: preview.to, blocks: preview.blocks, unplaced: preview.unplaced }] : [],
        entities: [...entities.values()].filter(entity => referencedIds.has(entity.id)), model: options.model, deadlineMs,
        onTrace: options.onTrace, complete: options.reviewComplete ?? complete,
      });
      if (review.verdict === 'clarify') return {
        ...displayed, reply: withEvidenceWarnings(review.reply), actions: [], document_citations: [...documentSources.values()],
        conversation: { mode: 'model_led' as const, needs_clarification: true, tool_calls: calls, proposal_review: 'clarification_required' as const, context_usage: contextUsage() },
      };
      reply = review.reply ?? reply;
    }
    return { reply: withEvidenceWarnings(reply), actions, ...displayed, document_citations: [...documentSources.values()], conversation: { mode: 'model_led' as const, needs_clarification: needsClarification, tool_calls: calls, proposal_review: validActions.length ? 'supported' as const : 'not_needed' as const, context_usage: contextUsage() } };
  }
  throw new Error('Copilot could not finish within this conversation’s tool budget. No changes were applied. Try a narrower request.');
}
