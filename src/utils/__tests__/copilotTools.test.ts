import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCopilotTools, readCopilotClock } from '../../../server/services/copilotTools.js';
import { query } from '../../../server/db.js';
import { searchResearchEvidence } from '../../../server/services/researchRag.js';
vi.mock('../../../server/db.js', () => ({ query: vi.fn() }));
const queryMock = vi.mocked(query);
const dependencies = () => ({ workspace: vi.fn(async () => ({})), previewSchedule: vi.fn(async () => ({})), previewRoutine: vi.fn(async () => ({})), scheduleDay: vi.fn(async () => null), overdueTasks: vi.fn(async () => ({ tasks: [] })) });
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never); });

describe('conversation tool contracts', () => {
  it('lets the model request only capacity without classifying its wording', async () => {
    const deps = dependencies();
    await createCopilotTools(deps).workspace_context.execute({ sections: ['capacity'] });
    expect(deps.workspace).toHaveBeenCalledExactlyOnceWith(undefined, ['capacity']);
  });
  it('pages past the overview using bounded read-only SQL with literal search and archive filtering', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'b' }, { id: 'c' }, { id: 'd' }] } as never);
    const result = await createCopilotTools(dependencies()).find_tasks.execute({ search: '50% draft_', goal_id: 'g', after: 'a', limit: 2 });
    expect(result.data).toMatchObject({ tasks: [{ id: 'b' }, { id: 'c' }], coverage: { has_more: true, next_after: 'c' } });
    const [sql, values] = queryMock.mock.calls[0];
    expect(sql).toContain('WITH RECURSIVE');
    expect(sql).toContain('ORDER BY t.id LIMIT');
    expect(sql).not.toContain('50%');
    expect(values).toEqual(['%50\\%%', '%draft\\_%', 'g', 'a', 3]);
  });
  it('reports an empty task search without replacing it with popular tasks', async () => {
    expect((await createCopilotTools(dependencies()).find_tasks.execute({ search: 'missing' })).data).toMatchObject({ tasks: [], coverage: { has_more: false, next_after: null } });
  });
  it('requires an explicit plan window rather than defaulting to two weeks', () => {
    const schema = createCopilotTools(dependencies()).preview_schedule.parameters;
    expect(schema.safeParse({ task_id: 'one' }).success).toBe(false);
    expect(schema.safeParse({ task_ids: ['one', 'two'], from_date: '2026-09-28', to_date: '2026-10-02' }).success).toBe(true);
    expect(schema.safeParse({ from_date: '2026-10-02', to_date: '2026-09-28' }).success).toBe(false);
    expect(schema.safeParse({ horizon_days: 7, start_hour: 13 }).success).toBe(false);
    expect(schema.safeParse({ horizon_days: 7, start_hour: 13, end_hour: 14 }).success).toBe(true);
  });
  it('refuses malformed and excessive date ranges', () => {
    const schema = createCopilotTools(dependencies()).schedule_range.parameters;
    expect(schema.safeParse({ from: '2026-02-30', to: '2026-03-02' }).success).toBe(false);
    expect(schema.safeParse({ from: '2026-09-28', to: '2026-09-27' }).success).toBe(false);
    expect(schema.safeParse({ from: '2026-09-28', to: '2027-09-28' }).success).toBe(false);
  });
  it('does not substitute an available day for an unavailable requested day', async () => {
    const deps = dependencies();
    await expect(createCopilotTools(deps).show_schedule_day.execute({ date: '2027-01-01' })).rejects.toThrow('do not show a different day');
    expect(deps.scheduleDay).toHaveBeenCalledExactlyOnceWith('2027-01-01');
  });
  it('reads exact IDs with ancestor archive filtering and reports missing IDs', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'found', title: 'Found' }] } as never);
    const result = await createCopilotTools(dependencies()).task_details.execute({ task_ids: ['found', 'missing'] });
    expect(result.data).toMatchObject({ missing_ids: ['missing'] });
    expect(queryMock.mock.calls[0][1]).toEqual([['found', 'missing']]);
    expect(queryMock.mock.calls[0][0]).toContain('archived_at');
    expect(queryMock.mock.calls[0][0]).toContain('WITH RECURSIVE');
  });
  it('uses read-only queries for calendar inspection and archived-resource filtering for research', async () => {
    await createCopilotTools(dependencies()).schedule_range.execute({ from: '2026-09-24', to: '2026-09-25' });
    await searchResearchEvidence('thesis research');
    expect(queryMock).toHaveBeenCalledTimes(4);
    for (const [sql] of queryMock.mock.calls) {
      expect(sql.trimStart()).toMatch(/^SELECT/);
      expect(sql).toContain('archived_at');
    }
  });
  it('uses the saved timezone for relative dates and times', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T22:30:00Z'));
    queryMock.mockResolvedValueOnce({ rows: [{ timezone: 'Asia/Beirut' }] } as never);
    try { expect(await readCopilotClock()).toEqual({ today: '2026-09-25', time: '01:30', timezone: 'Asia/Beirut' }); }
    finally { vi.useRealTimers(); }
  });
});
