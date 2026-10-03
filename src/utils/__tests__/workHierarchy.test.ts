import { describe,it,expect } from 'vitest';
import { buildWorkHierarchy, type HierarchyTask } from '../../../shared/workHierarchy';
const task=(id:string,estimated_minutes:number|null=60,parent_task_id:string|null=null,time_rollup_mode='additive'):HierarchyTask=>({id,estimated_minutes,parent_task_id,time_rollup_mode});
const root=(tasks:HierarchyTask[])=>buildWorkHierarchy(tasks).summaries.get('p')!;
describe('P03.2 hierarchy accounting',()=>{
  it('does not treat an unfinished zero-forecast child as completed under a completed parent',()=>{
    const child={...task('c',60,'p'),remaining_forecast_minutes:0,remaining_forecast_work_version:1,remaining_forecast_log_version:0,work_version:1,worklog_version:0};
    expect(root([{...task('p',null),completed:true},child]).issues).toContain('completed_parent_has_open_work');
  });
  it('preserves each unique work item under shuffled and duplicate joins in 500 generated trees',()=>{
    let seed=123456;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    for(let trial=0;trial<500;trial++){
      const rows:HierarchyTask[]=Array.from({length:50},(_,i)=>({...task(String(i),Math.floor(random()*120)+1,i?String(Math.floor(random()*i)):null,random()<0.5?'inclusive':'additive'),logged_minutes:0}));
      const original=buildWorkHierarchy(rows);const joined=buildWorkHierarchy([...rows,...rows.slice(0,20)].reverse());
      expect(joined.total).toEqual(original.total);
      expect(original.total.remaining_minutes).toBe([...original.summaries.values()].reduce((sum,row)=>sum+(row.own.remaining_minutes??0),0));
    }
  });
  it('counts included 60+60 inside 120 exactly once',()=>{
    const value=root([task('p',120),task('a',60,'p','inclusive'),task('b',60,'p','inclusive')]);
    expect(value).toMatchObject({estimated_minutes:120,remaining_minutes:120,residual_estimated_minutes:0,executable:false});
    expect(value.own.remaining_minutes).toBe(0);
  });
  it('adds 30 parent work to two 60 minute children',()=>{
    expect(root([task('p',30),task('a',60,'p'),task('b',60,'p')])).toMatchObject({estimated_minutes:150,remaining_minutes:150,residual_estimated_minutes:30,executable:true});
  });
  it('preserves mixed child modes and exposes unallocated parent work',()=>{
    expect(root([task('p',240),task('a',90,'p','inclusive'),task('b',120,'p')])).toMatchObject({estimated_minutes:360,remaining_minutes:360,residual_estimated_minutes:150});
  });
  it('keeps completed included children inside the original budget without reintroducing their effort',()=>{
    expect(root([task('p',120),{...task('a',60,'p','inclusive'),completed:true},task('b',60,'p','inclusive')])).toMatchObject({estimated_minutes:120,remaining_minutes:60,residual_estimated_minutes:0});
  });
  it('credits logs only against the task that owns them',()=>{
    const value=root([{...task('p',150),logged_minutes:10},{...task('a',60,'p','inclusive'),logged_minutes:20},task('b',60,'p','inclusive')]);
    expect(value).toMatchObject({residual_estimated_minutes:30,remaining_minutes:120,logged_minutes:30});
    expect(value.own.remaining_minutes).toBe(20);
  });
  it('keeps unknown included work partial instead of treating the parent budget as coverage',()=>{
    expect(root([task('p',120),task('a',null,'p','inclusive'),task('b',60,'p','inclusive')])).toMatchObject({estimated_minutes:null,remaining_minutes:null,known_remaining_minutes:60,residual_estimated_minutes:null});
  });
  it('treats a parent with no estimate as a container without inventing overhead',()=>{
    expect(root([task('p',null),task('a',60,'p'),task('b',60,'p')])).toMatchObject({estimated_minutes:120,remaining_minutes:120,residual_estimated_minutes:0});
  });
  it('applies an explicit parent forecast to residual work only',()=>{
    const p={...task('p',120),work_version:2,worklog_version:0,remaining_forecast_minutes:15,remaining_forecast_work_version:2,remaining_forecast_log_version:0};
    expect(root([p,task('a',60,'p','inclusive'),task('b',60,'p','inclusive')]).remaining_minutes).toBe(135);
  });
  it('does not conceal unfinished children behind a completed parent',()=>{
    expect(root([{...task('p',120),completed:true},task('a',60,'p')])).toMatchObject({remaining_minutes:null,issues:['completed_parent_has_open_work']});
  });
  it('deduplicates identical joined task rows',()=>{
    const p=task('p',30),a=task('a',60,'p');
    expect(root([p,a,a,p]).remaining_minutes).toBe(90);
  });
  it('rejects conflicting duplicates, missing parents and incomplete child loads',()=>{
    expect(root([task('p'),task('p',90)]).issues).toContain('conflicting_duplicate');
    expect(root([task('p',60,'absent')]).issues).toContain('missing_parent');
    expect(root([{...task('p',120),child_count:2},task('a',60,'p')]).issues).toContain('children_not_loaded');
  });
  it('terminates self-cycles and longer cycles and does not offer their descendants for scheduling',()=>{
    for(const tasks of [[task('p',60,'p')],[task('p',60,'a'),task('a',60,'p'),task('leaf',60,'p')]]){
      const tree=buildWorkHierarchy(tasks); expect(tree.total.remaining_minutes).toBeNull();
      for(const value of tree.summaries.values()){expect(value.executable).toBe(false);expect(value.issues).toContain('hierarchy_cycle');}
    }
  });
  it('handles a 10,000-deep included hierarchy without recursion or quadratic descendant lists',()=>{
    const tasks=Array.from({length:10000},(_,i)=>task(String(i),60,i?String(i-1):null,'inclusive'));
    const result=buildWorkHierarchy(tasks);
    expect(result.summaries.size).toBe(10000);expect(result.total.remaining_minutes).toBe(60);
    expect(result.summaries.get('0')?.leaf_count).toBe(1);
    expect([...result.summaries.values()].reduce((sum,row)=>sum+row.child_ids.length,0)).toBe(9999);
  });
  it('agrees under reversed input order on a broad mixed hierarchy',()=>{
    const tasks=[task('p',1000),...Array.from({length:10000},(_,i)=>task('c'+i,1,'p',i%2?'inclusive':'additive'))];
    const a=buildWorkHierarchy(tasks),b=buildWorkHierarchy([...tasks].reverse());
    expect(a.total).toEqual(b.total);expect(a.total.remaining_minutes).toBe(10000);
  });
});
