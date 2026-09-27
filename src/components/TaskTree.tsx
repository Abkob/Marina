import { useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CalendarCheck2, CalendarClock, ChevronRight, GripVertical, Search } from 'lucide-react';
import type { DBGoal, DBTask } from '../db/schema';
import { buildTaskForest, filterForest, type TaskTreeNode } from '../utils/taskTree';
import { useAppStore } from '../store/useAppStore';
import { getRolledUpActualTime, getRolledUpTime } from '../utils/taskTime';
import { getDescendantTaskDeadlineSummary, type DescendantTaskDeadlineSummary } from '../utils/taskDates';
import { taskContextMap } from '../utils/taskContext';

/**
 * The one way tasks are found: goals as collapsible sections, tasks nested
 * under their parents with expand/collapse, plus search. Two modes —
 * `drag` rows register as dnd-kit draggables (Schedule), `select` rows call
 * onSelect (Work). Pure presentation; the forest comes from utils/taskTree.
 */

interface TaskTreeProps {
  tasks: DBTask[];
  goals: DBGoal[];
  mode: 'drag' | 'select';
  selectedTaskId?: string | null;
  onSelect?: (task: DBTask) => void;
  /** drag mode: ids allowed to be dragged (leaf, schedulable). Others render muted. */
  draggableIds?: Set<string>;
  /** tasks already placed on a day — shown with a calendar mark + date */
  scheduledDates?: Map<string, string>;
  searchPlaceholder?: string;
  /** render tasks directly without goal section headers (drawer scoped to one goal) */
  hideGoalHeaders?: boolean;
  /** Work can opt in after pre-filtering to started critical-path items. */
  includeCriticalPath?: boolean;
}

