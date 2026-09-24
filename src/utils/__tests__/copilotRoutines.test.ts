import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCopilotTools } from '../../../server/services/copilotTools.js';
import { ActionParamsSchemas, validateModelActions } from '../../../server/services/actionValidation.js';
import { createRoutineSchema } from '../../../server/services/routines.js';
import { query, transaction } from '../../../server/db.js';
import { COPILOT_FEATURES } from '../../../server/services/copilotFeatures.js';
import { runCopilotConversation } from '../../../server/services/copilotConversation.js';
import { aiProposalsRouter } from '../../../server/routes/ai-proposals.js';
import { activeProposals } from '../../../server/services/activeProposals.js';

vi.mock('../../../server/db.js', () => ({ query: vi.fn(), transaction: vi.fn() }));
const dependencies = () => ({ workspace: vi.fn(async () => ({})), previewSchedule: vi.fn(async () => ({})), previewRoutine: vi.fn(async () => ({})), scheduleDay: vi.fn(async () => null), overdueTasks: vi.fn(async () => ({})) });
const nativeRoutine = { title: 'Daily revision', cadence: 'daily', weekdays: [1, 2, 3, 4, 5, 6, 7], weekly_target: 7,
  target_count: 30, target_unit: 'minutes', planned_minutes: 30, preferred_time: '08:00', start_date: '2026-09-25' };
const routineId = '11111111-1111-4111-8111-111111111111';
const savedRoutine = { ...nativeRoutine, id: routineId, note: '', goal_id: null, cadence: 'weekly', weekly_target: 3,
  start_date: '2026-09-21', archived_at: null, created_at: '', updated_at: '' };
const queryMock = vi.mocked(query);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
  queryMock.mockReset().mockImplementation(async sql => ({ rows: sql.includes('SELECT timezone') ? [{ timezone: 'Asia/Beirut' }]
    : sql.includes('SELECT r.*') ? [savedRoutine]
    : sql.includes('SELECT * FROM routine_entries') ? [{ routine_id: routineId, date: '2026-09-21', status: 'completed', minutes: 30, completed_count: 30 }] : [] }) as never);
  vi.mocked(transaction).mockReset();
});
afterEach(() => vi.useRealTimers());

