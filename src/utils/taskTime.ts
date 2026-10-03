import type { DBTask } from '../db/schema';
import { accountWork } from '../../shared/workAccounting';
import { buildWorkHierarchy } from '../../shared/workHierarchy';

const MAX_TASK_MINUTES = 60 * 1000;

export function normalizeTaskMinutes(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.min(MAX_TASK_MINUTES, Math.max(0, Math.round(value)));
}

export function parseTaskTimeInput(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  // (?![a-zA-Z]) prevents matching letters that are part of a longer word (e.g. "min" in "mining")
  // but allows unit letters immediately followed by digits (e.g. "1h30m")
  const unitMatches = [...normalized.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m)(?![a-zA-Z])/g)];
  if (unitMatches.length > 0) {
    const total = unitMatches.reduce((sum, match) => {
      const amount = Number(match[1]);
      const unit = match[2];
      if (Number.isNaN(amount)) return sum;
      return sum + (unit.startsWith('h') ? amount * 60 : amount);
    }, 0);
    return normalizeTaskMinutes(total);
  }

  const plainNumber = Number(normalized.replace(/[^\d.]/g, ''));
  if (Number.isNaN(plainNumber) || plainNumber <= 0) return null;

  // Plain small numbers usually mean hours; larger plain numbers usually mean minutes.
  return normalizeTaskMinutes(plainNumber <= 12 ? plainNumber * 60 : plainNumber);
}

export function formatTaskTime(minutes: number | null | undefined): string {
  const normalized = typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : null;
  if (normalized === null || normalized === 0) return 'Time';
  if (normalized < 60) return `${normalized}m`;

  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

export function formatTaskTimeLong(minutes: number): string {
  const normalized = Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : 0;
  if (normalized < 60) return `${normalized} min`;

  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  if (mins === 0) return `${hours} hr${hours === 1 ? '' : 's'}`;
  return `${hours} hr${hours === 1 ? '' : 's'} ${mins} min`;
}

export function getTaskEstimatedMinutes(task: DBTask): number | null {
  const explicit = normalizeTaskMinutes(task.estimated_minutes);
  if (explicit !== null && explicit > 0) return explicit;
  return parseTaskTimeInput(task.estimated_duration);
}

export interface RolledUpTime {
  /** Total minutes after child time inclusion rules are applied. */
  minutes: number | null;
  /** True when any children contributed to the total. */
  isRollup: boolean;
  /** Own explicit time on this task. */
  ownMinutes: number | null;
  /** Raw sum of direct children's totals (null when no children have times). */
  childrenSum: number | null;
  /** Direct child totals that are included inside this task's own estimate. */
  includedChildrenSum?: number | null;
  /** Direct child totals that add extra time on top of this task's own estimate. */
  extraChildrenSum?: number | null;
}

export interface RolledUpActualTime {
  minutes: number;
  ownMinutes: number;
  childrenMinutes: number;
  contributingChildren: number;
}

/** A single iterative hierarchy calculation underlies estimate, ledger and remaining displays. */
function hierarchyFor(task: DBTask, allTasks: DBTask[]) {
  const rows = allTasks.some(row => row.id === task.id) ? allTasks : [...allTasks, task];
  return buildWorkHierarchy(rows);
}
export function getRolledUpActualTime(task: DBTask, allTasks: DBTask[]): RolledUpActualTime {
  const row=hierarchyFor(task,allTasks).summaries.get(task.id)!;
  const ownMinutes=accountWork(task).logged_minutes;
  return {minutes:row.logged_minutes,ownMinutes,childrenMinutes:Math.max(0,row.logged_minutes-ownMinutes),
    contributingChildren:Math.max(0,row.logged_task_count-(ownMinutes>0?1:0))};
}
export function getTaskLeafProgress(task: DBTask, allTasks: DBTask[]): number {
  if(task.completed || task.status==='done')return 1;
  const row=hierarchyFor(task,allTasks).summaries.get(task.id)!;
  return row.issues.length || !row.leaf_count ? 0 : row.completed_leaf_count/row.leaf_count;
}
export interface TaskTimeProgress {
  /** Completion ratio of leaves; time spent is not a completion signal. */
  ratio: number;
  remainingMinutes: number | null;
  spentMinutes: number;
  isTimeWeighted: boolean;
}
export function getTaskTimeProgress(task: DBTask, allTasks: DBTask[]): TaskTimeProgress {
  const row=hierarchyFor(task,allTasks).summaries.get(task.id)!;
  const weighted=row.estimated_leaf_minutes>0;
  return {ratio:row.issues.length?0:task.completed||task.status==='done'?1:weighted?row.completed_leaf_minutes/row.estimated_leaf_minutes:row.leaf_count?row.completed_leaf_count/row.leaf_count:0,
    remainingMinutes:row.remaining_minutes,spentMinutes:row.logged_minutes,isTimeWeighted:weighted};
}
/** The child's mode controls whether its complete subtree is inside the parent's budget. */
export function getRolledUpTime(task: DBTask, allTasks: DBTask[]): RolledUpTime {
  const tree=hierarchyFor(task,allTasks);const row=tree.summaries.get(task.id)!;
  const ownMinutes=accountWork(task).estimated_minutes;
  if(!row.child_ids.length)return {minutes:row.estimated_minutes,isRollup:false,ownMinutes,childrenSum:null};
  const children=row.child_ids.map(id=>tree.summaries.get(id)!);
  const included=children.filter(child=>child.relation==='inclusive').reduce((sum,child)=>sum+child.known_estimated_minutes,0);
  const extra=children.filter(child=>child.relation==='additive').reduce((sum,child)=>sum+child.known_estimated_minutes,0);
  return {minutes:row.estimated_minutes,isRollup:true,ownMinutes,childrenSum:children.some(child=>child.estimated_minutes===null)?null:included+extra,
    includedChildrenSum:included||null,extraChildrenSum:extra||null};
}
