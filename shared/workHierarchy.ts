import { accountWork, MAX_WORK_MINUTES, validMinutes, type WorkAccounting, type WorkInputs } from './workAccounting.js';

export interface HierarchyTask extends WorkInputs {
  id: string;
  title?: string;
  parent_task_id?: string | null;
  goal_id?: string | null;
  time_rollup_mode?: string | null;
  child_count?: number | null;
}
export interface HierarchyWork {
  id: string;
  parent_id: string | null;
  child_ids: string[];
  relation: 'inclusive' | 'additive';
  estimated_minutes: number | null;
  known_estimated_minutes: number;
  residual_estimated_minutes: number | null;
  own: WorkAccounting;
  remaining_minutes: number | null;
  known_remaining_minutes: number;
  unknown_count: number;
  logged_minutes: number;
  logged_task_count: number;
  reserved_minutes: number;
  unscheduled_minutes: number | null;
  known_unscheduled_minutes: number;
  leaf_count: number;
  completed_leaf_count: number;
  estimated_leaf_minutes: number;
  completed_leaf_minutes: number;
  issues: string[];
  executable: boolean;
}
const relevant = (t: HierarchyTask) => JSON.stringify([t.parent_task_id ?? null,t.goal_id ?? null,t.time_rollup_mode ?? 'additive',
  t.estimated_minutes ?? null,t.logged_minutes ?? null,t.actual_minutes ?? null,t.completed ?? false,t.status ?? 'todo',
  t.work_version,t.worklog_version,t.remaining_forecast_minutes,t.remaining_forecast_work_version,t.remaining_forecast_log_version,t.forecast_revision]);
const done = (t: HierarchyTask) => t.completed === true || t.status === 'done';

/** Each ID owns one work item. Extra graph/resource links never create additional work.
 * Iterative parent-path resolution and leaf-first aggregation use O(n) storage.
 * The CHILD's rollup mode describes its relation to the parent, preserving Marina's model.
 */
