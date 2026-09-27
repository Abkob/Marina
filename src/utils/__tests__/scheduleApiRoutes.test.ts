import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiRouter } from '../../../server/routes/ai.js';
import { query, transaction } from '../../../server/db.js';
import { loadRoutineReservations } from '../../../server/services/routinePlanning.js';
import { chat } from '../../../server/ollama.js';

vi.mock('../../../server/db.js', () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../server/services/routinePlanning.js', () => ({ loadRoutineReservations: vi.fn(async () => []), routineCapacity: (rows: unknown[]) => rows }));
vi.mock('../../../server/services/summaryGenerator.js', () => ({ generateEntitySummary: vi.fn(), generateDeterministicSummaries: vi.fn() }));
vi.mock('../../../server/services/embeddingLifecycle.js', () => ({ markEmbeddingStale: vi.fn(), queueEmbeddingUpsert: vi.fn() }));
vi.mock('../../../server/utils/background.js', () => ({ runInBackground: vi.fn() }));
vi.mock('../../../server/ollama.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../server/ollama.js')>(), chat: vi.fn() }));

type Route = { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> };
function routes(router: unknown): Route[] {
  return (router as { stack: Array<{ route?: Route; handle?: unknown }> }).stack.flatMap(layer =>
    layer.route ? [layer.route] : layer.handle && 'stack' in (layer.handle as object) ? routes(layer.handle) : []);
}
async function request(method: string, path: string, input: Record<string, unknown> = {}) {
  const route = routes(aiRouter).find(route => route.path === path && route.methods[method]);
  expect(route, `${method.toUpperCase()} /api/ai${path} must be mounted`).toBeDefined();
  const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
  await route!.stack.at(-1)!.handle({ query: {}, params: { id: 'proposal-1' }, body: {}, ...input }, res, vi.fn());
  return res;
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-24T08:00:00Z'));
  vi.mocked(query).mockReset(); vi.mocked(transaction).mockReset(); vi.mocked(chat).mockClear();
  vi.mocked(loadRoutineReservations).mockClear();
  vi.mocked(query).mockImplementation(async sql => ({ rows: sql.includes("FROM user_schedule_prefs")
    ? [{ work_days: '[1,2,3,4,5]', daily_capacity_minutes: 480, buffer_ratio: 0, timezone: 'Asia/Beirut' }] : [], rowCount: 0 }) as never);
});
afterEach(() => vi.useRealTimers());

