import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { planningFixtures, permuteFixture, fixtureId } from './fixtures.js';
import { assertPlanningTestDatabase, validatePlanningTestUrl, withPlanningFixture } from './databaseFixtures.js';
import { EvaluationRecorder } from '../../server/services/evaluationTrace.js';
import { saveEvaluationTrace, loadEvaluationTraces, pruneEvaluationTraces, traceProposalApplied, TRACE_EVENT_TYPE } from '../../server/services/evaluationTraceStore.js';
import { TRACE_BYTE_LIMIT } from '../../shared/evaluationTrace.js';

const mock = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock('../../server/ollama.js', async original => ({ ...await original<typeof import('../../server/ollama.js')>(), chat: mock.chat }));
vi.mock('../../server/services/obsidianVaultSync.js', async original => ({ ...await original<typeof import('../../server/services/obsidianVaultSync.js')>(), scheduleObsidianVaultSync: vi.fn() }));
// External follow-ups are outside P00; exercise the real task mutation without providers.
vi.mock('../../server/services/summaryGenerator.js', async original => ({ ...await original<typeof import('../../server/services/summaryGenerator.js')>(), generateEntitySummary: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../server/services/embeddingLifecycle.js', async original => ({ ...await original<typeof import('../../server/services/embeddingLifecycle.js')>(), queueEmbeddingUpsert: vi.fn().mockResolvedValue(undefined), markEmbeddingStale: vi.fn().mockResolvedValue(undefined) }));

const configured = Boolean(process.env.DATABASE_URL_TEST);
describe.skipIf(!configured)('P00 real PostgreSQL and HTTP (requires marked disposable database)', () => {
  let pool: pg.Pool; let baseUrl: string; let server: typeof import('../../server/__tests__/setup.js');
  beforeAll(async () => {
    const connectionString = validatePlanningTestUrl(process.env.DATABASE_URL_TEST, process.env.PLANNING_TEST_DB);
    pool = new pg.Pool({ connectionString, max: 3, connectionTimeoutMillis: 3000 });
    const client = await pool.connect(); try { await assertPlanningTestDatabase(client); } finally { client.release(); }
    server = await import('../../server/__tests__/setup.js'); await server.startTestServer(); baseUrl = server.baseUrl;
  });
  afterAll(async () => { await server?.stopTestServer(); await pool?.end(); const db = await import('../../server/db.js'); if (configured) await db.getPool().end(); });

  it.each(planningFixtures)('P00.1-I02 replays $key twice and preserves unrelated rows', async fixture => {
    const client = await pool.connect(); const sentinel = randomUUID();
    try {
      await client.query("INSERT INTO tasks (id,title,created_at,updated_at) VALUES ($1,'Unrelated sentinel',$2,$2)", [sentinel, fixture.clock.now]);
      let before: unknown;
      for (const seed of [1, 99]) {
        const actual = await withPlanningFixture(client, permuteFixture(fixture, seed), async value => {
          const tasks = await client.query('SELECT id,title,estimated_minutes,due_date FROM tasks WHERE id=ANY($1) ORDER BY id', [value.tasks.map(row => row.id)]);
          const chunks = await client.query('SELECT id,resource_id,content,page_start,chunk_metadata FROM resource_chunks WHERE id=ANY($1) ORDER BY id', [value.evidence.map(row => row.id)]);
          expect(tasks.rows).toHaveLength(value.tasks.length); expect(chunks.rows).toHaveLength(value.evidence.length);
          const events = await client.query(`SELECT id,TO_CHAR(week_start::date + day_index,'YYYY-MM-DD') AS day,
            ROUND(start_hour*60)::int AS start_minute,ROUND((start_hour+duration_hours)*60)::int AS end_minute FROM events WHERE id=ANY($1) ORDER BY id`, [value.busy.map(row => row.id)]);
          expect(events.rows).toEqual([...value.busy].sort((a,b) => a.id.localeCompare(b.id)).map(({ id, day, start_minute, end_minute }) => ({ id, day, start_minute, end_minute })));
          const edges = await client.query('SELECT source_id,target_id FROM edges WHERE source_id=ANY($1) ORDER BY source_id', [value.resources.map(row => row.id)]);
          expect(edges.rows).toEqual([...value.resources].sort((a,b) => a.id.localeCompare(b.id)).map(row => ({ source_id: row.id, target_id: row.task_id })));
          const links = await client.query('SELECT event_id,task_id,planned_minutes FROM event_task_links WHERE event_id=ANY($1) ORDER BY event_id', [value.busy.map(row => row.id)]);
          expect(links.rows).toEqual(value.busy.filter(row => row.task_id).sort((a,b) => a.id.localeCompare(b.id)).map(row => ({ event_id: row.id, task_id: row.task_id, planned_minutes: row.end_minute - row.start_minute })));
          return { tasks: tasks.rows, chunks: chunks.rows, events: events.rows, edges: edges.rows, links: links.rows };
        });
        if (before) expect(actual).toEqual(before); before = actual;
        expect((await client.query('SELECT id FROM tasks WHERE id=ANY($1)', [fixture.tasks.map(row => row.id)])).rows).toHaveLength(0);
      }
      expect((await client.query('SELECT title FROM tasks WHERE id=$1', [sentinel])).rows[0].title).toBe('Unrelated sentinel');
    } finally { await client.query('DELETE FROM tasks WHERE id=$1', [sentinel]); client.release(); }
  });
  it('P00.1-I03 rolls back a failed fixture callback without deleting another fixture', async () => {
    const client = await pool.connect();
    try {
      await expect(withPlanningFixture(client, planningFixtures[1], async () => { throw new Error('injected'); })).rejects.toThrow('injected');
      expect((await client.query('SELECT id FROM resources WHERE id=$1', [fixtureId(12)])).rows).toHaveLength(0);
    } finally { client.release(); }
  });
  it('P00.3-I03 correlates a real chat request, agent run, durable proposal and Apply', async () => {
    const taskId = randomUUID(); let sessionId: string | undefined; let runId: string | undefined; let proposalId: string | undefined;
    await pool.query("INSERT INTO tasks (id,title,created_at,updated_at) VALUES ($1,'P00 integration target',$2,$2)", [taskId, new Date().toISOString()]);
    mock.chat.mockReset();
    mock.chat.mockResolvedValueOnce(JSON.stringify({ tool_calls: [{ id: 'tasks', name: 'find_tasks', arguments: { search: 'P00 integration target' } }] }))
      .mockResolvedValueOnce(JSON.stringify({ reply: 'Review the priority change.', actions: [{ type: 'update_task', description: 'Set synthetic task priority', params: { task_id: taskId, priority: 'high' } }] }))
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'supported', reply: 'The proposed priority change is ready to review and apply.' }));
    try {
      const created = await fetch(`${baseUrl}/api/ai/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(created.status).toBe(200); sessionId = (await created.json()).id;
      const response = await fetch(`${baseUrl}/api/ai/sessions/${sessionId}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Set P00 integration target to high priority.' }) });
      const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200);
      runId = body.agent_run_id; expect(body.actions, JSON.stringify(body)).toHaveLength(1); proposalId = body.actions[0].proposal_id;
      const trace = body.runtime.evaluation_trace;
      expect(trace.run_id).toBe(runId); expect(trace.proposal_ids).toEqual([proposalId]); expect(trace.storage).toBe('saved');
      const applied = await fetch(`${baseUrl}/api/ai/proposals/${proposalId}/apply`, { method: 'POST' }); expect(applied.status).toBe(200);
      expect((await applied.json()).diagnostics_recorded).toBe(true);
      await Promise.all([traceProposalApplied(proposalId!), traceProposalApplied(proposalId!)]);
      const saved = (await loadEvaluationTraces([runId!])).get(runId!)!;
      expect(saved.request_id).toBe(trace.request_id); expect(saved.events.filter(event => event.phase === 'apply')).toHaveLength(1);
      expect((await pool.query('SELECT priority FROM tasks WHERE id=$1', [taskId])).rows[0].priority).toBe('high');
      const history = await (await fetch(`${baseUrl}/api/ai/sessions/${sessionId}/messages`)).json();
      expect(history.at(-1).metadata.runtime.evaluation_trace.events.some((event: any) => event.phase === 'apply')).toBe(true);
      const metadata = (await pool.query('SELECT metadata_json FROM chat_messages WHERE session_id=$1', [sessionId])).rows;
      expect(metadata.every(row => !row.metadata_json?.includes('evaluation_trace'))).toBe(true);
    } finally {
      if (proposalId) await pool.query('DELETE FROM ai_action_proposals WHERE id=$1', [proposalId]);
      if (runId) await pool.query('DELETE FROM agent_runs WHERE id=$1', [runId]);
      if (sessionId) await pool.query('DELETE FROM chat_sessions WHERE id=$1', [sessionId]);
      await pool.query('DELETE FROM tasks WHERE id=$1', [taskId]);
    }
  });
  it('P00.3-I04 retention removes only expired diagnostic events and honors the batch limit', async () => {
    const runId = randomUUID(); const now = new Date(); const old = new Date(now.getTime() - 8 * 86400000).toISOString();
    await pool.query("INSERT INTO agent_runs (id,started_at) VALUES ($1,$2)", [runId, old]);
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    try {
      for (let i = 0; i < ids.length; i++) await pool.query(`INSERT INTO agent_events (id,run_id,sequence,event_type,title,created_at) VALUES ($1,$2,$3,$4,'Retention fixture',$5)`,
        [ids[i], runId, i + 1, i === 2 ? 'run_started' : TRACE_EVENT_TYPE, i === 3 ? now.toISOString() : old]);
      expect(await pruneEvaluationTraces(now, 1)).toBe(1); expect(await pruneEvaluationTraces(now, 100)).toBe(1);
      expect((await pool.query('SELECT id FROM agent_events WHERE run_id=$1 ORDER BY sequence', [runId])).rows.map(row => row.id)).toEqual(ids.slice(2));
      expect((await pool.query('SELECT id FROM agent_runs WHERE id=$1', [runId])).rowCount).toBe(1);
    } finally { await pool.query('DELETE FROM agent_runs WHERE id=$1', [runId]); }
  });
  it('P00.3-S02 dropped storage leaves operations usable and repeated saves do not duplicate traces', async () => {
    const missing = new EvaluationRecorder({ runId: randomUUID() }); missing.record({ phase: 'context', status: 'completed' });
    await saveEvaluationTrace(missing); expect(missing.snapshot().storage).toBe('unavailable');
    const runId = randomUUID(); await pool.query('INSERT INTO agent_runs (id,started_at) VALUES ($1,$2)', [runId, new Date().toISOString()]);
    try {
      const trace = new EvaluationRecorder({ runId }); trace.record({ phase: 'context', status: 'completed' });
      await Promise.all(Array.from({ length: 20 }, () => saveEvaluationTrace(trace)));
      expect((await pool.query('SELECT id FROM agent_events WHERE run_id=$1 AND event_type=$2', [runId, TRACE_EVENT_TYPE])).rowCount).toBe(1);
      expect(trace.snapshot().storage).toBe('saved');
    } finally { await pool.query('DELETE FROM agent_runs WHERE id=$1', [runId]); }
  });
  it('P00.3-S04 Apply telemetry stays bounded when source-heavy traces fill up', async () => {
    const runId = randomUUID();
    await pool.query('INSERT INTO agent_runs (id,started_at) VALUES ($1,$2)', [runId, new Date().toISOString()]);
    try {
      const trace = new EvaluationRecorder({ runId });
      const proposals = Array.from({ length: 30 }, () => randomUUID()); trace.proposals(proposals);
      for (let i = 0; i < 48; i++) trace.tool('read_document', { passages: Array.from({ length: 8 }, () => ({ resource_id: randomUUID(), generation: Number.MAX_SAFE_INTEGER })) }, 10);
      await saveEvaluationTrace(trace);
      for (const proposal of proposals) await traceProposalApplied(proposal);
      const saved = (await loadEvaluationTraces([runId])).get(runId)!;
      expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(TRACE_BYTE_LIMIT);
      expect(saved.dropped_events).toBeGreaterThan(0);
      expect(saved.events.length).toBeLessThanOrEqual(48);
      expect(saved.events.filter(event => event.phase === 'apply').length).toBeGreaterThan(0);
    } finally { await pool.query('DELETE FROM agent_runs WHERE id=$1', [runId]); }
  });
  it('P00.3-S03 an actual trace INSERT failure cannot turn a saved chat into a failed answer', async () => {
    let sessionId: string | undefined; let runId: string | undefined;
    await pool.query(`CREATE OR REPLACE FUNCTION p00_reject_trace() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='evaluation_trace_v1' THEN RAISE EXCEPTION 'P00 injected diagnostics failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER p00_reject_trace BEFORE INSERT ON agent_events FOR EACH ROW EXECUTE FUNCTION p00_reject_trace()');
    mock.chat.mockReset(); mock.chat.mockResolvedValue(JSON.stringify({ reply: 'Hello from the synthetic provider.' }));
    try {
      sessionId = (await (await fetch(`${baseUrl}/api/ai/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).id;
      const response = await fetch(`${baseUrl}/api/ai/sessions/${sessionId}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) });
      const result = await response.json(); runId = result.agent_run_id;
      expect(response.status).toBe(200); expect(result.reply).toBe('Hello from the synthetic provider.');
      expect(result.runtime.evaluation_trace.storage).toBe('unavailable');
      expect((await pool.query('SELECT id FROM chat_messages WHERE session_id=$1', [sessionId])).rowCount).toBe(2);
    } finally {
      await pool.query('DROP TRIGGER p00_reject_trace ON agent_events'); await pool.query('DROP FUNCTION p00_reject_trace()');
      if (runId) await pool.query('DELETE FROM agent_runs WHERE id=$1', [runId]);
      if (sessionId) await pool.query('DELETE FROM chat_sessions WHERE id=$1', [sessionId]);
    }
  });
});
