import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { assertPlanningTestDatabase, validatePlanningTestUrl } from './databaseFixtures';

const mock = vi.hoisted(() => ({ chat: vi.fn(), findResources: vi.fn() }));
vi.mock('../../server/ollama.js', async original => ({ ...await original<typeof import('../../server/ollama.js')>(), chat: mock.chat }));
vi.mock('../../server/services/documentReading.js', async original => ({ ...await original<typeof import('../../server/services/documentReading.js')>(), findResources: mock.findResources }));
vi.mock('../../server/services/obsidianVaultSync.js', async original => ({ ...await original<typeof import('../../server/services/obsidianVaultSync.js')>(), scheduleObsidianVaultSync: vi.fn() }));
vi.mock('../../server/services/summaryGenerator.js', async original => ({ ...await original<typeof import('../../server/services/summaryGenerator.js')>(), generateEntitySummary: vi.fn() }));
vi.mock('../../server/services/embeddingLifecycle.js', async original => ({ ...await original<typeof import('../../server/services/embeddingLifecycle.js')>(), queueEmbeddingUpsert: vi.fn(), markEmbeddingStale: vi.fn() }));

describe.skipIf(!process.env.DATABASE_URL_TEST)('P01.1 real database and HTTP identity boundaries', () => {
  let pool: pg.Pool; let server: typeof import('../../server/__tests__/setup');
  let sessionId: string; let taskId: string; let resourceId: string;
  const runs: string[] = []; const proposals: string[] = [];
  const post = (path: string, body?: string) => fetch(`${server.baseUrl}/api/ai/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: validatePlanningTestUrl(process.env.DATABASE_URL_TEST, process.env.PLANNING_TEST_DB), max: 3 });
    const client = await pool.connect(); try { await assertPlanningTestDatabase(client); } finally { client.release(); }
    server = await import('../../server/__tests__/setup'); await server.startTestServer();
  });
  afterAll(async () => { await server?.stopTestServer(); await pool?.end(); const db = await import('../../server/db'); await db.getPool().end(); });
  beforeEach(async () => {
    mock.chat.mockReset(); mock.findResources.mockReset(); taskId = randomUUID(); resourceId = randomUUID();
    await pool.query("INSERT INTO tasks (id,title,priority,created_at,updated_at) VALUES ($1,'P01 identity sentinel','medium',$2,$2)", [taskId, new Date().toISOString()]);
    await pool.query("INSERT INTO resources (id,title,created_at) VALUES ($1,'P01 synthetic reading',$2)", [resourceId, new Date().toISOString()]);
    const response = await post('sessions', '{}'); expect(response.status).toBe(200); sessionId = (await response.json()).id;
  });
  afterEach(async () => {
    await pool.query('DELETE FROM ai_action_proposals WHERE source_id=$1 OR id=ANY($2)', [sessionId, proposals.splice(0)]);
    await pool.query('DELETE FROM agent_runs WHERE id=ANY($1)', [runs.splice(0)]);
    await pool.query('DELETE FROM chat_sessions WHERE id=$1', [sessionId]);
    await pool.query('DELETE FROM tasks WHERE id=$1', [taskId]);
    await pool.query('DELETE FROM resources WHERE id=$1', [resourceId]);
  });
  const snapshot = async () => {
    const { rows } = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM ai_action_proposals) AS proposals,
      (SELECT COUNT(*)::int FROM chat_messages) AS messages,
      (SELECT COUNT(*)::int FROM agent_runs) AS runs,
      (SELECT COUNT(*)::int FROM events) AS events,
      (SELECT priority FROM tasks WHERE id=$1) AS priority`, [taskId]);
    return rows[0];
  };
  const chat = async (message: string) => {
    const response = await post(`sessions/${sessionId}/chat`, JSON.stringify({ message }));
    const body = await response.json(); if (body.agent_run_id) runs.push(body.agent_run_id);
    expect(response.status, JSON.stringify(body)).toBe(200); return body;
  };
  it.each(['{', JSON.stringify({ message: 'hello', references: Array(10000).fill('r') }), JSON.stringify({ message: 'hello', extra: '😀'.repeat(70000) })])('rejects malformed or excessive request before writes and providers', async input => {
    const before = await snapshot();
    const response = await post(`sessions/${sessionId}/chat`, input);
    expect(response.status).toBe(400); expect(await snapshot()).toEqual(before);
    expect(mock.chat).not.toHaveBeenCalled(); expect(mock.findResources).not.toHaveBeenCalled();
  });
  it('CHAT-01 resource discovery cannot prepare update_task or expose an Apply proposal', async () => {
    mock.findResources.mockResolvedValue({ resources: [{ id: resourceId, title: 'P01 synthetic reading' }], evidence: [{ resource_id: resourceId, passage: 'Read this section.' }] });
    mock.chat.mockResolvedValueOnce(JSON.stringify({ tool_calls: [{ id: 'source', name: 'find_resources', arguments: { search: 'P01 synthetic reading' } }] }))
      .mockResolvedValueOnce(JSON.stringify({ reply: 'Proposed change.', actions: [{ type: 'update_task', params: { task_id: resourceId, priority: 'high' } }] }));
    const body = await chat('Find P01 synthetic reading and set its task priority to high.');
    expect(mock.findResources).toHaveBeenCalledOnce();
    expect(body.actions[0].rejected_reason).toBeTruthy(); expect(body.actions[0].proposal_id).toBeUndefined();
    expect((await pool.query('SELECT id FROM ai_action_proposals WHERE source_id=$1', [sessionId])).rows).toEqual([]);
    expect((await snapshot()).priority).toBe('medium');
  });
  it('rechecks the active task table after observation and before proposal persistence', async () => {
    mock.chat.mockResolvedValueOnce(JSON.stringify({ tool_calls: [{ id: 'task', name: 'find_tasks', arguments: { search: 'P01 identity sentinel' } }] }))
      .mockImplementationOnce(async () => {
        await pool.query('DELETE FROM tasks WHERE id=$1', [taskId]);
        return JSON.stringify({ reply: 'Proposed change.', actions: [{ type: 'update_task', params: { task_id: taskId, priority: 'high' } }] });
      }).mockResolvedValueOnce(JSON.stringify({ verdict: 'supported' }));
    const body = await chat('Set P01 identity sentinel to high priority.');
    expect(body.actions[0].rejected_reason).toContain('Active task not found');
    expect(body.actions[0].proposal_id).toBeUndefined();
    expect((await pool.query('SELECT id FROM ai_action_proposals WHERE source_id=$1', [sessionId])).rows).toEqual([]);
  });
  it('rejects a resource ID before preparing a calendar layout', async () => {
    mock.chat.mockResolvedValueOnce(JSON.stringify({ tool_calls: [{ id: 'plan', name: 'preview_schedule', arguments: { task_id: resourceId, from_date: '2026-10-06', to_date: '2026-10-06', start_hour: 9, end_hour: 12 } }] }))
      .mockResolvedValueOnce(JSON.stringify({ reply: 'The selected task is unavailable.', actions: [] }));
    const before = await snapshot(); const body = await chat('Plan the selected task on October 6 from 9 to 12.');
    expect(JSON.stringify(mock.chat.mock.calls[1])).toContain('The requested task is unavailable');
    expect(body.plan).toBeFalsy(); expect((await snapshot()).events).toBe(before.events);
  });
  it.each(['wrong kind', 'malformed JSON', 'unknown action'])('Apply rejects legacy %s proposals without mutation', async defect => {
    const id = randomUUID(); proposals.push(id);
    const payload = defect === 'malformed JSON' ? '{' : JSON.stringify({ task_id: resourceId, priority: 'high' });
    await pool.query(`INSERT INTO ai_action_proposals (id,source_id,action_type,action_payload,created_at) VALUES ($1,$2,$3,$4,$5)`, [id, sessionId, defect === 'unknown action' ? 'toString' : 'update_task', payload, new Date().toISOString()]);
    const before = await snapshot(); const response = await post(`proposals/${id}/apply`);
    expect(response.status).toBe(defect === 'wrong kind' ? 404 : 400);
    expect(await snapshot()).toEqual(before);
    expect((await pool.query('SELECT status,applied_at FROM ai_action_proposals WHERE id=$1', [id])).rows[0]).toEqual({ status: 'pending', applied_at: null });
  });
});