function fmtMins(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${m ? ` ${m}m` : ''}`;
}

function RowBody({ task, context, depth, hasChildren, isOpen, onToggle, scheduledOn, muted, mutedReason, estimatedMinutes, loggedMinutes, childDeadlines }: {
  task: DBTask;
  context?: string;
  depth: number;
  hasChildren: boolean;
  isOpen: boolean;
  onToggle: () => void;
  scheduledOn?: string;
  muted: boolean;
  mutedReason?: string;
  estimatedMinutes: number | null;
  loggedMinutes: number;
  childDeadlines: DescendantTaskDeadlineSummary | null;
}) {
  return (
    <>
      <span style={{ width: Math.min(depth, 3) * 10 }} className="shrink-0" />
      {hasChildren ? (
        <button
          onClick={e => { e.stopPropagation(); onToggle(); }}
          onPointerDown={e => e.stopPropagation()}
          className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          title={isOpen ? 'Collapse subtasks' : 'Expand subtasks'}
          aria-label={`${isOpen ? 'Collapse' : 'Expand'} subtasks of ${task.title}`}
          aria-expanded={isOpen}
        >
          <ChevronRight size={11} className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
        </button>
      ) : (
        <span className="w-[15px] shrink-0" />
      )}
      <span
        className={`task-tree-title min-w-0 flex-1 text-[11px] ${muted ? 'text-gray-400' : 'text-gray-700'}`}
        title={mutedReason ?? task.title}
      >
        <span className="block truncate">{task.title}</span>
        {context && <span className="task-context block truncate text-[10px] font-normal text-slate-400" title={context}>{context}</span>}
      </span>
      {scheduledOn && (
        <span className="flex shrink-0 items-center gap-0.5 font-mono text-[8px] text-[#4648d4]" title={`On your calendar: ${scheduledOn}`}>
          <CalendarCheck2 size={9} />{scheduledOn.slice(5)}
        </span>
      )}
      {childDeadlines && !task.due_date && (
        <span
          className="flex shrink-0 items-center gap-0.5 font-mono text-[8px] text-red-500"
          title={`Earliest unfinished child deadline: ${childDeadlines.earliest}. Last known child deadline: ${childDeadlines.latest}.`}
        >
          <CalendarClock size={9} />child {childDeadlines.earliest.slice(5, 10)}
        </span>
      )}
      {estimatedMinutes ? (
        <span className="shrink-0 font-mono text-[9px] text-gray-400" title="Estimated time, including child-task estimate rules">{fmtMins(estimatedMinutes)} est</span>
      ) : !muted ? (
        <span className="shrink-0 font-mono text-[9px] text-amber-500" title="No time estimate yet — add one in its goal">?</span>
      ) : null}
      {loggedMinutes > 0 && (
        <span className="shrink-0 font-mono text-[9px] text-emerald-600" title="Logged time, including child tasks">{fmtMins(loggedMinutes)} log</span>
      )}
    </>
  );
}

function DraggableRow(props: Parameters<typeof RowBody>[0] & { draggable: boolean }) {
  const { navigateToGoal, setTaskSpotlight, triggerToast } = useAppStore();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: props.task.id,
    disabled: !props.draggable,
  });

  const openGoalFromAltClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (!props.task.goal_id) {
      triggerToast('This task is not attached to a goal yet.', 'info');
      return;
    }
    setTaskSpotlight(props.task.id);
    navigateToGoal(props.task.goal_id);
  };

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={openGoalFromAltClick}
      className={`flex w-full items-center gap-1 rounded px-1.5 py-1 select-none
        ${props.draggable ? 'cursor-grab hover:bg-indigo-50/60 active:cursor-grabbing' : 'cursor-default'}
        ${isDragging ? 'opacity-30' : ''}`}
    >
      {props.draggable
        ? <GripVertical size={9} className="shrink-0 text-gray-300" />
        : <span className="w-[9px] shrink-0" />}
      <RowBody {...props} />
    </div>
  );
}

function SelectableRow(props: Parameters<typeof RowBody>[0] & { selected: boolean; onSelect: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={props.onSelect}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onSelect();
        }
      }}
      className={`task-tree-select flex w-full items-center gap-1 rounded px-1.5 py-1 text-left
        ${props.selected ? 'bg-[#EEF2FF] ring-1 ring-[#4648d4]/30' : 'hover:bg-gray-50'}`}
    >
      <RowBody {...props} />
    </div>
  );
}

export function TaskTree({ tasks, goals, mode, selectedTaskId, onSelect, draggableIds, scheduledDates, searchPlaceholder, hideGoalHeaders = false, includeCriticalPath = false }: TaskTreeProps) {
  const [q, setQ] = useState('');
  const [openGoals, setOpenGoals] = useState<Set<string>>(new Set());
  const [closedNodes, setClosedNodes] = useState<Set<string>>(new Set());

  const forest = useMemo(
    () => buildTaskForest(tasks, goals, { includeCriticalPath }),
    [includeCriticalPath, tasks, goals],
  );
  const shown = useMemo(() => filterForest(forest, q), [forest, q]);
  const searching = q.trim().length > 0;
  const contexts = useMemo(() => taskContextMap(tasks, goals), [tasks, goals]);

  const toggleGoal = (key: string) =>
    setOpenGoals(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const toggleNode = (id: string) =>
    setClosedNodes(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const renderNode = (node: TaskTreeNode, depth: number): React.ReactNode => {
    const { task } = node;
    const hasChildren = node.children.length > 0;
    const isOpen = searching || !closedNodes.has(task.id);
    const draggable = mode === 'drag' && (draggableIds?.has(task.id) ?? false);
    const muted = mode === 'drag' && !draggable;
    const common = {
      task,
      context: task.parent_task_id ? contexts.get(task.id) : undefined,
      depth,
      hasChildren,
      isOpen,
      onToggle: () => toggleNode(task.id),
      scheduledOn: scheduledDates?.get(task.id),
      muted,
      mutedReason: muted
        ? (hasChildren ? `${task.title} — plan its subtasks instead` : `${task.title} — kept out of scheduling`)
        : undefined,
      estimatedMinutes: getRolledUpTime(task, tasks).minutes,
      loggedMinutes: getRolledUpActualTime(task, tasks).minutes,
      childDeadlines: hasChildren ? getDescendantTaskDeadlineSummary(task.id, tasks) : null,
    };
    return (
      <div key={task.id}>
        {mode === 'drag' ? (
          <DraggableRow {...common} draggable={draggable} />
        ) : (
          <SelectableRow {...common} selected={selectedTaskId === task.id} onSelect={() => onSelect?.(task)} />
        )}
        {hasChildren && isOpen && node.children.map(c => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-gray-200 px-2 py-1.5">
        <Search size={11} className="shrink-0 text-gray-300" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={searchPlaceholder ?? 'Search tasks…'}
          className="w-full bg-transparent text-xs outline-none placeholder:text-gray-300"
        />
      </div>
      {shown.length === 0 && (
        <p className="px-1 py-2 text-[11px] text-gray-400">
          {searching ? `Nothing matches "${q}".` : 'No open tasks.'}
        </p>
      )}
      <div className="space-y-1">
        {shown.map(group => {
          const key = group.goalId ?? '__none__';
          const isOpen = hideGoalHeaders || searching || openGoals.has(key);
          if (hideGoalHeaders) {
            return <div key={key}>{group.nodes.map(n => renderNode(n, 0))}</div>;
          }
          return (
            <div key={key}>
              <button
                onClick={() => toggleGoal(key)}
                className="flex w-full items-center gap-1 rounded px-1 py-1 text-left hover:bg-gray-50"
              >
                <ChevronRight size={11} className={`shrink-0 text-gray-400 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-gray-800">{group.goalTitle}</span>
                <span className="shrink-0 rounded-full bg-gray-100 px-1.5 font-mono text-[9px] text-gray-500">{group.taskCount}</span>
              </button>
              {isOpen && <div className="mt-0.5">{group.nodes.map(n => renderNode(n, 0))}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
