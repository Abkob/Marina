import path from 'path';
import { Codex, type ThreadItem } from '@openai/codex-sdk';
import { appendAgentEvent, finishAgentRun, setAgentIntent, startAgentRun } from './agentLedger.js';

export function getCodexWorkerStatus() {
  return {
    installed: true,
    enabled: process.env.MARINA_CODEX_WORKER_ENABLED === 'true',
    mode: 'read-only',
    network_access: false,
    approval_policy: 'never',
    model: process.env.MARINA_CODEX_MODEL ?? null,
  };
}

export async function runCodexWorker(input: {
  prompt: string;
  intent: string;
  sessionId?: string | null;
  workingDirectory?: string;
}): Promise<{ runId: string; threadId: string | null; response: string }> {
  if (process.env.MARINA_CODEX_WORKER_ENABLED !== 'true') {
    throw new Error('Codex worker is disabled. Set MARINA_CODEX_WORKER_ENABLED=true after configuring authentication.');
  }
  const workingDirectory = path.resolve(input.workingDirectory ?? process.cwd());
  const runId = await startAgentRun({
    source: 'codex_sdk',
    agentKind: 'codex_worker',
    sessionId: input.sessionId ?? null,
    userMessage: input.prompt,
    model: process.env.MARINA_CODEX_MODEL ?? null,
    metadata: { working_directory: workingDirectory, sandbox: 'read-only' },
  });
  await setAgentIntent(runId, input.intent, 1, { delegated_by: 'marina' });

  try {
    const codex = new Codex({ apiKey: process.env.CODEX_API_KEY });
    const thread = codex.startThread({
      workingDirectory,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      ...(process.env.MARINA_CODEX_MODEL ? { model: process.env.MARINA_CODEX_MODEL } : {}),
    });
    const turn = await thread.run(input.prompt);
    for (const item of turn.items) await logSafeCodexItem(runId, item);
    await finishAgentRun(runId, 'completed', turn.finalResponse, {
      metadata: { thread_id: thread.id, usage: turn.usage },
    });
    return { runId, threadId: thread.id, response: turn.finalResponse };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishAgentRun(runId, 'failed', null, { error: message });
    throw error;
  }
}

async function logSafeCodexItem(runId: string, item: ThreadItem): Promise<void> {
  if (item.type === 'reasoning') {
    await appendAgentEvent(runId, 'reasoning_summary', 'Codex reasoning summary', item.text);
  } else if (item.type === 'command_execution') {
    await appendAgentEvent(runId, 'command', 'Codex inspected the workspace', null, {
      command: item.command,
      exit_code: item.exit_code ?? null,
      status: item.status,
    });
  } else if (item.type === 'file_change') {
    await appendAgentEvent(runId, 'file_change', 'Codex file changes', null, {
      status: item.status,
      changes: item.changes,
    });
  } else if (item.type === 'agent_message') {
    await appendAgentEvent(runId, 'agent_message', 'Codex response', item.text);
  } else if (item.type === 'error') {
    await appendAgentEvent(runId, 'worker_error', 'Codex reported an error', item.message, {}, 'failed');
  }
}
