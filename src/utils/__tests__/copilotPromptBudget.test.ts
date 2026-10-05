import { describe, expect, it, vi } from 'vitest';
import { createCopilotTools } from '../../../server/services/copilotTools.js';
import { runCopilotConversation } from '../../../server/services/copilotConversation.js';
import { ActionParamsSchemas } from '../../../server/services/actionValidation.js';
import { compactSchema } from '../../../server/services/copilotContracts.js';
import type { chat, ChatMessage } from '../../../server/ollama.js';

describe('initial Copilot context', () => {
  it.each(['hi', 'Find a likely book about rigid motions, then read its introductory page'])('keeps all capabilities available without eager data reads for %s', async content => {
    const unavailable = vi.fn(async () => { throw new Error('Unexpected data read'); });
    const tools = createCopilotTools({ workspace: unavailable, previewSchedule: unavailable, previewRoutine: unavailable, scheduleDay: unavailable, overdueTasks: unavailable });
    for (const tool of Object.values(tools)) tool.execute = unavailable;
    let sent: ChatMessage[] = [];
    const complete = vi.fn<typeof chat>().mockImplementation(async messages => { sent = structuredClone(messages); return '{"reply":"Response","actions":[],"display":[],"needs_clarification":false}'; });
    await runCopilotConversation({ turns: [{ role: 'user', content }], tools, complete, clock: { today: '2026-10-02', time: '12:00', timezone: 'Asia/Beirut' } });
    expect(complete).toHaveBeenCalledOnce(); expect(unavailable).not.toHaveBeenCalled();
    expect(sent[1]).toEqual({ role: 'user', content });
    // Regression budget: previous system prompt was 26,772 characters.
    expect(sent[0].content.length).toBeLessThan(7000);
    const encodedTools = JSON.parse(sent[0].content.split('Read-only tools: ')[1].split('\nProposal parameter schemas: ')[0]);
    expect(Object.keys(encodedTools).sort()).toEqual(['find_resources','find_tasks','load_capabilities','preview_repeating_blocks','workspace_context']);
    for (const name of ['find_resources','find_tasks','workspace_context']) expect(encodedTools[name].parameters).toBe(compactSchema(tools[name].parameters));
    expect(sent[0].content).toContain('routines (habits/check-ins)');
    const encodedActions = JSON.parse(sent[0].content.split('Proposal parameter schemas: ')[1].split('\nLocal clock: ')[0]);
    expect(Object.keys(encodedActions)).toEqual([]);
  });
});
