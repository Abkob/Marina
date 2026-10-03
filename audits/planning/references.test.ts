import { describe, expect, it, vi } from 'vitest';
import { actionReferences, observedReferences, unavailableReferences } from '../../server/services/copilotReferences';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../server/db', () => ({ query: mocks.query }));

describe('P01.1 identity provenance', () => {
  it.each(['find_resources', 'read_document', 'inspect_document_page', 'search_documents', 'research_search'])('%s confers resource identity only', tool => {
    const refs = observedReferences(tool, { resource_id: 'r', tasks: [{ id: 'victim' }], evidence: [{ resource_id: 'r2', id: 'chunk', task_id: 'victim', metadata: { tasks: [{ id: 'victim' }] }, passage: 'task_id: victim' }], coverage: { task_ids: ['victim'] }, missing_ids: ['victim'] });
    expect(refs.map(ref => [ref.kind, ref.id])).toEqual([['resource', 'r'], ['resource', 'r2']]);
  });
  it('retains canonical task relationships, without arbitrary metadata IDs', () => {
    expect(observedReferences('workspace_context', { graph: { tasks: [{ id: 't', goal_id: 'g', parent_task_id: 'p', milestone_id: 'm', metadata: { id: 'evil' }, children: [{ id: 'c' }] }], goals: [{ id: 'unassigned' }] } }).map(({ kind, id }) => `${kind}:${id}`).sort()).toEqual(['goal:g', 'milestone:m', 'task:c', 'task:p', 'task:t']);
    expect(observedReferences('find_tasks', { coverage: { tasks: [{ id: 'echo' }] }, missing_ids: ['echo'], id: 'bare' })).toEqual([]);
  });
  it('supports routine and saved resource association reads', () => {
    expect(observedReferences('read_routines', { routines: [{ id: 'routine', goal_id: 'goal' }] }).map(ref => ref.kind)).toEqual(['routine', 'goal']);
    expect(observedReferences('resource_context', { resources: [{ id: 'r', tasks: [{ id: 't' }], goals: [{ id: 'g' }] }] }).map(ref => ref.kind).sort()).toEqual(['goal', 'resource', 'task']);
  });
  it('derives attachment target kind and task filters from their schemas', () => {
    expect(actionReferences({ resource_id: 'same', target_id: 'same', target_type: 'task', task_ids: ['selected'], prose: { task_id: 'fake' } })).toEqual([
      { kind: 'resource', id: 'same', field: 'resource_id' }, { kind: 'task', id: 'selected', field: 'task_ids' }, { kind: 'task', id: 'same', field: 'target_id' },
    ]);
  });
  it('requires the exact active table even when an ID exists in a different table', async () => {
    mocks.query.mockReset().mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT id FROM resources') ? [{ id: 'same' }] : [] }));
    const refs = actionReferences({ task_id: 'same', resource_id: 'same' });
    expect(await unavailableReferences(refs)).toEqual([{ kind: 'task', id: 'same', field: 'task_id' }]);
    expect(mocks.query.mock.calls.map(call => call[0])).toEqual([expect.stringContaining('FROM tasks'), expect.stringContaining('FROM resources')]);
    expect(mocks.query.mock.calls.every(call => call[0].includes('SELECT entity_key FROM archived_entities'))).toBe(true);
  });
  it('rejects excessive references before database access', async () => {
    mocks.query.mockReset();
    await expect(unavailableReferences(Array(10000).fill({ kind: 'task', id: 't', field: 'task_ids' }))).rejects.toThrow('Too many');
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
