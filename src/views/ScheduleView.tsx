import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import {
  DndContext, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, DragOverlay, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import {
  Sparkles, Calendar, AlertTriangle, RefreshCw, ChevronLeft, ChevronRight, ChevronDown,
  GripVertical, Check, Eye, EyeOff, BarChart2, CalendarDays, PanelLeftOpen, PanelRightClose, Play, Plus, Repeat2,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import {
  useSchedulePreview, useAllTasks, useInvalidate, useEvents, useAllEventTaskLinks,
  useAllMeetings, useSchedulePrefs, useGoals,
  type ScheduleDay, type SchedulerResult, type ScheduleTaskInfo, type ScheduleDeadlineInfo, type DayAssignment, type DBEventTaskLinkFull,
} from '../api/hooks';
import { apiPost, apiPatch, apiDelete } from '../utils/apiFetch';
import type { DBEvent, DBGoal, DBTask } from '../db/schema';
import {
  addDays, calendarDateTime, clampHour, dateToWeekPos, eventDate, fmtTimeRange, fmtYMD,
  mondayOf, parseLocalDate, snapHour,
} from '../utils/calendar';
import { autofillFromTask } from '../utils/eventAutofill';
import { suggestionsFromPlan } from '../utils/planAssist';
import { OneOffTaskComposer, TaskTreeDrawer, type CalendarTaskDraft } from './schedule/TaskTreeDrawer';
import { PlanAssistPanel } from './schedule/PlanAssistPanel';
import { DayFlowRiver } from './schedule/DayFlowRiver';
import {
  WeekTimeGrid, GRID_START_HOUR, GRID_END_HOUR, scheduleHourPxForViewport,
  type CalendarMeeting, type DayCapacityBreakdown, type DayBreakdownItem, type PlacedEvent,
} from './schedule/WeekTimeGrid';
import { EventComposer, type ComposerSeed } from './schedule/EventComposer';
import { GanttView } from './GanttView';
import { FeasibilityReport } from './schedule/FeasibilityReport';
import { WorkloadHorizon } from './schedule/WorkloadHorizon';
import { ModalFrame } from '../components/ModalFrame';
import { readActiveWorkTimer, writeActiveWorkTimer } from '../utils/workTimer';
import { RoutinesPanel } from './routines/RoutinesPanel';
import { RoutineComposer } from './routines/RoutineComposer';
import type { DBRoutine } from '../types/routines';
import { useMediaQuery, MOBILE_LAYOUT_QUERY } from '../hooks/useMediaQuery';
import { MobileSchedule } from './schedule/MobileSchedule';
import type { CalendarPlacement } from '../utils/calendarGestures';

/**
 * Schedule workspace, Google-Calendar style: a week time-grid carrying
 * calendar blocks (linkable to tasks — names and durations autofill) and
 * meetings, an all-day row for day-level task scheduling (drag between days,
 * or from the backlog), and the planning insights — feasibility, capacity,
 * week load, attention — in plain language above the grid.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

interface DraftAssignment {
  task_id: string;
  title: string;
  start_date: string;
  current_start: string | null;
  days: string[];
}
interface Draft {
  id: string;
  name: string;
  description: string;
  stats: { status: string; gap_minutes: number; tasks_scheduled: number; changes: number; busiest_day_minutes: number; days_used: number };
  assignments: DraftAssignment[];
  day_assignments: DayAssignment[];
}

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  feasible:   { label: 'Feasible',   cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  tight:      { label: 'Tight',      cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  risky:      { label: 'Risky',      cls: 'bg-orange-50 text-orange-700 border-orange-200' },
  impossible: { label: 'Needs attention', cls: 'bg-red-50 text-red-700 border-red-200' },
};

function fmtMins(mins: number): string {
  if (Math.abs(mins) < 60) return `${mins}m`;
  const h = Math.floor(Math.abs(mins) / 60);
  const m = Math.abs(mins) % 60;
  return `${mins < 0 ? '-' : ''}${h}h${m ? ` ${m}m` : ''}`;
}

const DAY_FLOW_ORDER_STORAGE_KEY = 'marina.schedule.dayFlowOrder.v1';

function parseFlowTaskDragId(value: string): { date: string; taskId: string } | null {
  if (!value.startsWith('flow-task:')) return null;
  const [, date, ...taskParts] = value.split(':');
  const taskId = taskParts.join(':');
  return date && taskId ? { date, taskId } : null;
}

function mergeFlowOrder(stored: string[] | undefined, visible: string[]): string[] {
  const visibleSet = new Set(visible);
  const kept = (stored ?? []).filter(id => visibleSet.has(id));
  const known = new Set(kept);
  return [...kept, ...visible.filter(id => !known.has(id))];
}

function moveFlowId(ids: string[], activeId: string, overId: string): string[] {
  const oldIndex = ids.indexOf(activeId);
  const newIndex = ids.indexOf(overId);
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return ids;
  const next = [...ids];
  const [moved] = next.splice(oldIndex, 1);
  next.splice(newIndex, 0, moved);
  return next;
}

function schedulerStatusLabel(scheduler: SchedulerResult): string {
  if (scheduler.status === 'impossible') {
    const count = scheduler.tasks_overflow.length;
    return `${count} deadline${count === 1 ? '' : 's'} need attention`;
  }
  if (scheduler.status === 'feasible') return `Fits · ${fmtMins(Math.max(0, scheduler.gap_minutes))} open`;
  return `${STATUS_STYLE[scheduler.status]?.label ?? 'Plan'} · ${fmtMins(Math.abs(scheduler.gap_minutes))} ${scheduler.gap_minutes >= 0 ? 'open' : 'over'}`;
}

function dayLabel(dateStr: string): { dow: string; dom: string; isToday: boolean } {
  const d = parseLocalDate(dateStr);
  const today = new Date();
  return {
    dow: d.toLocaleDateString('en-US', { weekday: 'short' }),
    dom: String(d.getDate()),
    isToday: d.toDateString() === today.toDateString(),
  };
}

function fmtWeekRange(weekStart: string): string {
  const start = parseLocalDate(weekStart);
  const end = parseLocalDate(addDays(weekStart, 6));
  const sameMonth = start.getMonth() === end.getMonth();
  const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endLabel = end.toLocaleDateString('en-US', sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
  return `${startLabel} – ${endLabel}, ${end.getFullYear()}`;
}

// ── Draggable task chip ───────────────────────────────────────────────────────

type ScheduleChipTask = Pick<DBTask, 'id' | 'title' | 'estimated_minutes' | 'priority' | 'goal_id'>;
type FocusTaskRef = Pick<DBTask, 'id' | 'title'>;

function TaskChip({ task, ghost = false, onStartFocus }: { task: ScheduleChipTask; ghost?: boolean; onStartFocus?: (task: FocusTaskRef) => void }) {
  const { navigateToGoal, setTaskSpotlight, triggerToast } = useAppStore();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id, disabled: ghost });

  const openGoalFromAltClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!e.altKey || ghost) return;
    e.preventDefault();
    e.stopPropagation();
    if (!task.goal_id) {
      triggerToast('This task is not attached to a goal yet.', 'info');
      return;
    }
    setTaskSpotlight(task.id);
    navigateToGoal(task.goal_id);
  };
  return (
    <div
      ref={setNodeRef}
      onClick={openGoalFromAltClick}
      className={`flex h-5 items-center gap-1 rounded border px-1 text-[10px] leading-none select-none
        ${ghost
          ? 'bg-indigo-50/60 text-indigo-400 border-dashed border-indigo-300'
          : 'bg-[#EEF2FF] text-[#4648d4] border-[#c0c1ff]/40 hover:brightness-95'}
        ${isDragging ? 'opacity-30' : ''}`}
      title={ghost ? `${task.title} (draft preview)` : `${task.title} — drag to a day, onto a time slot, or back to the backlog`}
    >
      {!ghost && (
        <button
          type="button"
          {...listeners}
          {...attributes}
          onClick={event => event.stopPropagation()}
          className="cursor-grab rounded p-0.5 opacity-50 hover:bg-white/70 hover:opacity-100 active:cursor-grabbing"
          aria-label={`Drag ${task.title}`}
          title="Drag to another day or into the hourly grid"
        >
          <GripVertical size={9} />
        </button>
      )}
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      {task.estimated_minutes ? <span className="shrink-0 opacity-60">{fmtMins(task.estimated_minutes)}</span> : null}
      {!ghost && onStartFocus && (
        <button
          type="button"
          onPointerDown={event => event.stopPropagation()}
          onClick={event => { event.preventDefault(); event.stopPropagation(); onStartFocus(task); }}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[#4648d4]/55 hover:bg-white hover:text-[#4648d4]"
          aria-label={`Start focus timer for ${task.title}`}
          title="Start focus and record actual work time"
        >
          <Play size={9} fill="currentColor" />
        </button>
      )}
    </div>
  );
}

// ── All-day cell (day-level scheduling target) ────────────────────────────────

function AllDayCell({ date, day, startTasks, ghostIds, taskLookup, isBlocked }: {
  date: string;
  day: ScheduleDay | undefined;
  startTasks: DBTask[];
  ghostIds: string[];
  taskLookup: Record<string, ScheduleTaskInfo>;
  /** true when the task already has a calendar block on this date */
  isBlocked: (taskId: string) => boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${date}` });
  const [dueOpen, setDueOpen] = useState(false);
  const dueTasks = day?.tasks ?? [];
  const deadlines = day?.deadline_titles ?? [];
  const dueSummary = [
    dueTasks.length ? `${dueTasks.length} due` : null,
    deadlines.length ? `${deadlines.length} deadline${deadlines.length !== 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div
      ref={setNodeRef}
      className={`h-full max-h-36 overflow-y-auto px-1 py-1 transition-colors ${isOver ? 'bg-indigo-50/70' : ''}`}
    >
      {day?.override && (
        <p className="mb-0.5 truncate font-mono text-[8px] text-amber-600" title={day.override.note ?? undefined}>
          ⚠ {fmtMins(day.override.available_minutes)} available
        </p>
      )}
      {(dueTasks.length > 0 || deadlines.length > 0) && (
        <>
          <button
            onClick={() => setDueOpen(v => !v)}
            className="mb-1 flex w-full items-center gap-1 rounded border border-red-100 bg-red-50 px-1.5 py-0.5 text-left hover:bg-red-100/70"
            title={[...dueTasks.map(t => `⚑ ${t.title}`), ...deadlines.map(d => `◆ ${d}`)].join('\n')}
          >
            <span className="min-w-0 flex-1 truncate text-[9px] font-bold text-red-600">⚑ {dueSummary}</span>
            <ChevronDown size={9} className={`shrink-0 text-red-400 transition-transform ${dueOpen ? 'rotate-180' : ''}`} />
          </button>
          {dueOpen && (
            <div className="mb-1 space-y-0.5">
              {dueTasks.map(t => (
                <p
                  key={`due-${t.id}`}
                  className={`truncate pl-1.5 text-[9px] leading-tight ${isBlocked(t.id) ? 'text-gray-400' : 'text-red-600/90'}`}
                  title={isBlocked(t.id) ? `${t.title} — already has time blocked this day` : t.title}
                >
                  {isBlocked(t.id) ? '✓ ' : ''}{t.title}
                </p>
              ))}
              {deadlines.map(d => (
                <p key={d} className="truncate pl-1.5 text-[9px] leading-tight text-orange-600" title={`Goal deadline: ${d}`}>◆ {d}</p>
              ))}
            </div>
          )}
        </>
      )}
      {startTasks.map(t => <TaskChip key={t.id} task={t} />)}
      {ghostIds.map(id => (
        <TaskChip key={`ghost-${id}`} ghost task={{ id, title: taskLookup[id]?.title ?? id, estimated_minutes: taskLookup[id]?.estimated_minutes ?? null, priority: 'medium', goal_id: taskLookup[id]?.goal_id ?? null }} />
      ))}
    </div>
  );
}

// ── Drafts panel ──────────────────────────────────────────────────────────────

function ReadableAllDayCell({ date, day, startTasks, ghostIds, taskLookup, isBlocked }: {
  date: string;
  day: ScheduleDay | undefined;
  startTasks: DBTask[];
  ghostIds: string[];
  taskLookup: Record<string, ScheduleTaskInfo>;
  isBlocked: (taskId: string) => boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${date}` });
  const { navigateToGoal, setTaskSpotlight, setDeadlineSpotlight, triggerToast } = useAppStore();
  const [expanded, setExpanded] = useState(false);
  const dueTasks = day?.tasks ?? [];
  const deadlineRows: ScheduleDeadlineInfo[] = day?.deadlines?.length
    ? day.deadlines
    : (day?.deadline_titles ?? []).map((title, i) => ({
        id: `${date}-${i}-${title}`,
        title,
        date,
        goal_id: '',
        goal_title: null,
        color: '#ef4444',
      }));
  const shownDueTasks = expanded ? dueTasks : dueTasks.slice(0, 2);
  const shownDeadlines = expanded ? deadlineRows : deadlineRows.slice(0, 2);
  const shownStartTasks = expanded ? startTasks : startTasks.slice(0, 3);
  const hiddenCount = Math.max(0, dueTasks.length - shownDueTasks.length)
    + Math.max(0, deadlineRows.length - shownDeadlines.length)
    + Math.max(0, startTasks.length - shownStartTasks.length);

  const openTaskFromAltClick = (e: React.MouseEvent, task: { id: string; title: string; goal_id: string | null }) => {
    if (!e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (!task.goal_id) {
      triggerToast('This task is not attached to a goal yet.', 'info');
      return;
    }
    setTaskSpotlight(task.id);
    navigateToGoal(task.goal_id);
  };

  const openDeadlineFromAltClick = (e: React.MouseEvent, deadline: ScheduleDeadlineInfo) => {
    if (!e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (!deadline.goal_id) {
      triggerToast('This deadline is not attached to a goal yet.', 'info');
      return;
    }
    setDeadlineSpotlight(deadline.id);
    navigateToGoal(deadline.goal_id);
  };

  return (
    <div
      ref={setNodeRef}
      className={`h-full max-h-[260px] overflow-y-auto px-1.5 py-1.5 transition-colors ${isOver ? 'bg-indigo-50/70' : ''}`}
    >
      {day?.override && (
        <p className="mb-1 truncate font-mono text-[8px] text-amber-600" title={day.override.note ?? undefined}>
          {fmtMins(day.override.available_minutes)} available
        </p>
      )}

      {shownDeadlines.length > 0 && (
        <div className="mb-1 space-y-1">
          {shownDeadlines.map(deadline => (
            <button
              key={`deadline-${deadline.id}`}
              type="button"
              onClick={e => openDeadlineFromAltClick(e, deadline)}
              className="w-full rounded-md border px-1.5 py-1 text-left shadow-sm transition-colors hover:bg-red-100/70"
              style={{
                borderColor: `${deadline.color ?? '#ef4444'}66`,
                backgroundColor: `${deadline.color ?? '#ef4444'}12`,
              }}
              title={`${deadline.title}${deadline.goal_title ? ` - ${deadline.goal_title}` : ''}. Alt-click to open its goal.`}
            >
              <span className="mb-0.5 flex items-center gap-1 font-mono text-[8px] font-bold uppercase tracking-wide text-red-600">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: deadline.color ?? '#ef4444' }} />
                Deadline
              </span>
              <span className="block whitespace-normal break-words text-[10px] font-semibold leading-tight text-red-700">
                {deadline.title}
              </span>
              {deadline.goal_title && (
                <span className="mt-0.5 block truncate text-[8px] text-red-500/70">{deadline.goal_title}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {dueTasks.length > 0 && (
        <div className="mb-1 rounded-md border border-red-100 bg-red-50/70 px-1 py-1">
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="mb-0.5 flex w-full items-center gap-1 text-left"
            title={dueTasks.map(t => t.title).join('\n')}
          >
            <span className="min-w-0 flex-1 font-mono text-[8px] font-bold uppercase tracking-wide text-red-600">
              {dueTasks.length} due task{dueTasks.length !== 1 ? 's' : ''}
            </span>
            <ChevronDown size={9} className={`shrink-0 text-red-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
          <div className="space-y-0.5">
            {shownDueTasks.map(t => (
              <button
                key={`due-${t.id}`}
                type="button"
                onClick={e => openTaskFromAltClick(e, t)}
                className={`block w-full rounded px-1 py-0.5 text-left text-[9px] leading-tight transition-colors hover:bg-white/70 ${
                  isBlocked(t.id) ? 'text-gray-400 line-through' : 'text-red-700'
                }`}
                title={isBlocked(t.id) ? `${t.title} - already has time blocked this day. Alt-click to open its goal.` : `${t.title}. Alt-click to open its goal.`}
              >
                <span className="whitespace-normal break-words">{t.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-1">
        {shownStartTasks.map(t => <TaskChip key={t.id} task={t} />)}
        {ghostIds.map(id => (
          <TaskChip
            key={`ghost-${id}`}
            ghost
            task={{
              id,
              title: taskLookup[id]?.title ?? id,
              estimated_minutes: taskLookup[id]?.estimated_minutes ?? null,
              priority: 'medium',
              goal_id: taskLookup[id]?.goal_id ?? null,
            }}
          />
        ))}
      </div>

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 w-full rounded border border-gray-100 bg-white px-1 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wide text-gray-400 hover:border-gray-200 hover:text-gray-600"
        >
          Show {hiddenCount} more
        </button>
      )}
    </div>
  );
}

type ScheduleTaskTreeItem = Pick<DBTask, 'id' | 'title' | 'goal_id' | 'parent_task_id' | 'estimated_minutes'> & {
  status?: string;
  completed?: boolean;
  position?: number;
};

function MiniScheduleTaskTree({ tasks, allTasks, tone, isBlocked, onOpenTask, onStartFocus }: {
  tasks: ScheduleTaskTreeItem[];
  allTasks: DBTask[];
  tone: 'due' | 'planned';
  isBlocked?: (taskId: string) => boolean;
  onOpenTask: (task: { id: string; title: string; goal_id: string | null }) => void;
  onStartFocus?: (task: FocusTaskRef) => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const targetIds = useMemo(() => new Set(tasks.map(t => t.id)), [tasks]);
  const allById = useMemo(() => new Map(allTasks.map(t => [t.id, t])), [allTasks]);
  const nodes = useMemo(() => {
    const included = new Map<string, ScheduleTaskTreeItem>();
    for (const raw of tasks) {
      const full = allById.get(raw.id);
      const task = full ?? raw;
      included.set(task.id, task);
      let parentId = task.parent_task_id;
      const seen = new Set<string>([task.id]);
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = allById.get(parentId);
        if (!parent) break;
        included.set(parent.id, parent);
        parentId = parent.parent_task_id;
      }
    }
    return included;
  }, [allById, tasks]);

  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, ScheduleTaskTreeItem[]>();
    for (const task of nodes.values()) {
      const parentId = task.parent_task_id && nodes.has(task.parent_task_id) ? task.parent_task_id : null;
      if (!map.has(parentId)) map.set(parentId, []);
      map.get(parentId)!.push(task);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        const ap = allById.get(a.id)?.position ?? a.position ?? 0;
        const bp = allById.get(b.id)?.position ?? b.position ?? 0;
        if (ap !== bp) return ap - bp;
        return a.title.localeCompare(b.title);
      });
    }
    return map;
  }, [allById, nodes]);

  const toggle = (id: string) => {
    setClosed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderNode = (task: ScheduleTaskTreeItem, depth: number): React.ReactNode => {
    const children = childrenByParent.get(task.id) ?? [];
    const direct = targetIds.has(task.id);
    const collapsed = closed.has(task.id);
    const blocked = isBlocked?.(task.id) ?? false;
    const targetCls = tone === 'due'
      ? blocked ? 'border-gray-100 bg-gray-50 text-gray-400 line-through' : 'border-red-100 bg-red-50 text-red-700'
      : 'border-indigo-100 bg-[#EEF2FF] text-[#33359c]';
    const contextCls = 'border-amber-100 bg-amber-50 text-amber-800';
    const label = direct ? (tone === 'due' ? 'due' : 'planned') : 'parent';

    return (
      <div key={task.id} className="space-y-1">
        <div
          className={`flex items-start gap-1 rounded-md border px-1.5 py-1 text-left ${direct ? targetCls : contextCls}`}
          style={{ marginLeft: depth * 12 }}
        >
          {children.length > 0 ? (
            <button
              type="button"
              onClick={() => toggle(task.id)}
              className="mt-0.5 shrink-0 rounded p-0.5 opacity-60 hover:bg-white/70 hover:opacity-100"
              title={collapsed ? 'Expand children' : 'Collapse children'}
            >
              <ChevronRight size={10} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
            </button>
          ) : (
            <span className="mt-0.5 w-[15px] shrink-0" />
          )}
          <button
            type="button"
            onClick={e => {
              if (e.altKey) {
                e.preventDefault();
                onOpenTask(task);
              }
            }}
            className="min-w-0 flex-1 text-left"
            title={`${task.title}. Alt-click to open its goal.`}
          >
            <span className="block whitespace-normal break-words text-[11px] font-medium leading-tight">{task.title}</span>
          </button>
          <span className={`mt-0.5 shrink-0 rounded px-1 py-px font-mono text-[8px] font-bold uppercase ${
            direct
              ? tone === 'due' ? 'bg-white/70 text-red-500' : 'bg-white/70 text-[#4648d4]'
              : 'bg-white/70 text-amber-600'
          }`}>
            {label}
          </span>
          {direct && onStartFocus && (
            <button
              type="button"
              onClick={() => onStartFocus(task)}
              className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[#4648d4]/55 hover:bg-white hover:text-[#4648d4]"
              aria-label={`Start focus timer for ${task.title}`}
              title="Start focus and record actual work time"
            >
              <Play size={9} fill="currentColor" />
            </button>
          )}
          {direct && task.estimated_minutes ? (
            <span className="mt-0.5 shrink-0 font-mono text-[8px] opacity-60">{fmtMins(task.estimated_minutes)}</span>
          ) : null}
        </div>
        {children.length > 0 && !collapsed && (
          <div className="space-y-1">
            {children.map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const roots = childrenByParent.get(null) ?? [];
  return (
    <div className="space-y-1">
      {roots.map(root => renderNode(root, 0))}
    </div>
  );
}

function CompactAllDayCell({ date, day, startTasks, ghostIds, taskLookup, allTasks, isBlocked, onAddTask, onStartFocus }: {
  date: string;
  day: ScheduleDay | undefined;
  startTasks: DBTask[];
  ghostIds: string[];
  taskLookup: Record<string, ScheduleTaskInfo>;
  allTasks: DBTask[];
  isBlocked: (taskId: string) => boolean;
  onAddTask: (date: string) => void;
  onStartFocus: (task: FocusTaskRef) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${date}` });
  const { navigateToGoal, setTaskSpotlight, setDeadlineSpotlight, triggerToast } = useAppStore();
  const [open, setOpen] = useState(false);
  const dueTasks = day?.tasks ?? [];
  const deadlineRows: ScheduleDeadlineInfo[] = day?.deadlines?.length
    ? day.deadlines
    : (day?.deadline_titles ?? []).map((title, i) => ({
        id: `${date}-${i}-${title}`,
        title,
        date,
        goal_id: '',
        goal_title: null,
        color: '#ef4444',
      }));

  const summaryRows = (deadlineRows.length ? 1 : 0) + (dueTasks.length ? 1 : 0);
  const visibleTaskCount = Math.max(0, 3 - summaryRows);
  const shownStartTasks = startTasks.slice(0, visibleTaskCount);
  const hiddenCount = Math.max(0, deadlineRows.length - 1)
    + Math.max(0, dueTasks.length - 2)
    + Math.max(0, startTasks.length - shownStartTasks.length)
    + ghostIds.length;

  const openTask = (task: { id: string; title: string; goal_id: string | null }) => {
    if (!task.goal_id) {
      triggerToast('This task is not attached to a goal yet.', 'info');
      return;
    }
    setTaskSpotlight(task.id);
    navigateToGoal(task.goal_id);
  };

  const openDeadline = (deadline: ScheduleDeadlineInfo) => {
    if (!deadline.goal_id) {
      triggerToast('This deadline is not attached to a goal yet.', 'info');
      return;
    }
    setDeadlineSpotlight(deadline.id);
    navigateToGoal(deadline.goal_id);
  };

  const onAltTask = (e: React.MouseEvent, task: { id: string; title: string; goal_id: string | null }) => {
    if (!e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    openTask(task);
  };

  const onAltDeadline = (e: React.MouseEvent, deadline: ScheduleDeadlineInfo) => {
    if (!e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    openDeadline(deadline);
  };

  const firstDeadline = deadlineRows[0];
  const duePreview = dueTasks.slice(0, 2).map(t => t.title).join(', ');
  const hasContent = deadlineRows.length > 0 || dueTasks.length > 0 || startTasks.length > 0 || ghostIds.length > 0 || day?.override;

  return (
    <div
      ref={setNodeRef}
      className={`group/day relative h-full overflow-visible px-1 py-1 transition-colors ${isOver ? 'bg-indigo-50/70' : ''}`}
    >
      <button
        type="button"
        onClick={event => { event.stopPropagation(); onAddTask(date); }}
        className="absolute right-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-md border border-indigo-100 bg-white text-indigo-300 opacity-100 shadow-sm transition-all hover:border-indigo-300 hover:text-[#4648d4] focus:opacity-100 sm:opacity-0 sm:group-hover/day:opacity-100"
        aria-label={`Add all-day task on ${date}`}
        title="Add an all-day task"
      >
        <Plus size={11} />
      </button>
      <div className="flex h-full min-h-0 flex-col gap-1 overflow-hidden pr-6">
        {day?.override && (
          <p className="h-4 truncate font-mono text-[8px] leading-4 text-amber-600" title={day.override.note ?? undefined}>
            {fmtMins(day.override.available_minutes)} free
          </p>
        )}

        {firstDeadline && (
          <button
            type="button"
            onClick={e => e.altKey ? onAltDeadline(e, firstDeadline) : setOpen(v => !v)}
            className="flex h-5 w-full items-center gap-1 rounded border border-red-100 bg-red-50 px-1.5 text-left text-[9px] text-red-700 hover:bg-red-100/70"
            title={`${firstDeadline.title}${firstDeadline.goal_title ? ` - ${firstDeadline.goal_title}` : ''}. Alt-click to open its goal.`}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: firstDeadline.color ?? '#ef4444' }} />
            <span className="shrink-0 font-mono font-bold uppercase">Due</span>
            <span className="min-w-0 flex-1 truncate font-semibold">{firstDeadline.title}</span>
          </button>
        )}

        {dueTasks.length > 0 && (
          <button
            type="button"
            onClick={e => {
              if (e.altKey && dueTasks.length === 1) onAltTask(e, dueTasks[0]);
              else setOpen(v => !v);
            }}
            className="flex h-5 w-full items-center gap-1 rounded border border-red-100 bg-red-50/70 px-1.5 text-left text-[9px] text-red-700 hover:bg-red-100/70"
            title={`${dueTasks.map(t => t.title).join('\n')}${dueTasks.length === 1 ? '\nAlt-click to open its goal.' : ''}`}
          >
            <span className="shrink-0 font-mono font-bold uppercase">{dueTasks.length} due</span>
            <span className="min-w-0 flex-1 truncate">{duePreview}</span>
          </button>
        )}

        {shownStartTasks.map(t => <TaskChip key={t.id} task={t} onStartFocus={onStartFocus} />)}

        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            className="h-5 rounded border border-gray-100 bg-white px-1.5 font-mono text-[8px] font-bold uppercase tracking-wide text-gray-400 hover:border-gray-200 hover:text-gray-600"
          >
            +{hiddenCount} more
          </button>
        )}

        {!hasContent && (
          <button
            type="button"
            onClick={() => onAddTask(date)}
            className="flex h-6 w-full items-center justify-center gap-1 rounded-md border border-dashed border-indigo-100 text-[9px] font-semibold text-indigo-300 hover:border-indigo-300 hover:bg-indigo-50/50 hover:text-[#4648d4]"
          >
            <Plus size={10} /> task
          </button>
        )}
      </div>

      {open && (
        <div
          className="absolute left-1 top-[calc(100%-2px)] z-50 w-72 rounded-lg border border-gray-200 bg-white p-2 text-left shadow-xl"
          onClick={e => e.stopPropagation()}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="font-mono text-[9px] font-bold uppercase tracking-wide text-gray-400">
              {parseLocalDate(date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-1 font-mono text-[9px] text-gray-300 hover:bg-gray-50 hover:text-gray-500"
            >
              Close
            </button>
          </div>

          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {deadlineRows.length > 0 && (
              <div>
                <p className="mb-1 font-mono text-[8px] font-bold uppercase tracking-wide text-red-400">Deadlines</p>
                <div className="space-y-1">
                  {deadlineRows.map(deadline => (
                    <button
                      key={deadline.id}
                      type="button"
                      onClick={e => onAltDeadline(e, deadline)}
                      className="w-full rounded-md border border-red-100 bg-red-50 px-2 py-1.5 text-left hover:bg-red-100/70"
                      title="Alt-click to open its goal"
                    >
                      <span className="block whitespace-normal break-words text-[11px] font-semibold leading-tight text-red-700">{deadline.title}</span>
                      {deadline.goal_title && <span className="mt-0.5 block truncate text-[9px] text-red-500/70">{deadline.goal_title}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {dueTasks.length > 0 && (
              <div>
                <p className="mb-1 font-mono text-[8px] font-bold uppercase tracking-wide text-red-400">Due tasks</p>
                <MiniScheduleTaskTree
                  tasks={dueTasks}
                  allTasks={allTasks}
                  tone="due"
                  isBlocked={isBlocked}
                  onOpenTask={openTask}
                  onStartFocus={onStartFocus}
                />
              </div>
            )}

            {(startTasks.length > 0 || ghostIds.length > 0) && (
              <div>
                <p className="mb-1 font-mono text-[8px] font-bold uppercase tracking-wide text-[#4648d4]/70">Planned on day</p>
                <div className="space-y-1">
                  {startTasks.length > 0 && (
                    <MiniScheduleTaskTree
                      tasks={startTasks}
                      allTasks={allTasks}
                      tone="planned"
                      onOpenTask={openTask}
                      onStartFocus={onStartFocus}
                    />
                  )}
                  {ghostIds.map(id => (
                    <div key={id} className="rounded-md border border-dashed border-indigo-200 bg-indigo-50/60 px-2 py-1.5 text-[11px] text-indigo-400">
                      <span className="block whitespace-normal break-words leading-tight">{taskLookup[id]?.title ?? id}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DraftsPanel({ preview, onPreview, onApplied, onCollapse }: {
  preview: Draft | null;
  onPreview: (d: Draft | null) => void;
  onApplied: () => void;
  onCollapse?: () => void;
}) {
  const { triggerToast } = useAppStore();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);

  const generate = useMutation({
    mutationFn: () => apiPost<{ drafts: Draft[] }>('/api/ai/schedule/drafts', { horizon_days: 14 }),
    onSuccess: r => {
      setDrafts(r.drafts);
      onPreview(null);
      if (r.drafts.every(d => d.assignments.length === 0)) {
        triggerToast('No schedulable changes — tasks may need estimates, or already match every plan.', 'info');
      }
    },
    onError: (e: Error) => triggerToast(e.message, 'error'),
  });

  const apply = useMutation({
    mutationFn: (d: Draft) => apiPost<{ updated: number }>('/api/ai/schedule/drafts/apply', {
      assignments: d.assignments.map(a => ({ task_id: a.task_id, start_date: a.start_date })),
    }),
    onSuccess: (r, d) => {
      triggerToast(`"${d.name}" applied — ${r.updated} task${r.updated !== 1 ? 's' : ''} scheduled.`, 'success');
      setDrafts(null);
      onPreview(null);
      onApplied();
    },
    onError: (e: Error) => triggerToast(e.message, 'error'),
  });

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3">
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="text-[11px] font-bold text-gray-700 flex items-center gap-1.5">
          <Sparkles size={12} className="text-[#4648d4]" /> AI drafts
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            className="text-[10px] font-mono uppercase text-[#4648d4] hover:underline disabled:opacity-40 flex items-center gap-1"
          >
            {generate.isPending ? <RefreshCw size={10} className="animate-spin" /> : null}
            {drafts ? 'Regenerate' : 'Generate 3 plans'}
          </button>
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-600"
              title="Collapse AI drafts"
              aria-label="Collapse AI drafts"
            >
              <PanelRightClose size={13} />
            </button>
          )}
        </div>
      </div>
      <p className="text-[10px] text-gray-400 mb-2">
        Three ways to lay out the same work. Preview paints it on the days; nothing changes until you use one.
      </p>
      {!drafts && !generate.isPending && (
        <p className="text-[10px] text-gray-300 font-mono">no drafts yet</p>
      )}
      <div className="space-y-2">
        {(drafts ?? []).map(d => {
          const isPreviewing = preview?.id === d.id;
          const s = STATUS_STYLE[d.stats.status] ?? STATUS_STYLE.feasible;
          return (
            <div key={d.id} className={`border rounded-lg p-2.5 ${isPreviewing ? 'border-indigo-400 ring-1 ring-indigo-300/50 bg-indigo-50/40' : 'border-gray-150'}`}>
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-bold text-gray-800">{d.name}</span>
                <span className={`text-[8px] font-mono uppercase px-1.5 py-0.5 rounded-full border ${s.cls}`}>{s.label}</span>
              </div>
              <p className="text-[10px] text-gray-500 mt-0.5 leading-snug">{d.description}</p>
              <p className="text-[9px] font-mono text-gray-400 mt-1">
                {d.stats.changes} change{d.stats.changes !== 1 ? 's' : ''} · busiest day {fmtMins(d.stats.busiest_day_minutes)} · {d.stats.days_used} day{d.stats.days_used !== 1 ? 's' : ''}
              </p>
              <div className="flex gap-2 mt-1.5">
                <button
                  onClick={() => onPreview(isPreviewing ? null : d)}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold border ${isPreviewing ? 'bg-indigo-100 text-indigo-700 border-indigo-300' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                >
                  {isPreviewing ? <EyeOff size={10} /> : <Eye size={10} />}
                  {isPreviewing ? 'Hide preview' : 'Preview'}
                </button>
                <button
                  onClick={() => apply.mutate(d)}
                  disabled={apply.isPending || d.assignments.length === 0}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold bg-[#4648d4] text-white hover:opacity-90 disabled:opacity-40"
                >
                  <Check size={10} /> Use this plan
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Insights ──────────────────────────────────────────────────────────────────

function safePct(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function ScheduleInsights({ scheduler, weekDays, assignmentsByDate, startsByDate, backlog, unestimated, rollups }: {
  scheduler?: SchedulerResult;
  weekDays: string[];
  assignmentsByDate: Map<string, DayAssignment>;
  startsByDate: Map<string, DBTask[]>;
  backlog: DBTask[];
  unestimated: DBTask[];
  rollups: DBTask[];
}) {
  const [showDetail, setShowDetail] = useState(false);
  const utilisation = scheduler ? safePct(scheduler.total_required_minutes, scheduler.total_available_minutes) : 0;
  const weekStats = weekDays.map(date => {
    const assignment = assignmentsByDate.get(date);
    const manualMinutes = (startsByDate.get(date) ?? []).reduce((sum, task) => sum + (task.estimated_minutes ?? 0), 0);
    const used = Math.max(manualMinutes, assignment?.used_minutes ?? 0);
    const available = assignment?.available_minutes ?? null;
    return { date, used, available };
  });
  const weekUsed = weekStats.reduce((sum, d) => sum + d.used, 0);
  const busiest = weekStats.reduce((max, d) => (d.used > max.used ? d : max), weekStats[0] ?? { date: '', used: 0, available: null });
  const busiestLabel = busiest.date ? dayLabel(busiest.date).dow : '—';
  const overflowCount = scheduler?.tasks_overflow.length ?? 0;
  const recoveryDiagnostics = scheduler?.task_diagnostics.filter(item => (item.recovery_allocated_minutes ?? 0) > 0) ?? [];
  const recoveryMinutes = recoveryDiagnostics.reduce((sum, item) => sum + (item.recovery_allocated_minutes ?? 0), 0);
  const tone = !scheduler ? 'neutral' : scheduler.status === 'feasible' ? 'good' : scheduler.status === 'impossible' ? 'risk' : 'watch';
  const gap = scheduler?.gap_minutes ?? 0;

  const attention = [
    overflowCount > 0 ? `${overflowCount} task${overflowCount !== 1 ? 's' : ''} won't fit before their deadlines — move dates or trim estimates` : null,
    recoveryMinutes > 0 ? `${fmtMins(recoveryMinutes)} of best-effort recovery work is still included for ${recoveryDiagnostics.length} missed or oversized task${recoveryDiagnostics.length !== 1 ? 's' : ''}` : null,
    unestimated.length > 0 ? `${unestimated.length} task${unestimated.length !== 1 ? 's' : ''} need a time estimate before they can be planned` : null,
    backlog.length > 0 ? `${backlog.length} ready task${backlog.length !== 1 ? 's aren’t' : ' isn’t'} on a day yet — drag them in from the backlog` : null,
    rollups.length > 0 ? `${rollups.length} parent or long-term task${rollups.length !== 1 ? 's' : ''} stay out of auto-planning (their subtasks are planned instead)` : null,
  ].filter((item): item is string => Boolean(item));

  const dotCls =
    tone === 'good' ? 'bg-emerald-500' :
    tone === 'risk' ? 'bg-red-500' :
    tone === 'watch' ? 'bg-amber-500' : 'bg-gray-300';
  const headline =
    !scheduler ? 'Checking your plan…'
    : scheduler.status === 'impossible' && overflowCount > 0
      ? `Deadlines do not fit — ${overflowCount} task${overflowCount !== 1 ? 's' : ''} overflow${gap > 0 ? ` despite ${fmtMins(gap)} spare overall` : ''}`
      : gap >= 0 ? `This plan fits — ${fmtMins(gap)} to spare`
    : `Too much work — over by ${fmtMins(-gap)}`;

  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-[11px] text-gray-500">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dotCls}`} />
        <span className={`font-semibold ${tone === 'risk' ? 'text-red-700' : tone === 'watch' ? 'text-amber-700' : 'text-gray-800'}`}>
          {headline}
        </span>
        {scheduler && <span className="text-gray-300">·</span>}
        {scheduler && <span>{utilisation}% of your free time is booked</span>}
        <span className="text-gray-300">·</span>
        <span>{weekUsed > 0 ? `${fmtMins(weekUsed)} planned this week (${busiestLabel} fullest)` : 'nothing planned on these days yet'}</span>
        <span className="text-gray-300">·</span>
        <span>{backlog.length} task{backlog.length !== 1 ? 's' : ''} waiting for a day</span>
        {unestimated.length > 0 && (
          <>
            <span className="text-gray-300">·</span>
            <span className="text-amber-600">{unestimated.length} need estimates</span>
          </>
        )}
        <button
          onClick={() => setShowDetail(v => !v)}
          className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-widest text-gray-400 hover:text-gray-600"
        >
          <ChevronDown size={11} className={`transition-transform ${showDetail ? '' : '-rotate-90'}`} />
          Details
        </button>
      </div>

      {showDetail && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
          <div className="rounded-xl border border-gray-200 bg-white p-3 lg:col-span-8">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Week Load</p>
              <p className="text-[9px] font-mono text-gray-400">how full each day is</p>
            </div>
            <div className="grid grid-cols-7 gap-1.5">
              {weekStats.map(({ date, used, available }) => {
                const fill = available ? safePct(used, available) : used > 0 ? 100 : 0;
                const overloaded = available !== null && used > available;
                const lbl = dayLabel(date);
                return (
                  <div key={date} className="min-w-0">
                    <div className="mb-1 flex items-center justify-between gap-1">
                      <span className={`text-[9px] font-mono ${lbl.isToday ? 'font-bold text-[#4648d4]' : 'text-gray-400'}`}>{lbl.dow}</span>
                      <span className="text-[8px] text-gray-400">{fmtMins(used)}</span>
                    </div>
                    <div className="flex h-14 items-end overflow-hidden rounded-md bg-gray-100">
                      <div
                        className={`mt-auto w-full transition-all ${overloaded ? 'bg-red-400' : fill > 85 ? 'bg-amber-400' : 'bg-[#4648d4]'}`}
                        style={{ height: `${Math.max(4, fill)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-3 lg:col-span-4">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-gray-500">Attention</p>
            {attention.length === 0 ? (
              <p className="text-xs text-emerald-600">No schedule blockers in view.</p>
            ) : (
              <div className="space-y-1.5">
                {attention.slice(0, 5).map(item => (
                  <div key={item} className="flex gap-2 rounded-lg bg-gray-50 px-2.5 py-2 text-[11px] text-gray-700">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-500" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

function rootPlanningTask(task: DBTask, byId: Map<string, DBTask>): DBTask {
  let current = task;
  const seen = new Set<string>();
  while (current.parent_task_id && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parent_task_id);
    if (!parent) break;
    current = parent;
  }
  return current;
}

interface WeeklyParentRow {
  id: string;
  title: string;
  subtitle: string;
  totalMinutes: number;
  byDate: Record<string, number>;
  tone: 'task' | 'meeting' | 'block';
}

function WeeklyParentBreakdown({ weekDays, tasks, goals, placedEvents, linksByEvent, startsByDate, blockDates, meetings }: {
  weekDays: string[];
  tasks: DBTask[];
  goals: DBGoal[];
  placedEvents: PlacedEvent[];
  linksByEvent: Map<string, DBEventTaskLinkFull[]>;
  startsByDate: Map<string, DBTask[]>;
  blockDates: Set<string>;
  meetings: CalendarMeeting[];
}) {
  const [open, setOpen] = useState(false);
  const taskById = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  const goalById = useMemo(() => new Map(goals.map(g => [g.id, g])), [goals]);
  const rows = useMemo(() => {
    const map = new Map<string, WeeklyParentRow>();
    const ensure = (id: string, title: string, subtitle: string, tone: WeeklyParentRow['tone']) => {
      if (!map.has(id)) map.set(id, { id, title, subtitle, totalMinutes: 0, byDate: {}, tone });
      return map.get(id)!;
    };
    const add = (date: string, minutes: number, task: DBTask | null, fallback: { id: string; title: string; subtitle: string; tone: WeeklyParentRow['tone'] }) => {
      if (minutes <= 0) return;
      const root = task ? rootPlanningTask(task, taskById) : null;
      const goal = root?.goal_id ? goalById.get(root.goal_id) : null;
      const row = root
        ? ensure(`task:${root.id}`, root.title, goal?.title ?? 'No goal', 'task')
        : ensure(fallback.id, fallback.title, fallback.subtitle, fallback.tone);
      row.totalMinutes += minutes;
      row.byDate[date] = (row.byDate[date] ?? 0) + minutes;
    };

    for (const date of weekDays) {
      for (const task of startsByDate.get(date) ?? []) {
        if (blockDates.has(`${task.id}|${date}`)) continue;
        add(date, task.estimated_minutes ?? 0, task, { id: 'tasks:unlinked', title: 'Day-level tasks', subtitle: 'Manual placements', tone: 'task' });
      }
    }

    for (const placed of placedEvents) {
      const links = linksByEvent.get(placed.event.id) ?? [];
      const minutes = Math.round(placed.event.duration_hours * 60);
      const taskLinks = links.filter(l => l.task_id);
      if (!taskLinks.length) {
        add(placed.date, minutes, null, { id: 'calendar:blocks', title: 'Unlinked calendar blocks', subtitle: 'Timed focus/admin blocks', tone: 'block' });
        continue;
      }
      const fallbackMinutes = Math.round(minutes / taskLinks.length);
      for (const link of taskLinks) {
        const task = taskById.get(link.task_id);
        add(placed.date, Number(link.planned_minutes ?? 0) || fallbackMinutes, task ?? null, {
          id: 'calendar:linked-missing',
          title: 'Linked blocks',
          subtitle: 'Task not loaded',
          tone: 'block',
        });
      }
    }

    for (const meeting of meetings) {
      add(meeting.date, Math.round(meeting.durationHours * 60), null, { id: 'calendar:meetings', title: 'Meetings', subtitle: 'Fixed commitments', tone: 'meeting' });
    }

    return [...map.values()]
      .filter(row => row.totalMinutes > 0)
      .sort((a, b) => b.totalMinutes - a.totalMinutes || a.title.localeCompare(b.title));
  }, [weekDays, startsByDate, blockDates, placedEvents, linksByEvent, meetings, taskById, goalById]);

  const max = Math.max(1, ...rows.map(row => row.totalMinutes));
  const weeklyTotal = rows.reduce((sum, row) => sum + row.totalMinutes, 0);
  const weekDayLabels = weekDays.map(date => dayLabel(date).dow.slice(0, 3).toUpperCase());

  return (
    <section className="mt-2 overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className={`flex flex-wrap items-center gap-2 px-3 py-2 ${open ? 'border-b border-gray-100' : ''}`}>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-bold text-gray-800">Weekly hour breakdown</p>
          <p className="text-[10px] text-gray-400">Scheduled work is rolled up by origin parent task; one-off blocks and meetings stay separate.</p>
        </div>
        <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-[9px] font-bold uppercase text-gray-500">
          {fmtMins(weeklyTotal)} planned
        </span>
        <button
          type="button"
          onClick={() => setOpen(value => !value)}
          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          title={open ? 'Collapse weekly breakdown' : 'Expand weekly breakdown'}
          aria-label={open ? 'Collapse weekly breakdown' : 'Expand weekly breakdown'}
          aria-expanded={open}
        >
          <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open && (rows.length === 0 ? (
        <p className="m-3 rounded-lg border border-dashed border-gray-100 px-2 py-3 text-center text-[11px] text-gray-300">No planned hours on this week yet.</p>
      ) : (
        <>
          <div className="mb-1 flex items-center gap-2 px-5 pt-3">
            <span className="min-w-0 flex-1 text-[8px] font-bold uppercase tracking-[0.14em] text-gray-300">Parent task</span>
            <div className="flex shrink-0 gap-1">
              {weekDayLabels.map((label, index) => (
                <span key={`${weekDays[index]}-label`} className="min-w-8 text-center font-mono text-[8px] font-bold text-gray-400">
                  {label}
                </span>
              ))}
            </div>
          </div>
          <div className="max-h-72 space-y-2 overflow-y-auto px-3 pb-3">
            {rows.map(row => {
              const tone =
                row.tone === 'meeting' ? 'bg-purple-400' :
                row.tone === 'block' ? 'bg-slate-400' :
                'bg-[#4648d4]';
              return (
                <div key={row.id} className="rounded-lg border border-gray-100 px-2 py-2">
                  <div className="mb-1 flex items-center gap-2">
                    <span className={`h-2 rounded-full ${tone}`} style={{ width: `${Math.max(10, Math.round((row.totalMinutes / max) * 90))}px` }} />
                    <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-gray-800">{row.title}</span>
                    <span className="font-mono text-[10px] font-bold text-gray-600">{fmtMins(row.totalMinutes)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[9px] text-gray-400">{row.subtitle}</span>
                    <div className="flex shrink-0 gap-1">
                      {weekDays.map(date => {
                        const minutes = row.byDate[date] ?? 0;
                        return (
                          <span
                            key={date}
                            className={`min-w-8 rounded px-1 py-0.5 text-center font-mono text-[8px] ${
                              minutes > 0 ? 'bg-gray-100 text-gray-600' : 'bg-gray-50 text-gray-300'
                            }`}
                            title={`${dayLabel(date).dow}: ${minutes ? fmtMins(minutes) : '0m'}`}
                          >
                            {minutes ? fmtMins(minutes) : '-'}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ))}
    </section>
  );
}

export function ScheduleView({ initialPage = 'plan' }: { initialPage?: 'plan' | 'timeline' } = {}) {
  const isPhone = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const { triggerToast, setCurrentTab, setWorkTaskId } = useAppStore();
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  const { data: prefs } = useSchedulePrefs();
  const [clockDate, setClockDate] = useState(() => new Date());
  useEffect(() => {
    const tick = window.setInterval(() => setClockDate(new Date()), 60_000);
    return () => window.clearInterval(tick);
  }, []);
  const todayStr = calendarDateTime(clockDate, prefs?.timezone).date;
  const [focusedDate, setFocusedDate] = useState(todayStr);
  const previousToday = useRef(todayStr);
  useEffect(() => {
    const previous = previousToday.current;
    if (previous === todayStr) return;
    previousToday.current = todayStr;
    // Follow midnight / async timezone preferences only if the user was viewing today.
    setFocusedDate(date => date === previous ? todayStr : date);
  }, [todayStr]);
  const weekStart = mondayOf(focusedDate);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const { data: previewData, isLoading, isError: previewError, isFetching: previewFetching } = useSchedulePreview(weekStart, weekDays[6]);
  const { data: allTasks = [], isLoading: tasksLoading, isError: tasksError } = useAllTasks();
  const { data: allEvents = [], isLoading: eventsLoading, isError: eventsError } = useEvents();
  const { data: allLinks = [] } = useAllEventTaskLinks();
  const { data: allMeetings = [], isLoading: meetingsLoading, isError: meetingsError } = useAllMeetings();
  const { data: goals = [] } = useGoals();
  const [draftPreview, setDraftPreview] = useState<Draft | null>(null);
  const [dragTask, setDragTask] = useState<DBTask | null>(null);
  const [innerPage, setInnerPage] = useState<'plan' | 'month' | 'timeline' | 'feasibility'>(initialPage);
  const [composer, setComposer] = useState<ComposerSeed | null>(null);
  const [taskComposerDate, setTaskComposerDate] = useState<string | null>(null);
  const [routineComposerOpen, setRoutineComposerOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rightPanel, setRightPanel] = useState<'assist' | 'drafts' | null>(null);
  const [mobileRefreshing, setMobileRefreshing] = useState(false);
  const refreshMobileSchedule = async () => {
    setMobileRefreshing(true);
    try {
      await Promise.all(['schedule-preview', 'tasks', 'events', 'event-task-links', 'meetings', 'schedule-prefs', 'routines', 'routine-entries'].map(key =>
        qc.invalidateQueries({ queryKey: [key], refetchType: 'active' }),
      ));
    } finally {
      setMobileRefreshing(false);
    }
  };
  useEffect(() => {
    if (!isPhone) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        setClockDate(new Date());
        if (navigator.onLine) void refreshMobileSchedule();
      }
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    const interval = window.setInterval(refresh, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
      window.clearInterval(interval);
    };
  }, [isPhone, qc]);
  const [dayFlowOrders, setDayFlowOrders] = useState<Record<string, string[]>>(() => {
    try {
      const raw = localStorage.getItem(DAY_FLOW_ORDER_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(DAY_FLOW_ORDER_STORAGE_KEY, JSON.stringify(dayFlowOrders));
    } catch {
      // Best-effort only; the schedule itself remains database-backed.
    }
  }, [dayFlowOrders]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const scheduler = previewData?.scheduler_result;
  const taskLookup = previewData?.task_lookup ?? {};
  const previewByDate = useMemo(
    () => new Map<string, ScheduleDay>((previewData?.days ?? []).map(d => [d.date, d])),
    [previewData],
  );
  const assignmentsByDate = useMemo(
    () => new Map<string, DayAssignment>((scheduler?.day_assignments ?? []).map(a => [a.date, a])),
    [scheduler],
  );

  const childIds = useMemo(
    () => new Set(allTasks.map(t => t.parent_task_id).filter((id): id is string => Boolean(id))),
    [allTasks],
  );
  const isDone = (task: DBTask) => task.completed || task.status === 'done';
  const scheduleWork = useMemo(
    () => allTasks.filter(t =>
      !isDone(t)
      && t.kind !== 'critical_path'
      && t.scheduling_enabled !== false
      && !childIds.has(t.id)
    ),
    [allTasks, childIds],
  );
  const rollupTasks = useMemo(
    () => allTasks.filter(t =>
      !isDone(t)
      && (childIds.has(t.id) || t.scheduling_enabled === false || t.kind === 'critical_path')
    ),
    [allTasks, childIds],
  );
  const startsByDate = useMemo(() => {
    const m = new Map<string, DBTask[]>();
    for (const t of scheduleWork) {
      if (!t.start_date) continue;
      if (!m.has(t.start_date)) m.set(t.start_date, []);
      m.get(t.start_date)!.push(t);
    }
    return m;
  }, [scheduleWork]);
  const backlog = useMemo(() => scheduleWork.filter(t => !t.start_date && (t.estimated_minutes ?? 0) > 0), [scheduleWork]);
  const unestimated = useMemo(() => scheduleWork.filter(t => !(t.estimated_minutes! > 0)), [scheduleWork]);

  // Calendar blocks placed in this week. Only dated blocks render — the old
  // "no date = repeats every week" rule is gone (it made seeded demo events
  // stamp themselves onto every week forever).
  const placedEvents: PlacedEvent[] = useMemo(() =>
    allEvents
      .map(ev => ({ event: ev, date: eventDate(ev) }))
      .filter((p): p is PlacedEvent => p.date !== null && p.date >= weekStart && p.date <= weekDays[6]),
    [allEvents, weekStart, weekDays],
  );

  const linksByEvent = useMemo(() => {
    const m = new Map<string, DBEventTaskLinkFull[]>();
    for (const l of allLinks) {
      if (!m.has(l.event_id)) m.set(l.event_id, []);
      m.get(l.event_id)!.push(l);
    }
    return m;
  }, [allLinks]);

  const weekMeetings: CalendarMeeting[] = useMemo(() =>
    allMeetings
      .map(m => {
        const dt = new Date(m.scheduled_at);
        if (Number.isNaN(dt.getTime())) return null;
        const local = calendarDateTime(dt, prefs?.timezone);
        return {
          id: m.id,
          title: m.title,
          date: local.date,
          startHour: local.hour,
          durationHours: Math.max(0.25, (m.duration_minutes ?? 60) / 60),
        };
      })
      .filter((m): m is CalendarMeeting => m !== null && m.date >= weekStart && m.date <= weekDays[6]),
    [allMeetings, weekStart, weekDays, prefs?.timezone],
  );

  const workDays: number[] = useMemo(() => {
    try {
      const parsed = JSON.parse(prefs?.work_days ?? '[1,2,3,4,5]');
      return Array.isArray(parsed) ? parsed : [1, 2, 3, 4, 5];
    } catch { return [1, 2, 3, 4, 5]; }
  }, [prefs]);

  // One task = one presence: a task with a linked block on a date doesn't
  // also show its all-day chip there.
  const blockDates = useMemo(() => {
    const s = new Set<string>();
    for (const p of placedEvents) {
      for (const link of linksByEvent.get(p.event.id) ?? []) s.add(`${link.task_id}|${p.date}`);
    }
    return s;
  }, [placedEvents, linksByEvent]);

  const shortList = (names: string[]) =>
    names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;

  const taskById = useMemo(() => new Map(allTasks.map(t => [t.id, t])), [allTasks]);
  const goalById = useMemo(() => new Map(goals.map(g => [g.id, g])), [goals]);
  const parentTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of allTasks) {
      if (task.parent_task_id) ids.add(task.parent_task_id);
    }
    return ids;
  }, [allTasks]);

  const dayBreakdowns = useMemo(() => {
    const rawDaily = Number(prefs?.daily_capacity_minutes ?? 480);
    const bufferRatio = Number(prefs?.buffer_ratio ?? 0.15);
    const bufferMinutes = Math.max(0, Math.round(rawDaily * bufferRatio));
    const regularCapacity = Math.max(0, rawDaily - bufferMinutes);
    const map = new Map<string, DayCapacityBreakdown>();

    for (const [index, date] of weekDays.entries()) {
      const day = previewByDate.get(date);
      const overrideMinutes = day?.override?.available_minutes;
      const capacityMinutes = overrideMinutes ?? (workDays.includes(index + 1) ? regularCapacity : 0);
      const meetings = weekMeetings.filter(m => m.date === date);
      const events = placedEvents.filter(p => p.date === date);
      const allDayTasks = (startsByDate.get(date) ?? []).filter(t => !blockDates.has(`${t.id}|${date}`));
      const meetingMinutes = Math.round(meetings.reduce((sum, m) => sum + m.durationHours * 60, 0));
      const eventMinutes = Math.round(events.reduce((sum, p) => sum + p.event.duration_hours * 60, 0));
      const dayTaskMinutes = allDayTasks.reduce((sum, task) => sum + (task.estimated_minutes ?? 0), 0);
      const routineMinutes = (day?.routines ?? []).reduce((sum, routine) => sum + routine.minutes, 0);
      const bookedMinutes = meetingMinutes + eventMinutes + dayTaskMinutes + routineMinutes;
      const freeMinutes = capacityMinutes - bookedMinutes;
      const workRows = new Map<string, {
        label: string;
        minutes: number;
        tone: NonNullable<DayBreakdownItem['tone']>;
        details: string[];
        order: number;
      }>();
      const addWorkRow = (
        key: string,
        label: string,
        minutes: number,
        tone: NonNullable<DayBreakdownItem['tone']>,
        detail: string,
        order: number,
      ) => {
        if (minutes <= 0) return;
        if (!workRows.has(key)) workRows.set(key, { label, minutes: 0, tone, details: [], order });
        const row = workRows.get(key)!;
        row.minutes += minutes;
        if (detail && !row.details.includes(detail)) row.details.push(detail);
        row.order = Math.min(row.order, order);
      };
      const taskOrigin = (task: DBTask) => {
        const root = rootPlanningTask(task, taskById);
        const goal = root.goal_id ? goalById.get(root.goal_id) : null;
        const fromChild = root.id !== task.id;
        const isOriginTask = fromChild || parentTaskIds.has(root.id) || Boolean(root.goal_id);
        return {
          key: isOriginTask ? `origin:${root.id}` : `one-off-task:${task.id}`,
          label: isOriginTask ? root.title : `One-off task: ${task.title}`,
          taskTitle: task.title,
          goalTitle: goal?.title,
          fromChild,
          isOriginTask,
        };
      };
      const taskOriginDetail = (origin: ReturnType<typeof taskOrigin>, prefix?: string) => [
        prefix,
        origin.fromChild ? `subtask: ${origin.taskTitle}` : (origin.isOriginTask ? 'origin task' : 'manual placement'),
        origin.goalTitle,
      ].filter(Boolean).join(' · ');
      const items: DayBreakdownItem[] = [
        { label: overrideMinutes !== undefined ? 'Available override' : 'Focus capacity', minutes: capacityMinutes, detail: day?.override?.note ?? undefined, tone: 'capacity' },
      ];
      if (overrideMinutes === undefined && capacityMinutes > 0 && bufferMinutes > 0) {
        items.push({ label: 'Reserved buffer', minutes: bufferMinutes, tone: 'buffer' });
      }
      for (const task of allDayTasks) {
        const origin = taskOrigin(task);
        addWorkRow(origin.key, origin.label, task.estimated_minutes ?? 0, 'task', taskOriginDetail(origin), 20);
      }
      for (const routine of day?.routines ?? []) {
        addWorkRow(`routine:${routine.routine_id}`, `Routine: ${routine.title}`, routine.minutes, 'routine', routine.preferred_time ? `Preferred slot ${routine.preferred_time}` : 'Flexible routine time reserved', 15);
      }
      for (const placed of events) {
        const links = linksByEvent.get(placed.event.id) ?? [];
        const taskLinks = links.filter(link => link.task_id);
        const eventTotal = Math.round(placed.event.duration_hours * 60);
        if (!taskLinks.length) {
          addWorkRow(
            `one-off-block:${placed.event.id}`,
            `One-off block: ${placed.event.title}`,
            eventTotal,
            'block',
            'timed calendar block',
            30,
          );
          continue;
        }

        const linkWeights = taskLinks.map(link => Math.max(0, Number(link.planned_minutes ?? 0)) || 1);
        const totalWeight = linkWeights.reduce((sum, weight) => sum + weight, 0) || taskLinks.length;
        let allocatedMinutes = 0;

        for (const [linkIndex, link] of taskLinks.entries()) {
          const task = taskById.get(link.task_id);
          const plannedMinutes = linkIndex === taskLinks.length - 1
            ? Math.max(0, eventTotal - allocatedMinutes)
            : Math.round(eventTotal * (linkWeights[linkIndex] / totalWeight));
          allocatedMinutes += plannedMinutes;
          if (!task) {
            addWorkRow(
              `one-off-linked:${link.task_id}`,
              `One-off task: ${link.task_title ?? 'Linked task'}`,
              plannedMinutes,
              'task',
              placed.event.title,
              25,
            );
            continue;
          }
          const origin = taskOrigin(task);
          const blockTitle = placed.event.title.trim() && placed.event.title.trim() !== task.title.trim()
            ? placed.event.title
            : undefined;
          addWorkRow(
            origin.key,
            origin.label,
            plannedMinutes,
            'task',
            taskOriginDetail(origin, blockTitle),
            20,
          );
        }
      }
      for (const meeting of meetings) {
        addWorkRow(
          `meeting:${meeting.id}`,
          `Meeting: ${meeting.title}`,
          Math.round(meeting.durationHours * 60),
          'meeting',
          'calendar meeting',
          40,
        );
      }
      items.push(
        ...[...workRows.values()]
          .sort((a, b) => a.order - b.order || b.minutes - a.minutes || a.label.localeCompare(b.label))
          .map(row => ({
            label: row.label,
            minutes: row.minutes,
            detail: shortList(row.details),
            tone: row.tone,
          })),
      );
      if (capacityMinutes > 0 || bookedMinutes > 0) {
        items.push({
          label: freeMinutes >= 0 ? 'Free focus time' : 'Overbooked',
          minutes: Math.abs(freeMinutes),
          tone: freeMinutes >= 0 ? 'free' : 'overbooked',
        });
      }
      map.set(date, { date, capacityMinutes, bookedMinutes, freeMinutes, items });
    }

    return map;
  }, [prefs, weekDays, previewByDate, workDays, weekMeetings, placedEvents, startsByDate, blockDates, linksByEvent, taskById, goalById, parentTaskIds]);

  // The auto-planner's opinion as explicit suggestion cards (never painted).
  const suggestions = useMemo(
    () => suggestionsFromPlan(scheduler?.day_assignments ?? [], allTasks),
    [scheduler, allTasks],
  );

  const draggableIds = useMemo(() => new Set(scheduleWork.map(t => t.id)), [scheduleWork]);
  const scheduledDates = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of scheduleWork) if (t.start_date) m.set(t.id, t.start_date);
    return m;
  }, [scheduleWork]);

  // Ghost chips per day while previewing a draft
  const ghostsByDate = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!draftPreview) return m;
    for (const a of draftPreview.assignments) {
      if (!m.has(a.start_date)) m.set(a.start_date, []);
      m.get(a.start_date)!.push(a.task_id);
    }
    return m;
  }, [draftPreview]);

  const flowTaskIdsByDate = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const date of weekDays) {
      const visibleIds = (startsByDate.get(date) ?? [])
        .filter(task => !blockDates.has(`${task.id}|${date}`))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.title.localeCompare(b.title))
        .map(task => task.id);
      m.set(date, mergeFlowOrder(dayFlowOrders[date], visibleIds));
    }
    return m;
  }, [weekDays, startsByDate, blockDates, dayFlowOrders]);

  const reorderFlowTasks = (date: string, activeTaskId: string, overTaskId: string) => {
    const visibleIds = (startsByDate.get(date) ?? [])
      .filter(task => !blockDates.has(`${task.id}|${date}`))
      .map(task => task.id);
    const current = mergeFlowOrder(dayFlowOrders[date], visibleIds);
    const next = moveFlowId(current, activeTaskId, overTaskId);
    if (next === current || next.join('|') === current.join('|')) return;
    setDayFlowOrders(prev => ({ ...prev, [date]: next }));
    triggerToast('Day flow order updated.', 'success');
  };

  // ── Mutations ───────────────────────────────────────────────────────────────

  const move = useMutation({
    mutationFn: ({ taskId, date }: { taskId: string; date: string | null }) =>
      apiPatch(`/api/tasks/${taskId}`, { start_date: date }),
    onSuccess: (_r, { date }) => {
      invalidate.allTasks();
      invalidate.schedulePreview();
      triggerToast(date ? `Scheduled for ${date}.` : 'Moved back to backlog.', 'success');
    },
    onError: (e: Error) => triggerToast(e.message, 'error'),
  });

  const createCalendarTask = async ({ title, goalId, parentTaskId, startDate, estimatedMinutes, dueDate }: CalendarTaskDraft) => {
    await apiPost<{ id: string }>('/api/tasks', {
      title,
      goal_id: goalId,
      parent_task_id: parentTaskId,
      start_date: startDate,
      estimated_minutes: estimatedMinutes,
      due_date: dueDate,
      priority: 'medium',
      status: 'todo',
      kind: 'manual',
    });
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['tasks'] }),
      qc.invalidateQueries({ queryKey: ['schedule-preview'] }),
    ]);
    const destination = parentTaskId ? 'subtask' : goalId ? 'goal task' : 'one-off task';
    triggerToast(`${destination[0].toUpperCase()}${destination.slice(1)} "${title}" created${startDate ? ' in the all-day row' : ''}.`, 'success');
  };

  const startFocusTimer = (task: FocusTaskRef) => {
    const active = readActiveWorkTimer();
    if (active) {
      const activeTask = allTasks.find(item => item.id === active.taskId);
      setWorkTaskId(active.taskId);
      setCurrentTab('Work');
      triggerToast(`A timer is already running${activeTask ? ` for "${activeTask.title}"` : ''}.`, 'info');
      return;
    }
    writeActiveWorkTimer({ taskId: task.id, startedAt: new Date().toISOString(), notes: '' });
    setWorkTaskId(task.id);
    setCurrentTab('Work');
    triggerToast(`Focus started for "${task.title}".`, 'success');
    apiPatch(`/api/tasks/${task.id}`, { status: 'in_progress' })
      .then(() => qc.invalidateQueries({ queryKey: ['tasks'] }))
      .catch(() => {
        // The timer still records work if promoting task status fails.
      });
  };

  const startRoutineFocus = (routine: DBRoutine, date: string) => {
    const active = readActiveWorkTimer();
    if (active) {
      setCurrentTab('Work');
      triggerToast('A focus timer is already running. Stop it before starting another.', 'info');
      return;
    }
    if (date !== todayStr) {
      triggerToast('Start focus on today’s routine; you can correct past check-ins separately.', 'info');
      return;
    }
    writeActiveWorkTimer({ taskId: '', routineId: routine.id, routineTitle: routine.title, goalId: routine.goal_id, routineDate: date, sessionId: crypto.randomUUID(), startedAt: new Date().toISOString(), notes: routine.note });
    setCurrentTab('Work');
    triggerToast(`Focus started for "${routine.title}".`, 'success');
  };

  /** Apply every Plan-assist suggestion in one go. */
  const placeAllSuggestions = async () => {
    try {
      await Promise.all(suggestions.map(s => apiPatch(`/api/tasks/${s.taskId}`, { start_date: s.date })));
      invalidate.allTasks();
      invalidate.schedulePreview();
      triggerToast(`Placed ${suggestions.length} task${suggestions.length !== 1 ? 's' : ''} on their suggested days.`, 'success');
    } catch (e) {
      triggerToast((e as Error).message || 'Could not place all suggestions.', 'error');
    }
  };

  /** Drop a task on a time slot: open the composer pre-linked and autofilled,
   *  so the one question left is how many hours to spend. */
  const scheduleTaskAsBlock = (task: DBTask, date: string, hour: number) => {
    const fill = autofillFromTask({ title: task.title, estimated_minutes: task.estimated_minutes }, task.actual_minutes ?? 0);
    setComposer({
      mode: 'create',
      date,
      startHour: hour,
      durationHours: Math.max(0.5, Math.min(fill.duration_hours, GRID_END_HOUR - hour)),
      linkedTaskId: task.id,
      syncStartDate: true,
    });
  };

  const moveEvent = async (ev: DBEvent, next: { date: string; start_hour: number }) => {
    const { week_start, day_index } = dateToWeekPos(next.date);
    try {
      await apiPatch(`/api/events/${ev.id}`, {
        day_index,
        start_hour: next.start_hour,
        time_str: fmtTimeRange(next.start_hour, ev.duration_hours),
        week_start,
      });
      await qc.invalidateQueries({ queryKey: ['events'] });
      invalidate.schedulePreview();
    } catch (e) {
      triggerToast((e as Error).message || 'Could not move the block.', 'error');
    }
  };

  const resizeEvent = async (ev: DBEvent, durationHours: number) => {
    try {
      await apiPatch(`/api/events/${ev.id}`, {
        duration_hours: durationHours,
        time_str: fmtTimeRange(ev.start_hour, durationHours),
      });
      await qc.invalidateQueries({ queryKey: ['events'] });
      invalidate.schedulePreview();
    } catch (e) {
      triggerToast((e as Error).message || 'Could not resize the block.', 'error');
    }
  };

  // One write for a touch gesture, including resizing the start and end together.
  // Errors propagate so the phone can restore the original block and offer retry.
  const changeMobileEvent = async (event: DBEvent, next: CalendarPlacement) => {
    if (event.locked) throw new Error('This block is locked. Open it to edit its details.');
    if (next.startHour < 0 || next.durationHours < 0.25 || next.startHour + next.durationHours > 24) {
      throw new Error('Choose a time within this day.');
    }
    const { week_start, day_index } = dateToWeekPos(next.date);
    await apiPatch(`/api/events/${event.id}`, {
      week_start, day_index, start_hour: next.startHour, duration_hours: next.durationHours,
      time_str: fmtTimeRange(next.startHour, next.durationHours),
    });
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['events'] }),
      qc.invalidateQueries({ queryKey: ['schedule-preview'] }),
    ]);
  };

  /** Hover-✕ on a block: one click removes it, no editor round-trip. */
  const deleteEvent = async (ev: DBEvent) => {
    try {
      await apiDelete(`/api/events/${ev.id}`);
      triggerToast(`"${ev.title}" removed from the calendar.`, 'success');
    } catch (e) {
      triggerToast((e as Error).message || 'Could not remove the block.', 'error');
    }
  };

  // ── Drag & drop (task chips) ───────────────────────────────────────────────

  const onDragStart = (e: DragStartEvent) => {
    const activeId = String(e.active.id);
    setDragTask(activeId.startsWith('flow-task:') ? null : scheduleWork.find(t => t.id === activeId) ?? null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragTask(null);
    const overId = e.over?.id as string | undefined;
    if (!overId) return;
    const taskId = String(e.active.id);
    const flowActive = parseFlowTaskDragId(taskId);
    const flowOver = parseFlowTaskDragId(String(overId));
    if (flowActive) {
      if (flowOver && flowActive.date === flowOver.date) {
        reorderFlowTasks(flowActive.date, flowActive.taskId, flowOver.taskId);
      }
      return;
    }
    const task = scheduleWork.find(t => t.id === taskId);
    if (!task) return;
    if (overId === 'backlog') {
      if (task.start_date) move.mutate({ taskId, date: null });
    } else if (overId.startsWith('flow-day:')) {
      const date = overId.slice('flow-day:'.length);
      if (task.start_date !== date) move.mutate({ taskId, date });
    } else if (flowOver) {
      if (task.start_date !== flowOver.date) move.mutate({ taskId, date: flowOver.date });
    } else if (overId.startsWith('day:')) {
      const date = overId.slice(4);
      if (task.start_date !== date) move.mutate({ taskId, date });
    } else if (overId.startsWith('slot:')) {
      const date = overId.slice(5);
      const overTop = e.over!.rect.top;
      const dragTop = e.active.rect.current.translated?.top ?? overTop;
      const rawHour = GRID_START_HOUR + (dragTop - overTop) / scheduleHourPxForViewport(window.innerWidth);
      const hour = clampHour(snapHour(rawHour, 30), GRID_START_HOUR, GRID_END_HOUR - 0.5);
      scheduleTaskAsBlock(task, date, hour);
    }
  };

  // ── Composer openers ────────────────────────────────────────────────────────

  const openCreate = (date?: string, hour?: number, durationHours = 1) => {
    const now = new Date();
    setComposer({
      mode: 'create',
      date: date ?? (weekDays.includes(focusedDate) ? focusedDate : weekDays[0]),
      startHour: hour ?? clampHour(Math.floor(calendarDateTime(now, prefs?.timezone).hour) + 1, GRID_START_HOUR, GRID_END_HOUR - 1),
      durationHours,
    });
  };

  const openEdit = (ev: DBEvent) => {
    const link = (linksByEvent.get(ev.id) ?? [])[0];
    setComposer({
      mode: 'edit',
      event: ev,
      date: eventDate(ev) ?? addDays(weekStart, ((ev.day_index % 7) + 7) % 7),
      startHour: ev.start_hour,
      durationHours: ev.duration_hours,
      linkId: link?.id,
      linkedTaskId: link?.task_id,
    });
  };

  const statusInfo = scheduler ? (STATUS_STYLE[scheduler.status] ?? STATUS_STYLE.feasible) : null;
  const focusedDayLabel = parseLocalDate(focusedDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const scheduleGridColumns = drawerOpen && rightPanel
    ? 'xl:grid-cols-[240px_minmax(0,1fr)_360px]'
    : drawerOpen
      ? 'xl:grid-cols-[240px_minmax(0,1fr)]'
      : rightPanel
        ? 'xl:grid-cols-[minmax(0,1fr)_360px]'
        : 'xl:grid-cols-1';

  if (!isPhone && innerPage === 'feasibility' && scheduler) {
    return (
      <FeasibilityReport
        scheduler={scheduler}
        taskLookup={taskLookup}
        goals={goals}
        allTasks={allTasks}
        weekDays={weekDays}
        previewDays={previewData?.days ?? []}
        prefs={prefs}
        onBack={() => setInnerPage('plan')}
      />
    );
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      {isPhone ? <MobileSchedule goals={goals} eventLinks={allLinks}
        date={focusedDate} today={todayStr} now={clockDate} timezone={prefs?.timezone}
        days={weekDays} events={placedEvents} meetings={weekMeetings} tasks={allTasks}
        previewByDate={previewByDate} assignmentsByDate={assignmentsByDate} blockedTaskIds={blockDates}
        loading={isLoading || tasksLoading || eventsLoading || meetingsLoading}
        refreshing={mobileRefreshing || previewFetching} error={previewError || tasksError || eventsError || meetingsError}
        onDate={setFocusedDate} onRefresh={refreshMobileSchedule}
        onCreate={openCreate} onEdit={openEdit} onAddTask={setTaskComposerDate} onChangeEvent={changeMobileEvent}
        onScheduleTask={scheduleTaskAsBlock} onStartFocus={startFocusTimer}
        onMoveTask={async (taskId, date) => { await move.mutateAsync({ taskId, date }); }}
        renderRoutines={(date, closeDetails) => <RoutinesPanel date={date} today={todayStr} goals={goals} onCreate={() => { closeDetails(); setRoutineComposerOpen(true); }} onStartFocus={startRoutineFocus} />}
      /> : (
      <div className="mx-auto w-full max-w-[1480px] px-4 py-5 md:px-8 animate-fade-in">
        {/* Header */}
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="font-headline text-2xl font-bold text-black flex items-center gap-2">
              <Calendar size={20} /> Schedule
            </h2>
            <p className="text-xs font-mono text-gray-400 uppercase tracking-widest mt-1">
              Your week, hour by hour — blocks link to tasks and fill themselves in
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setRoutineComposerOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-800 hover:bg-teal-100">
              <Repeat2 size={14} /> Add routine
            </button>
            {statusInfo && scheduler && (
              <button
                type="button"
                onClick={() => setInnerPage('feasibility')}
                title="Open the structured feasibility audit (click or Alt-click)"
                aria-label={`Open feasibility audit: ${schedulerStatusLabel(scheduler)}`}
                className={`text-[10px] font-mono uppercase font-bold px-2.5 py-1 rounded-full border transition-shadow hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 ${statusInfo.cls}`}
              >
                {schedulerStatusLabel(scheduler)}
              </button>
            )}
            {(scheduler?.unestimated_task_ids.length ?? 0) > 0 && (
              <span className="text-[10px] font-mono px-2.5 py-1 rounded-full border bg-amber-50 text-amber-700 border-amber-200 flex items-center gap-1">
                <AlertTriangle size={10} /> {scheduler!.unestimated_task_ids.length} unestimated
              </span>
            )}

            <div className="flex items-center rounded-lg bg-gray-100 p-0.5">
              <button
                onClick={() => setInnerPage('plan')}
                aria-pressed={innerPage === 'plan'}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[10px] font-bold transition-all ${
                  innerPage === 'plan' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                <Calendar size={12} /> Week
              </button>
              <button
                onClick={() => setInnerPage('month')}
                aria-pressed={innerPage === 'month'}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[10px] font-bold transition-all ${
                  innerPage === 'month' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                <CalendarDays size={12} /> Month
              </button>
              <button
                onClick={() => setInnerPage('timeline')}
                aria-pressed={innerPage === 'timeline'}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[10px] font-bold transition-all ${
                  innerPage === 'timeline' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                <BarChart2 size={12} /> Timeline
              </button>
            </div>

            {innerPage === 'plan' && (
              <>
                <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-[#f8f9fa] p-0.5">
                  <button onClick={() => setFocusedDate(d => addDays(d, -7))} className="flex h-8 w-8 items-center justify-center rounded text-gray-600 hover:bg-gray-100" title="Previous week" aria-label="Previous week">
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    onClick={() => setFocusedDate(d => addDays(d, -1))}
                    className="flex h-8 min-w-9 items-center justify-center rounded px-1.5 font-mono text-[9px] font-bold uppercase tracking-wider text-gray-500 hover:bg-gray-100"
                    title="Previous day"
                    aria-label="Previous day"
                  >
                    -1d
                  </button>
                  <button
                    onClick={() => setFocusedDate(todayStr)}
                    disabled={focusedDate === todayStr}
                    className="flex h-8 min-w-12 items-center justify-center rounded px-2 font-mono text-[9px] font-bold uppercase tracking-wider text-gray-500 hover:bg-gray-100 disabled:opacity-40"
                    aria-label="Jump to today"
                  >
                    Today
                  </button>
                  <button
                    onClick={() => setFocusedDate(d => addDays(d, 1))}
                    className="flex h-8 min-w-9 items-center justify-center rounded px-1.5 font-mono text-[9px] font-bold uppercase tracking-wider text-gray-500 hover:bg-gray-100"
                    title="Next day"
                    aria-label="Next day"
                  >
                    +1d
                  </button>
                  <button onClick={() => setFocusedDate(d => addDays(d, 7))} className="flex h-8 w-8 items-center justify-center rounded text-gray-600 hover:bg-gray-100" title="Next week" aria-label="Next week">
                    <ChevronRight size={14} />
                  </button>
                </div>
                <span className="font-headline text-sm font-bold text-gray-700">{fmtWeekRange(weekStart)}</span>
                <span className="rounded-full border border-indigo-100 bg-indigo-50 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wide text-[#4648d4]">
                  {focusedDayLabel}
                </span>
                <button
                  onClick={() => openCreate()}
                  aria-label="Create calendar block"
                  className="flex items-center gap-1.5 rounded-lg bg-[#4648d4] px-3 py-2 font-mono text-[10px] font-bold uppercase text-white shadow-sm hover:opacity-90"
                >
                  <Plus size={12} /> Create
                </button>
              </>
            )}
          </div>
        </div>

        {innerPage === 'plan' ? (
          <>
            <RoutinesPanel date={focusedDate} today={todayStr} goals={goals} onCreate={() => setRoutineComposerOpen(true)} onStartFocus={startRoutineFocus} />
            <WorkloadHorizon
              scheduler={scheduler}
              taskLookup={taskLookup}
              allTasks={allTasks}
              rangeStart={weekStart}
              rangeEnd={weekDays[6]}
              today={todayStr}
              mode="week"
              onOpenAudit={() => setInnerPage('feasibility')}
              onSelectDate={setFocusedDate}
            />

            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setDrawerOpen(value => !value)}
                aria-pressed={drawerOpen}
                className={`flex items-center gap-1 rounded-lg border px-2 py-1.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${drawerOpen ? 'border-indigo-200 bg-indigo-50 text-[#4648d4]' : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'}`}
              >
                <PanelLeftOpen size={11} /> Tasks
              </button>
              <button
                type="button"
                onClick={() => setRightPanel(panel => panel === 'assist' ? null : 'assist')}
                aria-pressed={rightPanel === 'assist'}
                className={`flex items-center gap-1 rounded-lg border px-2 py-1.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${rightPanel === 'assist' ? 'border-indigo-200 bg-indigo-50 text-[#4648d4]' : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'}`}
              >
                <Sparkles size={11} /> Plan assist
                {suggestions.length > 0 && <span className="rounded-full bg-white px-1 text-[8px]">{suggestions.length}</span>}
              </button>
              <button
                type="button"
                onClick={() => setRightPanel(panel => panel === 'drafts' ? null : 'drafts')}
                aria-pressed={rightPanel === 'drafts'}
                className={`flex items-center gap-1 rounded-lg border px-2 py-1.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${rightPanel === 'drafts' ? 'border-indigo-200 bg-indigo-50 text-[#4648d4]' : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'}`}
              >
                <Sparkles size={11} /> AI drafts
              </button>
              <span className="ml-auto hidden font-mono text-[9px] uppercase tracking-wider text-gray-300 sm:inline">Calendar stays open</span>
            </div>

            <div className={`grid grid-cols-1 items-start gap-3 ${scheduleGridColumns}`}>
              {drawerOpen && (
                <TaskTreeDrawer
                  tasks={allTasks}
                  goals={goals}
                  draggableIds={draggableIds}
                  scheduledDates={scheduledDates}
                  onCollapse={() => setDrawerOpen(false)}
                  onCreateTask={createCalendarTask}
                />
              )}

              <div className="min-w-0">
                {isLoading && <p className="mb-2 font-mono text-xs text-gray-400">Loading schedule…</p>}
                <WeekTimeGrid
                  days={weekDays}
                  events={placedEvents}
                  meetings={weekMeetings}
                  routines={weekDays.flatMap(date => previewByDate.get(date)?.routines ?? [])}
                  linksByEvent={linksByEvent}
                  workStart={prefs?.work_start ?? 9}
                  workEnd={prefs?.work_end ?? 18}
                  workDays={workDays}
                  selectedDate={focusedDate}
                  onDaySelect={setFocusedDate}
                  dayBreakdowns={dayBreakdowns}
                  breakdownResetKey={`${weekStart}|${focusedDate}`}
                  renderAllDayCell={date => (
                    <CompactAllDayCell
                      date={date}
                      day={previewByDate.get(date)}
                      startTasks={(startsByDate.get(date) ?? []).filter(t => !blockDates.has(`${t.id}|${date}`))}
                      ghostIds={ghostsByDate.get(date) ?? []}
                      taskLookup={taskLookup}
                      allTasks={allTasks}
                      isBlocked={taskId => blockDates.has(`${taskId}|${date}`)}
                      onAddTask={setTaskComposerDate}
                      onStartFocus={task => void startFocusTimer(task)}
                    />
                  )}
                  onSlotClick={(date, hour) => openCreate(date, hour)}
                  onEventClick={openEdit}
                  onEventMove={(ev, next) => void moveEvent(ev, next)}
                  onEventResize={(ev, d) => void resizeEvent(ev, d)}
                  onEventDelete={ev => void deleteEvent(ev)}
                />
                <WeeklyParentBreakdown
                  weekDays={weekDays}
                  tasks={allTasks}
                  goals={goals}
                  placedEvents={placedEvents}
                  linksByEvent={linksByEvent}
                  startsByDate={startsByDate}
                  blockDates={blockDates}
                  meetings={weekMeetings}
                />
                <DayFlowRiver
                  date={focusedDate}
                  tasks={allTasks}
                  goals={goals}
                  placedEvents={placedEvents}
                  linksByEvent={linksByEvent}
                  meetings={weekMeetings}
                  blockDates={blockDates}
                  taskOrder={flowTaskIdsByDate.get(focusedDate)}
                />
                <div className="mt-1.5 flex items-center gap-2">
                  <p className="font-mono text-[9px] uppercase tracking-wider text-gray-300">
                    + in all-day adds a task · drag a task onto an hour for a Focus block · Play records actual work
                  </p>
                </div>
                {draftPreview && (
                  <p className="mt-1 font-mono text-[10px] text-indigo-500">
                    Previewing "{draftPreview.name}" — dashed chips in the all-day row show where work would start.
                  </p>
                )}
              </div>

              {rightPanel && <div className="min-w-0">
                {rightPanel === 'assist' ? <PlanAssistPanel
                  suggestions={suggestions}
                  taskLookup={taskLookup}
                  unestimated={unestimated}
                  rollupCount={rollupTasks.length}
                  onPlace={(taskId, date) => move.mutate({ taskId, date })}
                  onPlaceAll={placeAllSuggestions}
                  onCollapse={() => setRightPanel(null)}
                /> : <DraftsPanel
                  preview={draftPreview}
                  onPreview={setDraftPreview}
                  onApplied={() => { invalidate.allTasks(); invalidate.schedulePreview(); qc.invalidateQueries({ queryKey: ['goals'] }); }}
                  onCollapse={() => setRightPanel(null)}
                />}
              </div>}
            </div>
          </>
        ) : innerPage === 'month' ? (
          <WorkloadHorizon
            scheduler={scheduler}
            taskLookup={taskLookup}
            allTasks={allTasks}
            rangeStart={todayStr}
            rangeEnd={addDays(todayStr, 34)}
            today={todayStr}
            mode="month"
            onOpenAudit={() => setInnerPage('feasibility')}
            onSelectDate={date => { setFocusedDate(date); setInnerPage('plan'); }}
          />
        ) : (
          <div className="h-[calc(100vh-240px)] min-h-[640px]">
            <GanttView embedded />
          </div>
        )}
      </div>
      )}

      <DragOverlay dropAnimation={null}>
        {dragTask && (
          <div className="flex items-center gap-1 text-[10px] rounded px-1.5 py-1 border bg-[#EEF2FF] text-[#4648d4] border-[#4648d4] shadow-lg">
            <GripVertical size={9} className="opacity-50" />
            <span className="truncate max-w-[140px]">{dragTask.title}</span>
          </div>
        )}
      </DragOverlay>

      {routineComposerOpen && (
        <RoutineComposer goals={goals} date={focusedDate < todayStr ? todayStr : focusedDate} onClose={() => setRoutineComposerOpen(false)} onSaved={() => { setRoutineComposerOpen(false); triggerToast('Routine created. Its time is now reserved in your plan.', 'success'); }} />
      )}

      {taskComposerDate && (
        <ModalFrame
          onClose={() => setTaskComposerDate(null)}
          titleId="calendar-task-composer-title"
          overlayClassName="bg-black/40"
          className="w-full max-w-md overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl"
        >
          <h2 id="calendar-task-composer-title" className="sr-only">Add all-day calendar task</h2>
          <OneOffTaskComposer
            variant="modal"
            tasks={allTasks}
            goals={goals}
            defaultStartDate={taskComposerDate}
            onCancel={() => setTaskComposerDate(null)}
            onCreate={async draft => {
              await createCalendarTask(draft);
              setTaskComposerDate(null);
            }}
          />
        </ModalFrame>
      )}

      {composer && (
        <EventComposer
          seed={composer}
          days={weekDays}
          tasks={allTasks}
          goals={goals}
          onClose={() => setComposer(null)}
        />
      )}
    </DndContext>
  );
}