describe('calendar API contracts mounted independently of chatbot routing', () => {
  it('keeps every calendar/proposal control endpoint registered', () => {
    const registered = routes(aiRouter).flatMap(route => Object.keys(route.methods).map(method => `${method} ${route.path}`));
    expect(registered).toEqual(expect.arrayContaining([
      'get /schedule-preview', 'get /proposals', 'post /proposals/:id/apply', 'post /proposals/:id/reject',
      'post /schedule/propose', 'post /schedule/plan/apply', 'post /schedule/drafts', 'post /schedule/drafts/apply',
    ]));
  });
  it('returns the requested week and real capacity without model calls or writes', async () => {
    const response = await request('get', '/schedule-preview', { query: { from: '2026-09-21', to: '2026-09-27' } });
    expect(response.status).not.toHaveBeenCalled();
    const data = response.json.mock.calls[0][0];
    expect(data.days.map((day: { date: string }) => day.date)).toEqual(['2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26','2026-09-27']);
    expect(data.days[0]).toMatchObject({ tasks: [], meetings: [], deadlines: [], proposals: [], routines: [], override: null });
    expect(data.scheduler_result.capacity_days[0]).toMatchObject({ date: '2026-09-24', available_minutes: 480 });
    expect(data.task_lookup).toEqual({});
    expect(chat).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(vi.mocked(query).mock.calls.every(([sql]) => sql.trimStart().startsWith('SELECT'))).toBe(true);
  });
  it('rejects invalid dates before database reads and bounds large display ranges', async () => {
    const invalid = await request('get', '/schedule-preview', { query: { from: '2026-02-30' } });
    expect(invalid.status).toHaveBeenCalledWith(400); expect(query).not.toHaveBeenCalled();
    const bounded = await request('get', '/schedule-preview', { query: { from: '2026-09-21', to: '2027-09-21' } });
    expect(bounded.json.mock.calls[0][0].days).toHaveLength(120);
  });
  it('filters archived branches on every entity read and includes this week’s remaining calendar blocks', async () => {
    await request('get', '/schedule-preview');
    const entityReads = vi.mocked(query).mock.calls.filter(([sql]) => /FROM (tasks|meetings|goals|goal_milestones|events|edges|goal_deadlines|event_task_links)\b/.test(sql));
    expect(entityReads.length).toBeGreaterThan(8);
    for (const [sql] of entityReads) expect(sql).toContain('archived_at');
    const events = entityReads.find(([sql]) => sql.includes('SELECT day_index, duration_hours, week_start'))!;
    expect(events[0]).toContain('(week_start::date + day_index) BETWEEN');
    expect(events[1]).toEqual(['2026-09-24', '2026-10-28']);
  });
  it('hides proposals for archived parents from both the calendar and proposal inbox', async () => {
    const base = vi.mocked(query).getMockImplementation()!;
    vi.mocked(query).mockImplementation(async (sql, params) => {
      if (sql.startsWith('WITH RECURSIVE')) return { rows: [{ entity_key: 'task:archived-parent' }] } as never;
      if (sql.includes('FROM ai_action_proposals')) return { rows: [{ id: 'p', action_type: 'create_task', action_payload: JSON.stringify({ parent_task_id: 'archived-parent', title: 'Child', due_date: '2026-09-24' }) }] } as never;
      return base(sql, params);
    });
    const preview = await request('get', '/schedule-preview');
    expect(preview.json.mock.calls[0][0].days.every((day: { proposals: unknown[] }) => day.proposals.length === 0)).toBe(true);
    expect((await request('get', '/proposals')).json).toHaveBeenCalledWith([]);
  });
  it('rejects malformed planning windows without calling a model or touching data', async () => {
    expect((await request('post', '/schedule/propose', { body: { horizon_days: 'bad' } })).status).toHaveBeenCalledWith(400);
    expect(query).not.toHaveBeenCalled(); expect(chat).not.toHaveBeenCalled();
  });
  it('keeps direct apply disabled', async () => {
    expect((await request('post', '/apply')).status).toHaveBeenCalledWith(410);
    expect(query).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
  });
});

describe('restored durable proposal controls', () => {
  function transactionData(proposal: Record<string, unknown>, archived = false) {
    const execute = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM ai_action_proposals') ? [proposal]
      : sql.startsWith('WITH RECURSIVE') ? archived ? [{ entity_key: 'task:t1' }] : []
      : sql.startsWith('SELECT') ? [{ id: 't1', target_date: null, hard_deadline: null }] : [], rowCount: 1 }));
    vi.mocked(transaction).mockImplementation(async fn => fn({ query: execute } as never));
    return execute;
  }
  const pending = { status: 'pending', action_type: 'update_task', action_payload: JSON.stringify({ task_id: 't1', due_date: '2026-09-25' }) };
  it('applies a validated proposal and marks it applied inside one locked transaction', async () => {
    const execute = transactionData(pending);
    expect((await request('post', '/proposals/:id/apply')).json).toHaveBeenCalledWith({ ok: true, action_type: 'update_task' });
    expect(execute.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE tasks SET'))).toBe(true);
    expect(execute.mock.calls.at(-1)![0]).toContain("status='applied'");
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it('rejects double application and archived targets without changing tasks', async () => {
    let execute = transactionData({ ...pending, status: 'applied' });
    await expect(request('post', '/proposals/:id/apply')).rejects.toMatchObject({ status: 409 });
    expect(execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
    execute = transactionData(pending, true);
    await expect(request('post', '/proposals/:id/apply')).rejects.toMatchObject({ status: 409 });
    expect(execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });
  it('rejects invalid persisted payloads before any mutation', async () => {
    const execute = transactionData({ ...pending, action_payload: '{"task_id":"t1","due_date":"2026-02-30"}' });
    await expect(request('post', '/proposals/:id/apply')).rejects.toMatchObject({ status: 400 });
    expect(execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });
  it('allows rejecting pending proposals but cannot reject an already applied one', async () => {
    const execute = transactionData(pending);
    expect((await request('post', '/proposals/:id/reject')).json).toHaveBeenCalledWith({ ok: true });
    expect(execute.mock.calls.at(-1)![0]).toContain("status='rejected'");
    transactionData({ status: 'applied' });
    await expect(request('post', '/proposals/:id/reject')).rejects.toMatchObject({ status: 409 });
  });
});
