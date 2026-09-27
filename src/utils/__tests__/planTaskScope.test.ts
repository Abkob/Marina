import { describe, expect, it } from 'vitest';
import { resolvePlanTaskScope } from '../../../server/services/planTaskScope.js';

const tasks = new Map([
  ['parent', { parent_task_id: null }], ['child', { parent_task_id: 'parent' }],
  ['grandchild', { parent_task_id: 'child' }], ['other', { parent_task_id: null }],
]);
describe('explicit planning scope', () => {
  it('limits a parent request to its own descendants', () => {
    expect([...resolvePlanTaskScope({ task_id: 'parent' }, tasks)!].sort()).toEqual(['child', 'grandchild', 'parent']);
  });
  it('does not broaden a leaf request to its parent or siblings', () => {
    expect([...resolvePlanTaskScope({ task_ids: ['grandchild', 'other'] }, tasks)!]).toEqual(['grandchild', 'other']);
  });
  it('refuses unavailable IDs instead of falling back to the backlog', () => {
    expect(() => resolvePlanTaskScope({ task_id: 'archived-or-missing' }, tasks)).toThrow('no substitute');
  });
  it('leaves broad scope explicit and terminates on corrupt hierarchy cycles', () => {
    expect(resolvePlanTaskScope({}, tasks)).toBeNull();
    expect(resolvePlanTaskScope({ task_id: 'a' }, new Map([['a', { parent_task_id: 'b' }], ['b', { parent_task_id: 'a' }]]))?.size).toBe(2);
  });
});
