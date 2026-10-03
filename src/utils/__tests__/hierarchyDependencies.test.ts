import { describe, expect, it } from 'vitest';
import { buildWorkHierarchy } from '../../../shared/workHierarchy';
import { hierarchyDependencies } from '../../../shared/hierarchyDependencies';
const task = (id: string, parent_task_id: string | null = null, estimated_minutes = 60) => ({ id, parent_task_id, estimated_minutes });
describe('hierarchical prerequisites', () => {
  it('waits for residual parent work and every executable descendant', () => {
    const graph = buildWorkHierarchy([task('p'), task('a', 'p'), task('b', 'p'), task('next')]);
    expect(hierarchyDependencies(graph, [{ blocker_id: 'p', task_id: 'next' }]).get('next')).toEqual(['a','b','p']);
  });
  it('inherits parent prerequisites without duplicating explicit edges', () => {
    const graph = buildWorkHierarchy([task('p', null, 0), task('c', 'p'), task('before')]);
    const map = hierarchyDependencies(graph, [{ blocker_id: 'before', task_id: 'p' }, { blocker_id: 'before', task_id: 'c' }]);
    expect(map.get('c')).toEqual(['before']);
  });
  it('excludes verified completed prerequisites but preserves missing and unfinished zero work', () => {
    const graph = buildWorkHierarchy([{...task('done'), completed:true}, {...task('zero'),remaining_forecast_minutes:0,work_version:1,worklog_version:0,remaining_forecast_work_version:1,remaining_forecast_log_version:0}, task('next')]);
    expect(hierarchyDependencies(graph, ['done','missing','zero'].map(blocker_id => ({blocker_id,task_id:'next'}))).get('next')).toEqual(['missing','zero']);
  });
  it('does not hide unfinished children behind a completed parent', () => {
    const graph = buildWorkHierarchy([{...task('p'), completed:true},task('c','p'),task('next')]);
    expect(hierarchyDependencies(graph,[{blocker_id:'p',task_id:'next'}]).get('next')).toEqual(['c','p']);
  });
  it('terminates cyclic legacy hierarchies and leaves a blocking self dependency', () => {
    const graph=buildWorkHierarchy([task('a','b'),task('b','a')]);
    expect(hierarchyDependencies(graph,[{blocker_id:'a',task_id:'b'}]).get('a')).toEqual(['a','b']);
  });
  it('bounds dependency expansion and fails closed', () => {
    const graph=buildWorkHierarchy([task('p'),task('a','p'),task('b','p'),task('next')]);
    expect(hierarchyDependencies(graph,[{blocker_id:'p',task_id:'next'}],2).get('next')).toEqual(['unresolved:hierarchy-dependency-limit']);
  });
  it('expands a 10,000-deep inclusive chain without recursion or duplicate work', () => {
    const graph=buildWorkHierarchy(Array.from({length:10000},(_,i)=>({...task(String(i),i?String(i-1):null),time_rollup_mode:'inclusive'})).concat({...task('next'),time_rollup_mode:'additive'}));
    expect(hierarchyDependencies(graph,[{blocker_id:'0',task_id:'next'}]).get('next')).toEqual(['9999']);
  });
});
