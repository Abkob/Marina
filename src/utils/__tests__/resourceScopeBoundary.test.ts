import { describe, expect, it } from 'vitest';
import { enforceResourceScope, scopeKey } from '../../../shared/resourceScope';
import { historyInScope } from '../../../server/services/scopedConversation';
import { resourceScopeSql } from '../../../server/services/resourceContext';
describe('server resource context boundary', () => {
  it('allows narrowing but rejects replacing a selected goal or document set', () => {
    expect(enforceResourceScope({ goal_id:'g' },{ task_id:'t' })).toMatchObject({ goal_id:'g', task_id:'t' });
    expect(() => enforceResourceScope({ goal_id:'g' },{ goal_id:'other' })).toThrow('outside');
    expect(() => enforceResourceScope({ resource_ids:['r'] },{ resource_ids:['other'] })).toThrow('outside');
    expect(enforceResourceScope({ task_id:'t',include_subtasks:false },{ include_subtasks:true })).toMatchObject({ include_subtasks:false });
  });
  it('makes descendants opt-in and intersects a selected file with its goal', () => {
    const values: unknown[] = [];
    const sql = resourceScopeSql({ goal_id:'g',task_id:'t',resource_ids:['r'] }, values);
    expect(values).toEqual(['g','t',['r']]);
    expect(sql).not.toContain('JOIN selected_tasks p');
    expect(resourceScopeSql({task_id:'t',include_subtasks:true},[])).toContain('JOIN selected_tasks p');
    expect(sql).toContain('r.id=ANY($3::text[])');
  });
  it('does not let old excerpts cross a context change through chat history', () => {
    const row = (goal_id: string) => ({ metadata_json: JSON.stringify({ resource_scope:{goal_id} }), content:goal_id });
    const rows = [row('g'),row('other'),row('g'),row('g')];
    expect(historyInScope(rows,{goal_id:'g'})).toEqual(rows.slice(2));
    expect(historyInScope(rows,{task_id:'t'})).toEqual([]);
    expect(scopeKey({resource_ids:['a','b']})).toBe(scopeKey({resource_ids:['b','a']}));
  });
});