describe('Copilot uses Marina’s native routines', () => {
  it('can propose the same routine accepted by the app’s Add routine form', () => {
    const expected = createRoutineSchema.parse(nativeRoutine);
    const [action] = validateModelActions([{ type: 'create_routine', params: nativeRoutine }]);
    expect(action.rejected_reason).toBeUndefined();
    expect(action.params).toEqual(expected);
  });
  it('can discover saved routine definitions and check-ins, not just repeating calendar blocks', () => {
    const tools = createCopilotTools(dependencies());
    expect(tools.read_routines).toBeDefined();
    expect(tools.preview_repeating_blocks).toBeDefined();
    expect(tools.preview_routine).toBeUndefined();
  });
  it('keeps the compact feature map connected to real tool and action contracts', () => {
    const tools = createCopilotTools(dependencies());
    for (const feature of COPILOT_FEATURES) {
      if ('read' in feature) for (const name of feature.read) expect(tools[name], `${feature.feature}: ${name}`).toBeDefined();
      if ('preview' in feature) for (const name of feature.preview) expect(tools[name], name).toBeDefined();
      if ('propose' in feature) for (const name of feature.propose) expect(ActionParamsSchemas[name], name).toBeDefined();
    }
  });
  it.each([
    { weekdays: [1, 1] }, { preferred_time: '23:50' }, { target_count: 31 },
    { cadence: 'weekly', weekdays: [1, 3], weekly_target: 3 }, { start_date: '2026-02-30' }, { end_date: '2026-10-01' },
  ])('rejects the same invalid routine as the manual form: %j', change => {
    expect(validateModelActions([{ type: 'create_routine', params: { ...nativeRoutine, ...change } }])[0].rejected_reason).toBeTruthy();
  });
  it('reads full boundary weeks and computes native progress/capacity without creating records', async () => {
    const tools = createCopilotTools(dependencies());
    const { data } = await tools.read_routines.execute({ from: '2026-09-24', to: '2026-09-27' });
    expect(data).toMatchObject({ routines: [savedRoutine], history_from: '2026-09-21', history_to: '2026-09-27',
      progress_on_from: [{ routine_id: routineId, weekCompleted: 1, weekTarget: 3, remainingThisWeek: 2 }],
      reservations: [{ routine_id: routineId, date: '2026-09-24', minutes: 30 }, { routine_id: routineId, date: '2026-09-25', minutes: 30 }] });
    expect(queryMock.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
    expect(queryMock.mock.calls.find(([sql]) => sql.includes('SELECT r.*'))![0]).toContain('r.archived_at IS NULL');
    expect(queryMock.mock.calls.find(([sql]) => sql.includes('SELECT r.*'))![0]).toContain('archived_goals');
  });
  it('bounds routine history and does not silently interpret malformed dates', () => {
    const schema = createCopilotTools(dependencies()).read_routines.parameters;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ from: '2026-09-24' }).success).toBe(false);
    expect(schema.safeParse({ from: '2026-09-24', to: '2026-09-27' }).success).toBe(true);
    expect(schema.safeParse({ from: '2026-09-24', to: '2027-09-27' }).success).toBe(false);
    expect(schema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(false);
  });
  it('can list saved routines without making the user supply a date range', async () => {
    const { data } = await createCopilotTools(dependencies()).read_routines.execute({});
    expect(data).toMatchObject({ from: '2026-09-24', to: '2026-09-30', routines: [savedRoutine] });
  });
  it('pages routines with explicit coverage and literal parameterized search', async () => {
    queryMock.mockImplementation(async sql => ({ rows: sql.includes('SELECT timezone') ? [{ timezone: 'Asia/Beirut' }]
      : sql.includes('SELECT r.*') ? [savedRoutine, { ...savedRoutine, id: '22222222-2222-4222-8222-222222222222' }] : [] }) as never);
    const { data } = await createCopilotTools(dependencies()).read_routines.execute({ search: '50%', limit: 1 });
    expect(data).toMatchObject({ routines: [savedRoutine], coverage: { limit: 1, returned: 1, has_more: true, next_after: routineId } });
    const [sql, params] = queryMock.mock.calls.find(([sql]) => sql.includes('SELECT r.*'))!;
    expect(sql).not.toContain('50%');
    expect(params).toEqual(['%50\\%%', 2]);
  });
  it('grounds routine changes using a fresh routine read and includes feature semantics in the model prompt', async () => {
    const tools = createCopilotTools(dependencies());
    const proposed = { reply: 'The routine archive is ready to apply.', actions: [{ type: 'update_routine', params: { routine_id: routineId, changes: { archived: true } } }] };
    const complete = vi.fn().mockResolvedValueOnce(JSON.stringify({ tool_calls: [{ id: 'r', name: 'read_routines', arguments: { from: '2026-09-24', to: '2026-09-27' } }] })).mockResolvedValueOnce(JSON.stringify(proposed));
    const options = { tools, turns: [{ role: 'user' as const, content: 'Archive Daily revision' }], clock: { today: '2026-09-24', time: '10:00', timezone: 'Asia/Beirut' },
      complete, reviewComplete: vi.fn(async () => JSON.stringify({ verdict: 'supported' })) };
    const result = await runCopilotConversation(options);
    expect(result.actions[0].rejected_reason).toBeUndefined();
    expect(complete.mock.calls[0][0][0].content).toContain('Native tracked habits');
    const ungrounded = await runCopilotConversation({ ...options, complete: vi.fn(async () => JSON.stringify(proposed)) });
    expect(ungrounded.actions[0].rejected_reason).toContain('Read the current routine_id');
  });
  it('does not offer mutations the native routine service cannot perform', () => {
    const [action] = validateModelActions([{ type: 'update_routine', params: { routine_id: routineId, changes: { weekly_target: 4 } } }]);
    expect(action.rejected_reason).toBeTruthy();
  });
  it('repairs invalid structured routine fields through the model instead of claiming a rejected routine was added', async () => {
    const tools = createCopilotTools(dependencies());
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ reply: 'Added.', actions: [{ type: 'create_routine', params: { ...nativeRoutine, target_count: 1 } }] }))
      .mockResolvedValueOnce(JSON.stringify({ tool_calls: [{ id: 'r', name: 'read_routines', arguments: { from: '2026-09-24', to: '2026-09-27' } }] }))
      .mockResolvedValueOnce(JSON.stringify({ reply: 'Ready to review and apply.', actions: [{ type: 'create_routine', params: nativeRoutine }] }));
    const result = await runCopilotConversation({ tools, complete, reviewComplete: vi.fn(async () => JSON.stringify({ verdict: 'supported' })),
      turns: [{ role: 'user', content: 'Create a daily 30 minute revision routine at 8 AM from tomorrow' }],
      clock: { today: '2026-09-24', time: '10:00', timezone: 'Asia/Beirut' } });
    expect(result.actions[0].rejected_reason).toBeUndefined();
    expect(result.actions[0].params.target_count).toBe(30);
    expect(result.reply).toBe('Ready to review and apply.');
    expect(complete.mock.calls[1][0].some((message: { content: string }) => message.content.includes('Proposal validation feedback'))).toBe(true);
    expect(transaction).not.toHaveBeenCalled();
  });
  it('stops repeated invalid proposals instead of returning a false success message', async () => {
    const complete = vi.fn(async () => JSON.stringify({ reply: 'Added.', actions: [{ type: 'create_routine', params: { ...nativeRoutine, target_count: 1 } }] }));
    await expect(runCopilotConversation({ tools: createCopilotTools(dependencies()), complete,
      turns: [{ role: 'user', content: 'Add a routine' }], clock: { today: '2026-09-24', time: '10:00', timezone: 'Asia/Beirut' } })).rejects.toThrow('Nothing was changed');
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe('native routine proposal application', () => {
  async function apply(type: string, params: unknown, options: { archived?: boolean; alreadyApplied?: boolean } = {}) {
    const execute = vi.fn(async (sql: string) => ({ rows:
      sql.includes('FROM ai_action_proposals') ? [{ status: options.alreadyApplied ? 'applied' : 'pending', action_type: type, action_payload: JSON.stringify(params) }]
        : sql.startsWith('WITH RECURSIVE') ? []
        : sql.startsWith('SELECT id FROM routines') ? options.archived ? [] : [savedRoutine]
        : sql.startsWith('SELECT * FROM routines') ? [savedRoutine]
        : sql.includes('SELECT timezone') ? [{ timezone: 'Asia/Beirut' }]
        : sql.includes('SELECT * FROM routine_entries') ? [{ id: 'entry', minutes: 7, completed_count: 7, status: 'partial' }]
        : sql.startsWith('INSERT INTO routines') || sql.startsWith('UPDATE routines') ? [savedRoutine] : [], rowCount: 1 }));
    vi.mocked(transaction).mockImplementation(async fn => fn({ query: execute } as never));
    const layer = (aiProposalsRouter as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: Function }> } }> }).stack.find(layer => layer.route?.path === '/proposals/:id/apply')!;
    const res = { json: vi.fn() };
    const promise = layer.route!.stack[0].handle({ params: { id: 'proposal' } }, res);
    return { execute, res, promise };
  }
  it('creates a real routine in the proposal transaction without making tasks or events', async () => {
    const { execute, res, promise } = await apply('create_routine', nativeRoutine);
    await promise;
    expect(res.json).toHaveBeenCalledWith({ ok: true, action_type: 'create_routine', id: routineId });
    expect(execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO routines'))).toHaveLength(1);
    expect(execute.mock.calls.at(-1)![0]).toContain("status='applied'");
    expect(execute.mock.calls.some(([sql]) => /INSERT INTO (tasks|events|work_sessions)/.test(sql))).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it('checks in through the same routine service, preserving logged minutes without fabricating focus sessions', async () => {
    const { execute, promise } = await apply('check_in_routine', { routine_id: routineId, entry: { date: '2026-09-24', status: 'completed' } });
    await promise;
    expect(execute.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO routine_entries'))).toBe(true);
    expect(execute.mock.calls.some(([sql]) => sql.includes('work_sessions'))).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it('archives through the native service, retaining history', async () => {
    const { execute, promise } = await apply('update_routine', { routine_id: routineId, changes: { archived: true } });
    await promise;
    expect(execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE routines'))).toBe(true);
    expect(execute.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
  });
  it('rechecks archived targets and never applies a proposal twice', async () => {
    for (const options of [{ archived: true }, { alreadyApplied: true }]) {
      const { execute, promise } = await apply('update_routine', { routine_id: routineId, changes: { archived: true } }, options);
      await expect(promise).rejects.toMatchObject({ status: options.archived ? 404 : 409 });
      expect(execute.mock.calls.some(([sql]) => /^(UPDATE|INSERT|DELETE)/.test(sql))).toBe(false);
    }
  });
  it('rejects future completion and invalid payloads before any mutation', async () => {
    for (const entry of [{ date: '2026-09-25', status: 'completed' }, { date: '2026-02-30', status: 'completed' }]) {
      const { execute, promise } = await apply('check_in_routine', { routine_id: routineId, entry });
      await expect(promise).rejects.toMatchObject({ status: 400 });
      expect(execute.mock.calls.some(([sql]) => /^(UPDATE|INSERT|DELETE)/.test(sql))).toBe(false);
    }
  });
  it('hides stale routine proposals when a routine or its goal has been archived', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] } as never).mockResolvedValueOnce({ rows: [{ id: routineId }] } as never);
    const result = await activeProposals([{ action_type: 'check_in_routine', action_payload: JSON.stringify({ routine_id: routineId, entry: { date: '2026-09-24', status: 'completed' } }) }]);
    expect(result).toEqual([]);
  });
});
