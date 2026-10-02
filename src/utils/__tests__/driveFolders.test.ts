import { describe, expect, it, vi } from 'vitest';
import { resourceFolderPath } from '../../../server/services/driveFolders';
function database(records:Record<string,Record<string,unknown>>) {
  return { query:vi.fn(async (_sql:string,values:unknown[])=>({rows:records[String(values[0])]?[records[String(values[0])]]:[]})) } as unknown as Parameters<typeof resourceFolderPath>[0];
}
describe('canonical resource folder ancestry',()=>{
  it('preserves goal, milestone, parent task and subtask identities even with duplicate titles',async()=>{
    const db=database({sub:{id:'sub',title:'Study',parent_task_id:'parent',goal_id:null,milestone_id:null},
      parent:{id:'parent',title:'Study',parent_task_id:null,goal_id:'goal',milestone_id:'milestone'},
      milestone:{id:'milestone',title:'Week 1',goal_id:'goal'},goal:{id:'goal',title:'Algebra'}});
    expect((await resourceFolderPath(db,{attach_to_type:'task',attach_to_id:'sub'})).map(x=>[x.type,x.id])).toEqual([['goal','goal'],['milestone','milestone'],['task','parent'],['task','sub']]);
  });
  it('uses Library for unassigned files',async()=>{
    expect(await resourceFolderPath(database({}),{})).toEqual([{id:'library',title:'Library',type:'library'}]);
  });
  it('rejects missing or inconsistent targets and cycles',async()=>{
    await expect(resourceFolderPath(database({}),{attach_to_id:'x'})).rejects.toThrow();
    await expect(resourceFolderPath(database({}),{attach_to_type:'goal',attach_to_id:'missing'})).rejects.toMatchObject({status:404});
    await expect(resourceFolderPath(database({a:{id:'a',title:'A',parent_task_id:'a'}}),{attach_to_type:'task',attach_to_id:'a'})).rejects.toMatchObject({status:409});
    await expect(resourceFolderPath(database({a:{id:'a',title:'A',goal_id:'g',milestone_id:'m'},m:{id:'m',goal_id:'other'}}),{attach_to_type:'task',attach_to_id:'a'})).rejects.toMatchObject({status:409});
  });
});
