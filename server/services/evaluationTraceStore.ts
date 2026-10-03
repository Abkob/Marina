import { randomUUID } from 'node:crypto';
import { transaction, query } from '../db.js';
import { evaluationTraceSchema, readEvaluationTrace, TRACE_EVENT_LIMIT, TRACE_BYTE_LIMIT, type EvaluationTrace } from '../../shared/evaluationTrace.js';
import type { EvaluationRecorder } from './evaluationTrace.js';

export const TRACE_EVENT_TYPE = 'evaluation_trace_v1';

// One bounded snapshot per agent run, independent from durable user content.
// Reuse existing ledger storage; no production schema migration is needed.
export async function saveEvaluationTrace(recorder: EvaluationRecorder): Promise<void> {
  const trace = recorder.snapshot();
  if (!trace.run_id) { recorder.storage('unavailable'); return; }
  try {
    await transaction(async client => {
      await client.query("SET LOCAL statement_timeout = '750ms'");
      const locked = await client.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE', [trace.run_id]);
      if (!locked.rowCount) throw new Error('Trace run unavailable');
      const saved = evaluationTraceSchema.parse({ ...trace, storage: 'saved' });
      await client.query(`INSERT INTO agent_events (id,run_id,sequence,event_type,title,status,data_json,created_at)
        SELECT $1,$2,COALESCE(MAX(sequence),0)+1,$3,'Response diagnostics','recorded',$4,$5 FROM agent_events WHERE run_id=$2
        ON CONFLICT (id) DO NOTHING`, [`trace:${trace.run_id}`, trace.run_id, TRACE_EVENT_TYPE, JSON.stringify(saved), trace.created_at]);
    });
    recorder.storage('saved');
  } catch { recorder.storage('unavailable'); }
}

export async function loadEvaluationTraces(runIds: string[]): Promise<Map<string, EvaluationTrace>> {
  if (!runIds.length) return new Map();
  const { rows } = await query<{ run_id: string; data_json: string }>(
    'SELECT run_id,data_json FROM agent_events WHERE event_type=$1 AND run_id=ANY($2)', [TRACE_EVENT_TYPE, runIds]);
  const result = new Map<string, EvaluationTrace>();
  for (const row of rows) {
    try { const trace = readEvaluationTrace(JSON.parse(row.data_json));
      if (trace && Date.parse(trace.expires_at) > Date.now()) result.set(row.run_id, trace);
    } catch { /* Malformed diagnostics never hide a saved conversation. */ }
  }
  return result;
}

// Called explicitly by the maintenance command. Never deletes messages, runs,
// proposals, sources or non-diagnostic ledger events. Batches bound lock time.
export async function pruneEvaluationTraces(now = new Date(), limit = 100): Promise<number> {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid trace retention bounds');
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = await query(`DELETE FROM agent_events WHERE id IN (
    SELECT id FROM agent_events WHERE event_type=$1 AND created_at < $2 ORDER BY created_at,id LIMIT $3
  )`, [TRACE_EVENT_TYPE, cutoff, limit]);
  return result.rowCount ?? 0;
}

// Best-effort post-commit diagnostics; failure cannot undo a successful Apply.
// Locks serialize concurrent additions. The same proposal produces one event.
export async function traceProposalApplied(proposalId: string): Promise<boolean> {
  if (!evaluationTraceSchema.shape.proposal_ids.element.safeParse(proposalId).success) return false;
  try {
    return await transaction(async client => {
      await client.query("SET LOCAL statement_timeout = '750ms'");
      const { rows } = await client.query<{ id: string; data_json: string }>(`SELECT id,data_json FROM agent_events
        WHERE event_type=$1 AND created_at >= $2 AND data_json::jsonb @> $3::jsonb ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [TRACE_EVENT_TYPE, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), JSON.stringify({ proposal_ids: [proposalId] })]);
      if (!rows.length) return false;
      const trace = readEvaluationTrace(JSON.parse(rows[0].data_json));
      if (!trace) return false;
      if (trace.events.some(event => event.phase === 'apply' && event.related_id === proposalId)) return true;
      const event = { id: randomUUID(), phase: 'apply' as const, status: 'completed' as const, related_id: proposalId,
        elapsed_ms: Math.max(0, Date.now() - Date.parse(trace.created_at)) };
      const canAppend = trace.events.length < TRACE_EVENT_LIMIT
        && Buffer.byteLength(JSON.stringify({ ...trace, events: [...trace.events, event] })) <= TRACE_BYTE_LIMIT - 64;
      if (canAppend) trace.events.push(event);
      else trace.dropped_events++;
      await client.query('UPDATE agent_events SET data_json=$1 WHERE id=$2', [JSON.stringify(trace), rows[0].id]);
      return canAppend;
    });
  } catch { return false; }
}
