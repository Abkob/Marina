import { query } from '../db.js';
import { scheduleObsidianVaultSync } from './obsidianVaultSync.js';

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface StartAgentRunInput {
  source?: string;
  agentKind?: string;
  sessionId?: string | null;
  userMessage: string;
  model?: string | null;
  metadata?: Record<string, unknown>;
}

export async function startAgentRun(input: StartAgentRunInput): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await query(
    `INSERT INTO agent_runs
      (id,source,agent_kind,session_id,user_message,model,status,started_at,metadata_json)
     VALUES ($1,$2,$3,$4,$5,$6,'running',$7,$8)`,
    [id, input.source ?? 'copilot', input.agentKind ?? 'semantic_planner', input.sessionId ?? null,
      input.userMessage, input.model ?? null, now, JSON.stringify(input.metadata ?? {})],
  );
  await appendAgentEvent(id, 'run_started', 'Agent run started', null, {
    source: input.source ?? 'copilot',
    agent_kind: input.agentKind ?? 'semantic_planner',
  });
  return id;
}

export async function appendAgentEvent(
  runId: string,
  eventType: string,
  title: string,
  detail: string | null = null,
  data: Record<string, unknown> = {},
  status = 'recorded',
): Promise<void> {
  await query(
    `INSERT INTO agent_events (id,run_id,sequence,event_type,title,detail,status,data_json,created_at)
     SELECT $1,$2,COALESCE(MAX(sequence),0)+1,$3,$4,$5,$6,$7,$8
     FROM agent_events WHERE run_id=$2`,
    [crypto.randomUUID(), runId, eventType, title, detail, status, JSON.stringify(data), new Date().toISOString()],
  );
}

export async function setAgentIntent(
  runId: string,
  intent: string,
  confidence: number | null,
  evidence: Record<string, unknown> = {},
): Promise<void> {
  await query('UPDATE agent_runs SET intent=$1,intent_confidence=$2 WHERE id=$3', [intent, confidence, runId]);
  await appendAgentEvent(runId, 'intent_resolved', `Intent: ${intent}`, null, { confidence, ...evidence });
}

export async function finishAgentRun(
  runId: string,
  status: Exclude<AgentRunStatus, 'running'>,
  summary: string | null,
  options: { error?: string | null; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await query(
    `UPDATE agent_runs SET status=$1,summary=$2,error=$3,finished_at=$4,
       metadata_json=metadata_json::jsonb || $5::jsonb WHERE id=$6`,
    [status, summary, options.error ?? null, now, JSON.stringify(options.metadata ?? {}), runId],
  );
  await appendAgentEvent(
    runId,
    status === 'completed' ? 'run_completed' : 'run_failed',
    status === 'completed' ? 'Agent run completed' : 'Agent run failed',
    options.error ?? null,
    {},
    status,
  );
  scheduleObsidianVaultSync(`agent run ${status}`);
}