export function buildWorkHierarchy(input: HierarchyTask[], reservations?: ReadonlyMap<string, WorkAccounting>) {
  const tasks = new Map<string, HierarchyTask>();
  const conflicts = new Set<string>();
  for (const task of input) {
    const previous = tasks.get(task.id);
    if (previous && relevant(previous) !== relevant(task)) conflicts.add(task.id);
    if (!previous) tasks.set(task.id, task);
  }
  const children = new Map<string, string[]>();
  for (const task of tasks.values()) {
    if (task.parent_task_id && tasks.has(task.parent_task_id)) {
      const list = children.get(task.parent_task_id) ?? []; list.push(task.id); children.set(task.parent_task_id, list);
    }
  }
  for (const list of children.values()) list.sort();
  const rootOf = new Map<string, string>();
  const invalid = new Map<string, string>();
  for (const task of tasks.values()) {
    if (rootOf.has(task.id)) continue;
    const path: string[] = []; const positions = new Map<string, number>(); let cursor: string | null = task.id;
    let root = task.id; let problem: string | undefined;
    while (cursor) {
      if (rootOf.has(cursor)) { root = rootOf.get(cursor)!; problem = invalid.get(cursor); break; }
      if (positions.has(cursor)) { root = path.slice(positions.get(cursor)).sort()[0]; problem = 'hierarchy_cycle'; break; }
      const row = tasks.get(cursor);
      if (!row) { problem = 'missing_parent'; root = path.at(-1)!; break; }
      positions.set(cursor,path.length); path.push(cursor); root = cursor;
      if (conflicts.has(cursor)) { problem = 'conflicting_duplicate'; break; }
      cursor = row.parent_task_id ?? null;
    }
    for (const id of path) { rootOf.set(id,root); if(problem) invalid.set(id,problem); }
  }
  // A duplicate below a valid root also makes that ancestor's total incomplete.
  const summaries = new Map<string, HierarchyWork>();
  const pending = new Map<string, number>(); const queue: string[] = [];
  for (const id of tasks.keys()) { const count = children.get(id)?.length ?? 0; pending.set(id,count); if(!count || invalid.has(id)) queue.push(id); }
  const compute = (id: string): HierarchyWork => {
    const task = tasks.get(id)!; const childIds = children.get(id) ?? []; const isParent = childIds.length > 0 || Number(task.child_count ?? 0)>0;
    const childRows = childIds.map(child=>summaries.get(child)).filter((row): row is HierarchyWork=>Boolean(row));
    const issues: string[] = []; if(invalid.has(id)) issues.push(invalid.get(id)!);
    if(Number(task.child_count ?? 0)>childIds.length) issues.push('children_not_loaded');
    if(childRows.some(child=>child.issues.length)) issues.push('child_needs_review');
    if(task.time_rollup_mode != null && !['inclusive','additive'].includes(task.time_rollup_mode)) issues.push('invalid_rollup_mode');
    const included = childRows.filter(child=>child.relation==='inclusive');
    const extra = childRows.filter(child=>child.relation==='additive');
    const includedKnown = included.reduce((sum,child)=>sum+child.known_estimated_minutes,0);
    const extraKnown = extra.reduce((sum,child)=>sum+child.known_estimated_minutes,0);
    const estimate = validMinutes(task.estimated_minutes);
    const hasEstimate = estimate !== null && estimate > 0;
    const estimateInvalid = task.estimated_minutes != null && estimate === null;
    const childrenEstimated = childRows.every(child=>child.estimated_minutes!==null);
    const includedEstimated = included.every(child=>child.estimated_minutes!==null);
    const knownEstimate = Math.max(hasEstimate ? estimate : 0,includedKnown)+extraKnown;
    const totalEstimate = estimateInvalid || !childrenEstimated || issues.length || (!isParent && !hasEstimate) ? null : knownEstimate;
    const residual = !isParent ? estimate : !includedEstimated || issues.length || estimateInvalid ? null : hasEstimate ? Math.max(0,estimate-includedKnown) : 0;
    const reserved = reservations?.get(id);
    let own = accountWork({...task,estimated_minutes:residual},reserved?.reserved_minutes, reserved?.stale_reservation_count);
    // A fully distributed parent budget (or an unestimated container) invents no extra work.
    // An explicit forecast is always for the parent's residual work, independent of children.
    if(isParent && residual===0 && task.remaining_forecast_minutes==null && own.logged_minutes===0 && !done(task)) {
      own={...own,remaining_minutes:0,unscheduled_minutes:0,remaining_basis:'estimate_minus_logged',remaining_state:'known'};
    }
    if(isParent && done(task) && childRows.some(child=>!done(tasks.get(child.id)!))) issues.push('completed_parent_has_open_work');
    if(issues.length) own={...own,remaining_minutes:null,unscheduled_minutes:null,remaining_basis:'unknown',remaining_state:'invalid'};
    const knownRemaining=(own.remaining_minutes??0)+childRows.reduce((sum,child)=>sum+child.known_remaining_minutes,0);
    const knownUnscheduled=(own.unscheduled_minutes??0)+childRows.reduce((sum,child)=>sum+child.known_unscheduled_minutes,0);
    const unknown=(own.remaining_minutes===null?1:0)+childRows.reduce((sum,child)=>sum+child.unknown_count,0);
    const logged=own.logged_minutes+childRows.reduce((sum,child)=>sum+child.logged_minutes,0);
    const sumReserved=(own.remaining_minutes==null?0:Math.min(own.remaining_minutes,own.reserved_minutes))+childRows.reduce((sum,child)=>sum+child.reserved_minutes,0);
    if([knownEstimate,knownRemaining,knownUnscheduled,logged,sumReserved].some(value=>!Number.isSafeInteger(value)||value>MAX_WORK_MINUTES)) issues.push('numeric_overflow');
    const broken=issues.includes('numeric_overflow')||invalid.has(id);
    if(broken) own={...own,remaining_minutes:null,unscheduled_minutes:null,remaining_basis:'unknown',remaining_state:'invalid'};
    return {id,parent_id:task.parent_task_id??null,child_ids:childIds,relation:task.time_rollup_mode==='inclusive'?'inclusive':'additive',
      estimated_minutes:broken?null:totalEstimate,known_estimated_minutes:broken?0:knownEstimate,residual_estimated_minutes:residual,own,
      remaining_minutes:unknown||issues.length?null:knownRemaining,known_remaining_minutes:broken?0:knownRemaining,unknown_count:Math.max(unknown,issues.length?1:0),
      logged_minutes:broken?own.logged_minutes:logged,logged_task_count:(own.logged_minutes>0?1:0)+childRows.reduce((sum,child)=>sum+child.logged_task_count,0),
      reserved_minutes:broken?0:sumReserved,unscheduled_minutes:unknown||issues.length?null:knownUnscheduled,known_unscheduled_minutes:broken?0:knownUnscheduled,
      leaf_count:isParent?childRows.reduce((sum,child)=>sum+child.leaf_count,0):1,
      completed_leaf_count:isParent?childRows.reduce((sum,child)=>sum+child.completed_leaf_count,0):done(task)?1:0,
      estimated_leaf_minutes:isParent?childRows.reduce((sum,child)=>sum+child.estimated_leaf_minutes,0):estimate??0,
      completed_leaf_minutes:isParent?childRows.reduce((sum,child)=>sum+child.completed_leaf_minutes,0):done(task)?estimate??0:0,
      issues:[...new Set(issues)], executable:!done(task)&&!issues.length&&(own.remaining_minutes===null||own.remaining_minutes>0)};
  };
  for(let head=0;head<queue.length;head++) {
    const id=queue[head]; if(summaries.has(id))continue;
    summaries.set(id,compute(id)); const parent=tasks.get(id)?.parent_task_id;
    if(parent&&pending.has(parent)&&!invalid.has(parent)){const left=pending.get(parent)!-1;pending.set(parent,left);if(left===0)queue.push(parent);}
  }
  const roots=[...new Set(rootOf.values())].sort();
  const rootRows=roots.map(id=>summaries.get(id)!).filter(Boolean);
  const total = {
    remaining_minutes:rootRows.some(row=>row.remaining_minutes===null)?null:rootRows.reduce((sum,row)=>sum+row.known_remaining_minutes,0),
    known_remaining_minutes:rootRows.reduce((sum,row)=>sum+row.known_remaining_minutes,0),
    unknown_count:rootRows.reduce((sum,row)=>sum+row.unknown_count,0),
    estimated_minutes:rootRows.some(row=>row.estimated_minutes===null)?null:rootRows.reduce((sum,row)=>sum+row.known_estimated_minutes,0),
    // Ledger ownership stays on its recorded task even if hierarchy metadata is malformed.
    logged_minutes:[...tasks.values()].reduce((sum,task)=>sum+accountWork(task).logged_minutes,0),
  };
  return {tasks,summaries,children,rootOf,roots,total};
}
