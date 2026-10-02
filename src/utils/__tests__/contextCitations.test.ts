import { describe, expect, it } from 'vitest';
import { citationsForContext } from '../../../server/services/contextCitations.js';
const candidates = [{ entity_id: 'task', title: 'Task' }, { entity_id: 'journal', title: 'Journal' }];
describe('selected context citations', () => {
  it('does not count unrelated tasks and journals when only resource metadata was read', () => {
    expect(citationsForContext({ resources: [{ id: 'book' }], note: 'task' }, candidates)).toEqual([]);
  });
  it('retains nested entities and explicit linked IDs actually provided to the model', () => {
    expect(citationsForContext({ graph: { tasks: [{ id: 'task' }] } }, candidates)).toEqual([candidates[0]]);
    expect(citationsForContext({ timeline: [{ task_ids: ['task'] }] }, candidates)).toEqual([candidates[0]]);
    expect(citationsForContext({ recent: [{ entity_id: 'journal' }] }, candidates)).toEqual([candidates[1]]);
  });
});
