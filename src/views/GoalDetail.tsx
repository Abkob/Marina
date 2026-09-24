import { MoreHorizontal } from 'lucide-react';
import { MobileSheet } from '../components/MobileSheet';
import { useMediaQuery, MOBILE_LAYOUT_QUERY } from '../hooks/useMediaQuery';
import { MobileDisclosure } from '../components/MobileDisclosure';
import { ModalFrame } from '../components/ModalFrame';
import { useState, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft, Clock, Folder, Calendar, Sparkles,
  FolderOpen, Upload, FileText, CheckSquare, Square,
  Plus, Trash2, X, Paperclip, ChevronDown, ChevronRight, Check, GripVertical, Pause, Lock,
} from 'lucide-react';
import {
  DndContext, DragOverlay, closestCenter, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { reorderPositions } from '../utils/reorderPositions';
import { buildTaskRivers, wouldCreateTaskRiverCycle } from '../utils/taskRivers';
import { useNow } from '../utils/useNow';
import { motion, AnimatePresence } from 'motion/react';
import { useAppStore } from '../store/useAppStore';
import { NeedsImplementationBadge } from '../components/NeedsImplementationBadge';
import { EntityTopicChips } from '../components/EntityTopicChips';
import { GoalPlanningPanel } from '../components/GoalPlanningPanel';
import { TaskGraphView } from '../components/TaskGraphView';
import { ActualTimeChip } from '../components/ActualTimeChip';
import { useGoal, useGoalTasks, useGoalTaskDependencies, useGoalResources, useTaskResources, useInvalidate, useGoalMeetings, useGoalDeadlines, useGoalMilestones, useCreateWorkSession } from '../api/hooks';
import { archiveGoal, restoreGoal, updateGoal } from '../db/queries/goals';
import { toggleTask, createTask, deleteTask, updateTask, deactivateTask, touchTask, completeTask } from '../db/queries/tasks';
import { createResource, deleteResource, detectResourceType } from '../db/queries/resources';
import { createMeeting, updateMeeting, deleteMeeting } from '../db/queries/meetings';
import { createDeadline, updateDeadline, deleteDeadline, assignTaskToDeadline } from '../db/queries/deadlines';
import type { DBMeeting, DBDeadline } from '../db/schema';
import { getGoalFinishEstimate } from '../utils/goalFinishEstimate';
import { formatTaskTime, getTaskEstimatedMinutes, getTaskLeafProgress, getTaskTimeProgress, getRolledUpTime, parseTaskTimeInput } from '../utils/taskTime';
import { getEffectiveTaskDueDate, getInheritedTaskDueDate, getTaskDeadlineViolation } from '../utils/taskDates';
import { apiFetch, apiPut, apiPatch, apiPost, apiDelete } from '../utils/apiFetch';
import { calculateGoalTaskMetrics, computeGoalStatus } from '../utils/goalTaskMetrics';
import { computeGoalTimeStats, formatVelocity, velocityColor, projectedFinishDate, formatProjectedDate } from '../utils/goalTimeAnalytics';
import { generateSuggestions } from '../utils/subtaskSuggestions';
import type { DBTask, DBResource, DBEdge, CriticalPathStatus, DBMilestone } from '../db/schema';

// ─── Dynamic milestone status ─────────────────────────────────────────────────
function deriveMilestoneStatus(milestone: DBTask, subtasks: DBTask[]): 'Completed' | 'In Progress' | 'On Hold' | 'Not Started' {
  if (milestone.completed) return 'Completed';
  if (subtasks.length > 0 && subtasks.every(t => t.completed || t.status === 'done')) return 'Completed';
  if (milestone.status === 'in_progress') return 'In Progress';
  if (milestone.status === 'inactive' || milestone.status === 'paused' || milestone.status === 'blocked') return 'On Hold';
  if (subtasks.some(t => t.status === 'in_progress')) return 'In Progress';
  if (subtasks.some(t => t.completed || t.status === 'done')) return 'In Progress';
  if (subtasks.some(t => t.status === 'inactive' || t.status === 'paused' || t.status === 'blocked')) return 'On Hold';
  return 'Not Started';
}

// ─── Task progress tree tooltip ────────────────────────────────────────────────
function TaskProgressTree({ tasks }: { tasks: DBTask[] }) {
  function renderNode(task: DBTask, depth: number, isLast: boolean, ancestorLines: boolean[]): React.ReactNode {
    const done    = task.completed || task.status === 'done';
    const partial = !done && getTaskLeafProgress(task, tasks) > 0;
    // exclude next_action from children (they're not structural)
    const kids    = tasks.filter(t => t.parent_task_id === task.id && t.kind !== 'next_action');
    const isMilestone = task.kind === 'critical_path';

    const icon    = done ? '✓' : partial ? '◑' : '○';
    const iconCls = done ? 'text-emerald-400' : partial ? 'text-amber-400' : 'text-gray-500';
    const labelCls= done ? 'text-emerald-300' : partial ? 'text-amber-200/80' : 'text-gray-400';
    const time    = task.estimated_minutes ? formatTaskTime(task.estimated_minutes) : null;
    const label   = task.title.length > 22 ? task.title.slice(0, 21) + '…' : task.title;

    return (
      <div key={task.id}>
        <div className="flex items-center gap-1 py-[2.5px] min-w-0">
          {/* Vertical guide lines for ancestor levels */}
          {ancestorLines.map((hasLine, i) => (
            <span key={i} className="shrink-0 w-3 flex justify-center">
              {hasLine
                ? <span className="block w-px h-full bg-gray-700 self-stretch" style={{ minHeight: 14 }} />
                : null}
            </span>
          ))}
          {/* Branch connector */}
          {depth > 0 && (
            <span className="shrink-0 text-gray-600 text-[9px] leading-none select-none">
              {isLast ? '└' : '├'}
            </span>
          )}
          {isMilestone
            ? <span className="text-[#6366f1] text-[9px] shrink-0">⬡</span>
            : <span className={`text-[9px] font-bold shrink-0 ${iconCls}`}>{icon}</span>
          }
          {time && (
            <span className="font-mono text-[9px] text-gray-600 shrink-0 ml-0.5">{time}</span>
          )}
          <span className={`text-[9px] leading-tight truncate ${isMilestone ? 'text-[#8b8cf8] font-semibold' : labelCls}`}>
            {label}
          </span>
        </div>
        {kids.map((child, i) =>
          renderNode(
            child,
            depth + 1,
            i === kids.length - 1,
            depth > 0 ? [...ancestorLines, !isLast] : [],
          )
        )}
      </div>
    );
  }

  // Roots: tasks with no parent, excluding next_action kind
  const roots = tasks
    .filter(t => !t.parent_task_id && t.kind !== 'next_action')
    .sort((a, b) => {
      // milestones first, then by position
      if (a.kind === 'critical_path' && b.kind !== 'critical_path') return -1;
      if (b.kind === 'critical_path' && a.kind !== 'critical_path') return 1;
      return a.position - b.position;
    });

  return (
    <div className="space-y-0 font-mono">
      {roots.map((r, i) => renderNode(r, 0, i === roots.length - 1, []))}
    </div>
  );
}

// ─── Progress ring ─────────────────────────────────────────────────────────────
function DetailRing({ progress, status }: { progress: number; status: 'Safe' | 'Watch' | 'Risky' }) {
  const color = status === 'Safe' ? '#10B981' : status === 'Watch' ? '#F59E0B' : '#EF4444';
  const circ = 2 * Math.PI * 40;
  return (
    <div className="relative w-14 h-14 shrink-0">
      <svg className="w-full h-full -rotate-90 origin-center text-gray-100" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="40" fill="transparent" stroke="currentColor" strokeWidth="8" />
        <circle cx="50" cy="50" r="40" fill="transparent" stroke={color} strokeWidth="8"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - progress / 100)}
          strokeLinecap="round" style={{ transition: 'stroke-dashoffset 0.5s ease-out' }} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center font-mono text-xs font-bold text-gray-900">
        {progress}%
      </div>
    </div>
  );
}

// ─── Ghost task row ───────────────────────────────────────────────────────────
// Always-visible click-to-type entry. Enter adds and stays open (rapid entry).
// Esc or blur-when-empty dismisses back to ghost state.
function GhostTaskRow({
  onAdd,
  placeholder = 'Add a task…',
  getSuggestions,
  indent = false,
}: {
  onAdd: (title: string) => Promise<void>;
  placeholder?: string;
  getSuggestions?: (input: string) => string[];
  indent?: boolean;
}) {
  const [active, setActive] = useState(false);
  const [value, setValue] = useState('');
  const [chips, setChips] = useState<string[]>([]);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (active) {
      ref.current?.focus();
      if (getSuggestions) setChips(getSuggestions(''));
    }
  }, [active]);

  const submit = async () => {
    const title = value.trim();
    if (!title) return;
    await onAdd(title);
    setValue('');
    if (getSuggestions) setChips(getSuggestions(''));
    setTimeout(() => ref.current?.focus(), 0);
  };

  const handleChange = (val: string) => {
    setValue(val);
    if (getSuggestions) setChips(getSuggestions(val));
  };

  const indentCls = indent ? 'ml-4' : '';

  if (!active) {
    return (
      <button
        onClick={() => setActive(true)}
        className={`w-full flex items-center gap-2 rounded-lg px-1 py-1.5 text-gray-200 hover:text-gray-400 hover:bg-gray-50 cursor-text transition-colors group/ghost ${indentCls}`}
      >
        <span className="w-[13px] shrink-0" />
        <Plus size={12} className="shrink-0 opacity-0 group-hover/ghost:opacity-50 transition-opacity" />
        <span className="text-[11px] font-medium">{placeholder}</span>
      </button>
    );
  }

  return (
    <div className={`space-y-1.5 py-0.5 ${indentCls}`}>
      <div className="flex items-center gap-2 rounded-lg px-1 py-1 bg-[#f8f9fa] ring-1 ring-[#4648d4]/20">
        <span className="w-[13px] shrink-0" />
        <Square size={13} className="text-gray-200 shrink-0" />
        <input
          ref={ref}
          value={value}
          onChange={e => handleChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') { setActive(false); setValue(''); setChips([]); }
          }}
          onBlur={() => { if (!value.trim()) { setActive(false); setChips([]); } }}
          placeholder="Task title… (⏎ add · Esc finish)"
          className="flex-1 bg-transparent text-[11px] text-gray-700 font-medium outline-none placeholder:text-gray-300"
        />
        <button
          onMouseDown={e => { e.preventDefault(); submit(); }}
          className="text-[#4648d4] shrink-0 p-0.5 rounded hover:bg-[#4648d4]/10 transition-colors"
          title="Add (Enter)"
        >
          <Plus size={12} />
        </button>
        <button
          onMouseDown={e => { e.preventDefault(); setActive(false); setValue(''); setChips([]); }}
          className="text-gray-300 hover:text-gray-500 shrink-0 p-0.5 rounded transition-colors"
          title="Cancel (Esc)"
        >
          <X size={12} />
        </button>
      </div>
      {chips.length > 0 && (
        <div className="pl-7 flex flex-wrap gap-1">
          {chips.slice(0, 5).map(chip => (
            <button
              key={chip}
              onMouseDown={e => {
                e.preventDefault();
                onAdd(chip).then(() => {
                  if (getSuggestions) setChips(getSuggestions(''));
                  setTimeout(() => ref.current?.focus(), 0);
                });
              }}
              className="flex items-center gap-1 text-[9px] font-mono text-[#4648d4]/70 bg-[#EEF2FF] hover:bg-[#4648d4]/15 px-2 py-0.5 rounded-full transition-colors"
            >
              <Sparkles size={8} />
              {chip.length > 28 ? chip.slice(0, 27) + '…' : chip}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Resource chip ─────────────────────────────────────────────────────────────
function ResourceChip({ res, onDelete }: { res: DBResource; onDelete: () => void }) {
  const { navigateToResource } = useAppStore();
  const icon = res.type === 'figma'
    ? <span className="text-red-500 font-bold font-mono text-[9px]">F</span>
    : <FileText size={9} className="text-gray-400" />;
  return (
    <span className="inline-flex items-center gap-1 bg-white border border-gray-200 px-1.5 py-0.5 rounded-md text-[10px] text-gray-600 group/chip">
      {icon}
      <button
        onClick={e => { e.stopPropagation(); navigateToResource(res.id); }}
        className="max-w-[80px] truncate hover:text-[#4648d4] transition-colors"
      >
        {res.title}
      </button>
      <button
        onClick={e => { e.stopPropagation(); onDelete(); }}
        className="opacity-0 group-hover/chip:opacity-100 text-gray-300 hover:text-red-400 transition-all ml-0.5"
      >
        <X size={8} />
      </button>
    </span>
  );
}

// ─── Inline editable title ────────────────────────────────────────────────────
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function InlineTitle({
  value,
  onSave,
  className,
  strikethrough,
}: {
  value: string;
  onSave: (val: string) => void;
  className?: string;
  strikethrough?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  useEffect(() => { setVal(value); }, [value]);

  const commit = () => {
    const trimmed = val.trim();
    if (trimmed && trimmed !== value) onSave(trimmed);
    else setVal(value);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={ref}
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setVal(value); setEditing(false); } }}
        className={`bg-transparent border-b border-[#4648d4] outline-none w-full ${className}`}
        onClick={e => e.stopPropagation()}
      />
    );
  }

  return (
    <span
      onClick={e => { e.stopPropagation(); setEditing(true); }}
      className={`cursor-text hover:text-[#4648d4] transition-colors ${strikethrough ? 'line-through opacity-50' : ''} ${className}`}
      title="Click to edit"
    >
      {value}
    </span>
  );
}

// ─── Deadline pill ────────────────────────────────────────────────────────────
// ─── Deadline helpers ──────────────────────────────────────────────────────────

/** Parse a due_date value (date-only OR datetime) into a Date.
 *  Date-only values (no T) are treated as end-of-day 23:59 so a day deadline
 *  doesn't expire at midnight. */
function parseDueDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  if (value.includes('T')) return new Date(value);
  return new Date(`${value}T23:59:00`);
}

/** Format time remaining/elapsed into a compact label. */
function formatCountdown(diffMs: number): { badge: string; detail: string } {
  const abs = Math.abs(diffMs);
  const totalMins = Math.floor(abs / 60_000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  const sign = diffMs < 0 ? '-' : '';

  if (days >= 7)  return { badge: '',            detail: '' };
  if (days >= 2)  return { badge: `${sign}${days}d ${remH}h`, detail: `${days} days ${remH}h` };
  if (hours >= 1) return { badge: `${sign}${hours}h ${mins}m`, detail: `${hours}h ${mins}m` };
  if (totalMins >= 1) return { badge: `${sign}${totalMins}m`, detail: `${totalMins} minutes` };
  return { badge: diffMs < 0 ? 'just now' : '<1m', detail: '' };
}

// ─── DeadlinePill ──────────────────────────────────────────────────────────────
function DeadlinePill({
  value,
  label = 'deadline',
  onSave,
  completedAt,
  inherited = false,
}: {
  value: string | null;
  label?: string;
  onSave: (date: string | null) => void;
  completedAt?: string | null;
  inherited?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const now = useNow(); // updates every 30 s — shared across all pills

  // For completed tasks, evaluate against the completion time, not today
  const refDate = completedAt ? new Date(completedAt) : now;

  const parsed = value ? parseDueDate(value) : null;
  const diffMs = parsed ? parsed.getTime() - refDate.getTime() : null;
  const isOverdue = diffMs !== null && diffMs < 0;
  // "soon" = within 24 hours (only meaningful for open tasks)
  const isSoon = !completedAt && diffMs !== null && diffMs >= 0 && diffMs < 24 * 3_600_000;
  // For far-future deadlines, only show date label (no countdown re-renders needed)
  const isFar = diffMs !== null && Math.abs(diffMs) >= 7 * 86_400_000;

  const hasTime = value?.includes('T') ?? false;

  const dateLabel = parsed
    ? parsed.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric',
        ...(hasTime ? { hour: 'numeric', minute: '2-digit' } : {}),
        year: parsed.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
      })
    : null;

  const { badge } = diffMs !== null ? formatCountdown(diffMs) : { badge: '' };

  const editDefault = value ? value.slice(0, 10) : '';

  const handleSave = (raw: string) => {
    if (!raw) { onSave(null); return; }
    onSave(raw.slice(0, 10));
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          ref={ref}
          type="date"
          defaultValue={editDefault}
          onBlur={e => { handleSave(e.target.value); setEditing(false); }}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditing(false); }}
          className="h-[22px] rounded-full border border-[#4648d4]/40 bg-white px-2.5 text-[10px] text-[#4648d4] outline-none ring-1 ring-[#4648d4]/20"
        />
        {value && !inherited && (
          <button
            onMouseDown={e => { e.preventDefault(); onSave(null); setEditing(false); }}
            className="text-gray-300 hover:text-red-400 transition-colors"
            title="Clear deadline"
          >
            <X size={10} />
          </button>
        )}
      </div>
    );
  }

  if (!dateLabel) {
    return (
      <button
        onClick={() => setEditing(true)}
        title={`Set ${label}`}
        className="inline-flex h-[22px] items-center gap-1 rounded-full border border-dashed border-gray-200 px-2.5 text-[10px] text-gray-300 transition-all hover:border-[#4648d4]/30 hover:text-[#4648d4]/60"
      >
        <Calendar size={9} />
        <span>+ due date</span>
      </button>
    );
  }

  // For completed tasks: show "on time" or "Xd late" based on completion vs due
  const daysLate = completedAt && diffMs !== null ? Math.round(-diffMs / 86_400_000) : null;
  const wasLate  = daysLate !== null && daysLate > 0;
  const wasOnTime = completedAt && !wasLate;

  const titleBase = completedAt
    ? wasLate
      ? `Completed ${daysLate}d late (due ${dateLabel})`
      : `Completed on time (due ${dateLabel})`
    : isOverdue
    ? `Overdue by ${badge.replace('-', '')}`
    : `Due: ${dateLabel}${!isFar && badge ? ` (${badge} left)` : ''}`;
  const title = inherited
    ? `${titleBase}. Inherited from parent task; set a task deadline to override.`
    : titleBase;

  // Pill colour:
  //   completed + late  → amber
  //   completed on time → emerald
  //   open + overdue    → red
  //   open + soon       → amber
  //   open + normal     → gray
  const pillCls = completedAt
    ? wasLate
      ? 'border-amber-200 bg-amber-50 text-amber-600 hover:border-amber-300'
      : 'border-emerald-200 bg-emerald-50 text-emerald-600 hover:border-emerald-300'
    : isOverdue
    ? 'border-red-200 bg-red-50 text-red-500 hover:border-red-300 hover:bg-red-100'
    : isSoon
    ? 'border-amber-200 bg-amber-50 text-amber-600 hover:border-amber-300'
    : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-[#4648d4]/30 hover:bg-[#4648d4]/5 hover:text-[#4648d4]';

  const badgeContent = inherited
    ? 'parent'
    : completedAt
    ? wasLate
      ? `${daysLate}d late`
      : 'on time'
    : !isFar && badge
    ? badge
    : null;

  const badgeCls = inherited
    ? 'bg-[#EEF2FF] text-[#4648d4]'
    : completedAt
    ? wasLate
      ? 'bg-amber-100 text-amber-600'
      : 'bg-emerald-100 text-emerald-600'
    : isOverdue
    ? 'bg-red-100 text-red-500'
    : 'bg-amber-100 text-amber-600';

  return (
    <button
      onClick={() => setEditing(true)}
      title={title}
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2.5 text-[10px] font-medium transition-all hover:shadow-sm ${pillCls} ${inherited ? 'border-dashed' : ''}`}
    >
      <Calendar size={9} className="shrink-0" />
      <span>{dateLabel}</span>
      {badgeContent && (
        <span className={`rounded-full px-1 py-px text-[8px] font-bold ${badgeCls}`}>
          {badgeContent}
        </span>
      )}
    </button>
  );
}

// ─── Inline time-estimate pill (with rollup + remaining-time from progress) ───
function InlineTimePill({
  task,
  allTasks,
  onSave,
  onSaveRollupMode,
}: {
  task: DBTask;
  allTasks: DBTask[];
  onSave: (minutes: number | null) => void;
  onSaveRollupMode?: (mode: NonNullable<DBTask['time_rollup_mode']>) => void;
}) {
  const { minutes, isRollup, ownMinutes, childrenSum, includedChildrenSum, extraChildrenSum } = getRolledUpTime(task, allTasks);
  const tp = getTaskTimeProgress(task, allTasks);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(ownMinutes === null ? '' : formatTaskTime(ownMinutes));
  const ref = useRef<HTMLInputElement>(null);
  const hasParent = Boolean(task.parent_task_id);
  const isInsideParent = task.time_rollup_mode === 'inclusive';

  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  useEffect(() => {
    if (!editing) setDraft(ownMinutes === null ? '' : formatTaskTime(ownMinutes));
  }, [editing, task.estimated_minutes, task.estimated_duration]);

  const commit = () => {
    const t = draft.trim();
    onSave(t === '' ? null : parseTaskTimeInput(t));
    setEditing(false);
  };

  const includedMinutes = includedChildrenSum ?? 0;
  const extraMinutes = extraChildrenSum ?? 0;
  const hasOverhead = isRollup && ownMinutes !== null && childrenSum !== null;
  const hasIncludedChildren = includedMinutes > 0;
  const hasExtraChildren = extraMinutes > 0;

  const tooltipText = hasOverhead
    ? `${formatTaskTime(minutes)} total. ${formatTaskTime(ownMinutes)} parent estimate, ${formatTaskTime(childrenSum)} subtasks.`
    : isRollup
    ? `Summed from subtasks: ${formatTaskTime(minutes)}`
    : `Estimated: ${formatTaskTime(minutes)}`;

  const resolvedTooltipText = isRollup && ownMinutes !== null && hasIncludedChildren
    ? `${formatTaskTime(minutes)} total. ${formatTaskTime(includedMinutes)} of subtasks are inside the ${formatTaskTime(ownMinutes)} parent estimate${hasExtraChildren ? `; ${formatTaskTime(extraMinutes)} adds extra.` : '.'}`
    : hasOverhead
    ? `${formatTaskTime(minutes)} total. ${formatTaskTime(ownMinutes)} parent estimate + ${formatTaskTime(childrenSum)} extra subtasks.`
    : tooltipText;
  const rollupModeTooltip = isInsideParent
    ? 'Included inside the parent estimate. Click to count as extra time.'
    : 'Adds extra time to the parent estimate. Click to include inside the parent estimate.';

  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        onChange={e => setDraft(e.target.value.replace(/[^\d.hm\s]/gi, ''))}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { setDraft(ownMinutes === null ? '' : formatTaskTime(ownMinutes)); setEditing(false); }
        }}
        placeholder="e.g. 1h 30m"
        className="h-[22px] w-20 rounded-full border border-[#4648d4]/40 bg-white px-2.5 text-[10px] text-[#4648d4] outline-none ring-1 ring-[#4648d4]/20"
      />
    );
  }

  if (minutes === null) {
    return (
      <button
        onClick={() => setEditing(true)}
        title="Set time estimate"
        className="inline-flex h-[22px] items-center gap-1 rounded-full border border-dashed border-gray-200 px-2.5 text-[10px] text-gray-300 transition-all hover:border-[#4648d4]/30 hover:text-[#4648d4]/60"
      >
        <Clock size={9} />
        <span>+ time</span>
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        onClick={() => setEditing(true)}
        title={resolvedTooltipText}
        className={`inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2.5 text-[10px] font-medium transition-all hover:shadow-sm ${
          isRollup
            ? 'border-[#4648d4]/20 bg-[#4648d4]/5 text-[#4648d4]/70 hover:border-[#4648d4]/40'
            : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-[#4648d4]/30 hover:bg-[#4648d4]/5 hover:text-[#4648d4]'
        }`}
      >
        <Clock size={9} className="shrink-0" />
        {isRollup && (
          <span className="text-[8px] opacity-50 font-bold">{hasOverhead ? '+' : 'Σ'}</span>
        )}

        <span>{formatTaskTime(minutes)}</span>
      </button>
      {hasParent && minutes !== null && onSaveRollupMode && (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            onSaveRollupMode(isInsideParent ? 'additive' : 'inclusive');
          }}
          title={rollupModeTooltip}
          className={`inline-flex h-[22px] min-w-[24px] items-center justify-center rounded-full border px-1.5 text-[9px] font-mono font-bold transition-colors ${
            isInsideParent
              ? 'border-emerald-200 bg-emerald-50 text-emerald-600 hover:border-emerald-300'
              : 'border-amber-200 bg-amber-50 text-amber-600 hover:border-amber-300'
          }`}
        >
          {isInsideParent ? 'in' : '+'}
        </button>
      )}
    </span>
  );
}

// ─── Task status pill with click menu ────────────────────────────────────────
function TaskStatusPill({ task, onComplete, onDeactivate, onResume }: {
  task: DBTask;
  onComplete: () => void | Promise<void>;
  onDeactivate: () => void | Promise<void>;
  onResume: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const s = task.status;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const isDone = task.completed || s === 'done';
  const isInProgress = s === 'in_progress';
  const isPaused = s === 'inactive' || s === 'paused';
  const isBlocked = s === 'blocked';
  const isPlanned = s === 'planned';

  const dot =
    isDone       ? 'bg-[#10B981]' :
    isInProgress ? 'bg-[#4648d4]' :
    isPaused     ? 'bg-amber-400'  :
    isBlocked    ? 'bg-red-400'    :
    'bg-gray-300';

  const label =
    isDone       ? 'Completed' :
    isInProgress ? 'In Progress' :
    isPaused     ? 'Paused' :
    isBlocked    ? 'Blocked' :
    isPlanned    ? 'Planned' :
    'Open';

  type Opt = { label: string; action: () => void | Promise<void>; color: string };
  const opts: Opt[] = [];
  if (isDone) {
    opts.push({ label: 'Reopen', action: onComplete, color: 'text-gray-600 hover:bg-gray-50' });
  } else {
    if (isInProgress) {
      opts.push({ label: 'Pause', action: onDeactivate, color: 'text-amber-500 hover:bg-amber-50' });
    } else {
      opts.push({ label: isPaused ? 'Resume' : 'Start', action: onResume, color: 'text-[#4648d4] hover:bg-[#EEF2FF]' });
    }
    opts.push({ label: 'Mark done', action: onComplete, color: 'text-emerald-600 hover:bg-emerald-50' });
  }

  const run = async (action: () => void | Promise<void>) => {
    setOpen(false);
    await action();
  };

  return (
    <div ref={ref} className="relative shrink-0" onClick={e => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="inline-flex h-[22px] items-center gap-1.5 rounded-full border border-gray-100 bg-white px-2 text-[9px] font-mono text-gray-500 transition-colors hover:border-[#4648d4]/20 hover:bg-[#f8f9fa]"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
        <span>{label}</span>
        <ChevronDown size={9} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-40 mt-1 flex min-w-[116px] flex-col rounded-lg border border-gray-100 bg-white py-1 shadow-lg"
        >
          {opts.map(o => (
            <button
              key={o.label}
              type="button"
              onClick={() => run(o.action)}
              className={`px-3 py-1.5 text-left text-[11px] font-medium transition-colors ${o.color}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Subtask row ──────────────────────────────────────────────────────────────
function TaskTreeRow({
  task,
  allTasks,
  childrenByParent,
  taskResources,
  depth = 0,
  onToggleSubtask,
  onDeleteSubtask,
  onUpdateSubtaskTitle,
  onAddSubtask,
  onAttachResource,
  onAttachFiles,
  onDeleteResource,
  onDeactivate,
  onResume,
  onOpenFocus,
  onUpdateDeadline,
  onUpdateTime,
  onUpdateTimeRollupMode,
  onUpdateActualTime,
  sequenceLocked = false,
}: {
  task: DBTask;
  allTasks: DBTask[];
  childrenByParent: Record<string, DBTask[]>;
  taskResources: Record<string, DBResource[]>;
  depth?: number;
  onToggleSubtask: (task: DBTask) => void;
  onDeleteSubtask: (task: DBTask) => void;
  onUpdateSubtaskTitle: (taskId: string, title: string) => void;
  onAddSubtask: (parentTaskId: string, title: string) => Promise<void>;
  onAttachResource: (taskId: string, title: string, url: string | null, type: DBResource['type']) => Promise<void>;
  onAttachFiles: (taskId: string, files: FileList | null) => Promise<void>;
  onDeleteResource: (resId: string) => void;
  onDeactivate: (task: DBTask) => void;
  onResume: (task: DBTask) => void;
  onOpenFocus: (taskId: string) => void;
  onUpdateDeadline: (taskId: string, date: string | null) => void;
  onUpdateTime: (taskId: string, minutes: number | null) => void;
  onUpdateTimeRollupMode: (taskId: string, mode: NonNullable<DBTask['time_rollup_mode']>) => void;
  onUpdateActualTime: (taskId: string, minutes: number | null) => void;
  sequenceLocked?: boolean;
}) {
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const [actionsOpen, setActionsOpen] = useState(false);
  const parentTitle = allTasks.find(parent => parent.id === task.parent_task_id)?.title;
  const spotlightTaskId = useAppStore(s => s.spotlightTaskId);
  const children = childrenByParent[task.id] ?? [];
  const resources = taskResources[task.id] ?? [];
  const [expanded, setExpanded] = useState(depth === 0);
  const [showResourceInput, setShowResourceInput] = useState(false);
  const [resourceInput, setResourceInput] = useState('');
  const resRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const effectiveDueDate = getEffectiveTaskDueDate(task, allTasks);
  const inheritedDueDate = getInheritedTaskDueDate(task, allTasks);

  useEffect(() => { if (showResourceInput) resRef.current?.focus(); }, [showResourceInput]);

  const submitResource = () => {
    const val = resourceInput.trim();
    if (!val) { setShowResourceInput(false); return; }
    const type = detectResourceType(val);
    const url = type !== 'document' ? val : null;
    onAttachResource(task.id, val, url, type);
    setResourceInput('');
    setShowResourceInput(false);
  };
  const highlighted = spotlightTaskId === task.id;

  return (
    <div
      data-task-id={task.id}
      className={`group/sub flex flex-col gap-1 rounded-lg py-1.5 transition-colors ${
        highlighted ? 'bg-[#EEF2FF]/70 ring-1 ring-[#4648d4]/20' : ''
      }`}
    >
      {isMobile ? <div className="flex items-center gap-1 border-b border-slate-100 py-2">
        <button onClick={() => !sequenceLocked && onToggleSubtask(task)} disabled={sequenceLocked} aria-label={(task.completed ? 'Reopen task ' : 'Complete task ') + task.title} className="mobile-icon-button shrink-0 text-slate-400">{sequenceLocked ? <Lock size={18} /> : task.completed ? <CheckSquare size={20} className="text-emerald-500" /> : <Square size={20} />}</button>
        <button onClick={() => onOpenFocus(task.id)} aria-label={'Open task ' + task.title} className="min-w-0 flex-1 py-1 text-left">
          <span className={'block text-sm font-medium leading-5 text-slate-800' + (task.completed ? ' line-through opacity-50' : '')}>{task.title}</span>
          {parentTitle && <span className="mt-0.5 block truncate text-xs text-slate-400" title={parentTitle}>{parentTitle}</span>}
          {(effectiveDueDate || task.estimated_minutes) && <span className="mt-1 block text-xs text-slate-500">{effectiveDueDate ? 'Due ' + effectiveDueDate.slice(5,10) : ''}{effectiveDueDate && task.estimated_minutes ? ' · ' : ''}{task.estimated_minutes ? task.estimated_minutes + ' min' : ''}</span>}
        </button>
        <button onClick={() => setActionsOpen(true)} aria-label={'Options for task ' + task.title} className="mobile-icon-button shrink-0 text-slate-400"><MoreHorizontal size={18} /></button>
        {children.length > 0 && <button onClick={() => setExpanded(v => !v)} aria-label={(expanded ? 'Collapse' : 'Expand') + ' subtasks of ' + task.title} aria-expanded={expanded} className="mobile-icon-button shrink-0 gap-1 text-slate-400"><span className="text-xs">{children.length}</span>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>}
      </div> : <div className="mobile-task-row flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-gray-50 transition-colors">
        <button
          onClick={() => setExpanded(v => !v)}
          className={`shrink-0 transition-colors ${children.length === 0 ? 'text-gray-200 hover:text-gray-300' : 'text-gray-300 hover:text-[#4648d4]'}`}
          title={expanded ? 'Collapse' : children.length === 0 ? 'Expand to add child tasks' : 'Expand child tasks'}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>

        <button
          onClick={() => !sequenceLocked && onToggleSubtask(task)}
          disabled={sequenceLocked}
          className={`shrink-0 transition-colors ${sequenceLocked ? 'cursor-not-allowed text-gray-200' : 'text-gray-300 hover:text-[#4648d4]'}`}
          title={sequenceLocked ? 'Finish the previous step first' : task.completed ? 'Reopen task' : 'Complete task'}
        >
          {sequenceLocked ? <Lock size={13} /> : task.completed ? <CheckSquare size={14} className="text-[#10B981]" /> : <Square size={14} />}
        </button>
        {sequenceLocked ? (
          <span className="inline-flex h-[22px] items-center rounded-full border border-gray-100 bg-gray-50 px-2 font-mono text-[9px] text-gray-400">
            Locked
          </span>
        ) : (
          <TaskStatusPill
            task={task}
            onComplete={() => onToggleSubtask(task)}
            onDeactivate={() => onDeactivate(task)}
            onResume={() => onResume(task)}
          />
        )}

        <InlineTitle
          value={task.title}
          onSave={title => onUpdateSubtaskTitle(task.id, title)}
          strikethrough={task.completed}
          className="mobile-task-title text-xs text-gray-700 font-medium flex-1 min-w-0"
        />

        {children.length > 0 && (
          <span className="text-[9px] font-mono text-gray-300 shrink-0">{children.length}</span>
        )}

        {/* Deadline + time — visible when set; shown on hover when empty */}
        <div className="mobile-task-dates flex items-center gap-1 shrink-0">
          <DeadlinePill
            value={effectiveDueDate}
            onSave={d => onUpdateDeadline(task.id, d)}
            completedAt={task.completed || task.status === 'done' ? (task.last_activity_at ?? task.updated_at) : null}
            inherited={Boolean(inheritedDueDate)}
          />
          <InlineTimePill
            task={task}
            allTasks={allTasks}
            onSave={m => onUpdateTime(task.id, m)}
            onSaveRollupMode={mode => onUpdateTimeRollupMode(task.id, mode)}
          />
          {task.completed && task.actual_minutes != null && (
            <ActualTimeChip
              minutes={task.actual_minutes}
              estimatedMinutes={task.estimated_minutes}
              onSave={m => onUpdateActualTime(task.id, m)}
            />
          )}
        </div>

        <div className="mobile-task-actions flex items-center gap-1 opacity-0 group-hover/sub:opacity-100 transition-opacity shrink-0">
          <button
            onClick={() => onOpenFocus(task.id)}
            className="mobile-open-task text-gray-300 hover:text-[#4648d4] transition-colors p-0.5 rounded"
            title="Open focus page"
            aria-label={`Open task ${task.title}`}
          >
            <FileText size={11} /><span className="md:hidden">Open</span>
          </button>
          <button
            onClick={() => setExpanded(true)}
            className="text-gray-300 hover:text-[#4648d4] transition-colors p-0.5 rounded"
            title="Expand to add child tasks"
          >
            <Plus size={11} />
          </button>
          <button
            onClick={() => setShowResourceInput(v => !v)}
            className="text-gray-300 hover:text-[#4648d4] transition-colors p-0.5 rounded"
            title="Attach resource"
          >
            <Paperclip size={11} />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-gray-300 hover:text-[#4648d4] transition-colors p-0.5 rounded"
            title="Upload files"
          >
            <Upload size={11} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={async (e) => {
              await onAttachFiles(task.id, e.currentTarget.files);
              e.currentTarget.value = '';
            }}
          />
          <button
            onClick={() => onDeleteSubtask(task)}
            className="text-gray-300 hover:text-red-400 transition-colors p-0.5 rounded"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>}

      {actionsOpen && <MobileSheet title="Task actions" onClose={() => setActionsOpen(false)}>
        <p className="mb-3 text-sm text-slate-500">{task.title}</p>
        <button onClick={() => { setActionsOpen(false); onOpenFocus(task.id); }} className="min-h-14 w-full text-left text-sm">Edit task, dates & subtasks</button>
        <button disabled={sequenceLocked} onClick={() => { setActionsOpen(false); task.status === 'in_progress' ? onDeactivate(task) : onResume(task); }} className="min-h-14 w-full text-left text-sm disabled:opacity-40">{sequenceLocked ? 'Waiting for the previous step' : task.status === 'in_progress' ? 'Pause task' : 'Start / resume task'}</button>
        <button onClick={() => { setActionsOpen(false); onDeleteSubtask(task); }} className="min-h-14 w-full text-left text-sm text-red-600">Delete task</button>
      </MobileSheet>}
      {/* Resource chips */}
      {!isMobile && resources.length > 0 && (
        <div className="flex flex-wrap gap-1 ml-6">
          {resources.map(r => (
            <ResourceChip key={r.id} res={r} onDelete={() => onDeleteResource(r.id)} />
          ))}
        </div>
      )}

      {/* Inline resource input */}
      <AnimatePresence>
        {showResourceInput && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="ml-6 flex gap-2 overflow-hidden"
          >
            <input
              ref={resRef}
              value={resourceInput}
              onChange={e => setResourceInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitResource(); if (e.key === 'Escape') setShowResourceInput(false); }}
              placeholder="URL or filename…"
              className="flex-1 bg-white border border-gray-200 rounded-lg px-2.5 py-1 text-[11px] text-gray-700 focus:outline-none focus:border-[#4648d4] transition-all"
            />
            <button onClick={submitResource} className="bg-[#4648d4] text-white rounded-lg px-2 py-1 hover:opacity-90 transition-colors">
              <Check size={11} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {expanded && (!isMobile || children.length > 0) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="ml-4 border-l border-gray-100 pl-3 overflow-hidden"
          >
            {children.map(child => (
              <TaskTreeRow
                key={child.id}
                task={child}
                allTasks={allTasks}
                childrenByParent={childrenByParent}
                taskResources={taskResources}
                depth={depth + 1}
                onToggleSubtask={onToggleSubtask}
                onDeleteSubtask={onDeleteSubtask}
                onUpdateSubtaskTitle={onUpdateSubtaskTitle}
                onAddSubtask={onAddSubtask}
                onAttachResource={onAttachResource}
                onAttachFiles={onAttachFiles}
                onDeleteResource={onDeleteResource}
                onDeactivate={onDeactivate}
                onResume={onResume}
                onOpenFocus={onOpenFocus}
                onUpdateDeadline={onUpdateDeadline}
                onUpdateTime={onUpdateTime}
                onUpdateTimeRollupMode={onUpdateTimeRollupMode}
                onUpdateActualTime={onUpdateActualTime}
              />
            ))}
            {!isMobile && <GhostTaskRow
              onAdd={title => onAddSubtask(task.id, title)}
              placeholder="Add child task…"
            />}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Goal Milestones section (goal_milestones table — phase checkpoints) ─────

const MILESTONE_COLORS = ['#6366f1','#8b5cf6','#10b981','#f59e0b','#ef4444','#3b82f6'];

function GoalMilestonesSection({
  goalId, milestones, tasks, onInvalidate, onInvalidateTasks,
}: {
  goalId: string;
  milestones: DBMilestone[];
  tasks: DBTask[];
  onInvalidate: () => void;
  onInvalidateTasks: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ title: '', due_date: '', color: MILESTONE_COLORS[0] });
  const [saving, setSaving] = useState(false);
  const { showConfirm: showConfirmStore } = useAppStore();

  if (!milestones.length && !addOpen) {
    return (
      <section>
        <button
          onClick={() => setAddOpen(true)}
          className="text-[10px] font-mono text-gray-500 hover:text-indigo-400 transition-colors flex items-center gap-1.5"
        >
          <Plus size={11} /> Add Milestone
        </button>
      </section>
    );
  }

  const tasksByMilestone: Record<string, DBTask[]> = {};
  for (const t of tasks) {
    if (t.milestone_id) {
      if (!tasksByMilestone[t.milestone_id]) tasksByMilestone[t.milestone_id] = [];
      tasksByMilestone[t.milestone_id].push(t);
    }
  }

  const handleToggleComplete = async (m: DBMilestone) => {
    await apiPut(`/api/milestones/${m.id}`, { completed: !m.completed });
    onInvalidate();
  };

  const handleAssignTask = async (taskId: string, milestoneId: string | null) => {
    await apiPatch('/api/milestones/assign-task', { task_id: taskId, milestone_id: milestoneId });
    onInvalidateTasks();
  };

  const handleDelete = async (id: string) => {
    await apiDelete(`/api/milestones/${id}`);
    onInvalidate();
  };

  const handleAdd = async () => {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      await apiPost('/api/milestones', { goal_id: goalId, title: form.title, due_date: form.due_date || null, color: form.color });
      setForm({ title: '', due_date: '', color: MILESTONE_COLORS[0] });
      setAddOpen(false);
      onInvalidate();
    } finally {
      setSaving(false);
    }
  };

  const unassignedTasks = tasks.filter(t => !t.milestone_id && !t.parent_task_id && !t.completed);

  const handleDeleteTask = (t: DBTask) => {
    showConfirmStore(`Delete task "${t.title}"? This cannot be undone.`, async () => {
      await deleteTask(t.id);
      onInvalidateTasks();
    });
  };

  return (
    <section>
      <h2 className="font-headline text-sm font-bold text-gray-900 flex items-center gap-2 mb-3">
        <span className="text-[#6366f1]">⬡</span>
        Milestones
        <span className="font-mono text-[10px] text-gray-400 font-normal">
          {milestones.filter(m => m.completed).length}/{milestones.length}
        </span>
      </h2>

      {/* ── Unassigned tasks: milestone-less work gets a real home ── */}
      {unassignedTasks.length > 0 && (
        <div className="rounded-xl border border-dashed border-amber-300/70 bg-amber-50/40 p-3 mb-3">
          <p className="text-[11px] font-bold text-amber-800 mb-0.5">
            Unassigned tasks ({unassignedTasks.length})
          </p>
          <p className="text-[10px] text-amber-700/80 mb-2">
            In this goal but not under any milestone. Assign them below, or delete what you don’t need.
          </p>
          <div className="space-y-1">
            {unassignedTasks.map(t => (
              <div key={t.id} className="group flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5">
                <span className="text-gray-400 font-mono text-[10px] shrink-0">{t.kind === 'critical_path' ? '◆' : t.kind === 'ai_generated' ? '✦' : '○'}</span>
                <span className="flex-1 text-xs text-gray-800 truncate">{t.title}</span>
                {t.estimated_minutes
                  ? <span className="shrink-0 text-[9px] font-mono text-gray-400">{t.estimated_minutes}m</span>
                  : <span className="shrink-0 text-[9px] font-mono text-amber-600" title="No time estimate — the scheduler can't plan this task">no est.</span>}
                {t.due_date && <span className="shrink-0 text-[9px] font-mono text-gray-400">{t.due_date}</span>}
                {milestones.filter(m => !m.completed).length > 0 && (
                  <select
                    onChange={e => { if (e.target.value) { handleAssignTask(t.id, e.target.value); e.target.value = ''; } }}
                    defaultValue=""
                    className="shrink-0 text-[9px] font-mono bg-white border border-gray-200 rounded px-1 py-0.5 text-gray-500 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Assign to a milestone"
                  >
                    <option value="">→ milestone…</option>
                    {milestones.filter(m => !m.completed).map(m => (
                      <option key={m.id} value={m.id}>{m.title.slice(0, 30)}</option>
                    ))}
                  </select>
                )}
                <button
                  onClick={() => handleDeleteTask(t)}
                  className="shrink-0 text-gray-300 hover:text-red-500 transition-colors"
                  title="Delete task"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {milestones.map(m => {
          const mTasks = tasksByMilestone[m.id] ?? [];
          const isOpen = expanded[m.id] ?? false;
          const done = mTasks.filter(t => t.completed).length;
          return (
            <div key={m.id} className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
              <div className="flex items-center gap-2.5 px-3 py-2.5" style={{ borderLeft: `3px solid ${m.color}` }}>
                <button onClick={() => handleToggleComplete(m)} className="shrink-0">
                  {m.completed
                    ? <Check size={14} className="text-emerald-500" />
                    : <Square size={14} className="text-gray-400 hover:text-gray-600" />}
                </button>
                <button
                  onClick={() => setExpanded(e => ({ ...e, [m.id]: !isOpen }))}
                  className="flex-1 text-left flex items-center gap-2 min-w-0"
                >
                  <span className={`text-sm font-semibold truncate ${m.completed ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                    {m.title}
                  </span>
                  {m.due_date && (
                    <span className="shrink-0 text-[10px] font-mono text-gray-400 flex items-center gap-0.5">
                      <Calendar size={10} />
                      {m.due_date}
                    </span>
                  )}
                  {mTasks.length > 0 && (
                    <span className="shrink-0 text-[10px] font-mono text-gray-400">{done}/{mTasks.length}</span>
                  )}
                  {isOpen ? <ChevronDown size={12} className="text-gray-400 ml-auto shrink-0" /> : <ChevronRight size={12} className="text-gray-400 ml-auto shrink-0" />}
                </button>
                <button onClick={() => handleDelete(m.id)} className="shrink-0 text-gray-300 hover:text-red-400 transition-colors">
                  <Trash2 size={12} />
                </button>
              </div>
              {isOpen && (
                <div className="px-3 pb-3 pt-1 space-y-1.5 bg-gray-50/50">
                  {mTasks.length ? mTasks.map(t => (
                    <div key={t.id} className="flex items-center gap-2 text-xs text-gray-600">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${t.completed ? 'bg-emerald-400' : 'bg-gray-300'}`} />
                      <span className={`flex-1 truncate ${t.completed ? 'line-through text-gray-400' : ''}`}>{t.title}</span>
                      {!t.completed && (
                        <button
                          onClick={() => handleAssignTask(t.id, null)}
                          className="shrink-0 text-gray-300 hover:text-red-400 transition-colors"
                          title="Remove from milestone"
                        >
                          <X size={10} />
                        </button>
                      )}
                    </div>
                  )) : <p className="text-xs text-gray-400 italic">No tasks assigned to this milestone.</p>}

                  {unassignedTasks.length > 0 && (
                    <div className="pt-1.5">
                      <select
                        onChange={e => { if (e.target.value) { handleAssignTask(e.target.value, m.id); e.target.value = ''; } }}
                        className="text-[10px] font-mono bg-white border border-gray-200 rounded-lg px-2 py-1 text-gray-500 cursor-pointer"
                        defaultValue=""
                      >
                        <option value="">+ Assign task…</option>
                        {unassignedTasks.map(t => (
                          <option key={t.id} value={t.id}>{t.title.slice(0, 40)}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {addOpen ? (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 space-y-2">
            <input
              autoFocus
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAddOpen(false); }}
              placeholder="Milestone title…"
              className="w-full text-sm bg-white border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-indigo-400"
            />
            <div className="flex gap-2 items-center">
              <input
                type="date"
                value={form.due_date}
                onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))}
                className="flex-1 text-xs font-mono bg-white border border-gray-200 rounded-lg px-2 py-1.5 outline-none"
              />
              <div className="flex gap-1">
                {MILESTONE_COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => setForm(f => ({ ...f, color: c }))}
                    className={`w-5 h-5 rounded-full border-2 transition-all ${form.color === c ? 'border-gray-900 scale-110' : 'border-transparent'}`}
                    style={{ background: c }}
                  />
                ))}
              </div>
              <button
                onClick={handleAdd}
                disabled={saving || !form.title.trim()}
                className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg disabled:opacity-40"
              >
                {saving ? '…' : 'Add'}
              </button>
              <button onClick={() => setAddOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X size={14} />
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setAddOpen(true)}
            className="text-[10px] font-mono text-gray-500 hover:text-indigo-400 transition-colors flex items-center gap-1.5 px-1"
          >
            <Plus size={11} /> Add Milestone
          </button>
        )}
      </div>
    </section>
  );
}

// ─── Milestone card ───────────────────────────────────────────────────────────
function RiverTaskConnector({ task, blocker, stepNumber, showStepLabel, onDetach }: {
  task: DBTask;
  blocker: DBTask | null;
  stepNumber: number;
  showStepLabel: boolean;
  onDetach: () => void;
}) {
  const drag = useDraggable({ id: `river-drag:${task.id}`, data: { taskId: task.id, title: task.title } });
  const drop = useDroppable({ id: `river-after:${task.id}`, data: { taskId: task.id } });
  return (
    <div
      ref={drop.setNodeRef}
      className={`flex min-h-5 items-center gap-1 rounded-md border px-1 transition-colors ${
        drop.isOver ? 'border-[#4648d4]/40 bg-[#EEF2FF]' : 'border-transparent'
      }`}
    >
      <button
        ref={drag.setNodeRef}
        {...drag.attributes}
        {...drag.listeners}
        type="button"
        className="touch-none cursor-grab rounded p-0.5 text-gray-300 hover:text-[#4648d4] active:cursor-grabbing"
        title={`Drag ${task.title} onto another task to connect it`}
        aria-label={`Drag ${task.title} to set what it follows`}
      >
        <GripVertical size={12} />
      </button>
      {(showStepLabel || drop.isOver) && (
        <span className="min-w-0 flex-1 truncate font-mono text-[8px] text-gray-400">
          {drop.isOver
            ? `Release to make the dragged task Step ${stepNumber + 1}, after ${task.title}`
            : blocker ? `Step ${stepNumber} · after ${blocker.title}` : `Step ${stepNumber} · starts here`}
        </span>
      )}
      {blocker && (
        <button type="button" onClick={onDetach} className="rounded p-0.5 text-gray-300 hover:text-red-400" title="Make independent">
          <X size={10} />
        </button>
      )}
    </div>
  );
}

function IndependentRiverDropZone({ milestoneId }: { milestoneId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `river-independent:${milestoneId}` });
  return (
    <div ref={setNodeRef} className={`rounded-md border border-dashed px-2 py-1.5 text-center text-[9px] transition-all ${
      isOver ? 'border-emerald-400 bg-emerald-50 font-bold text-emerald-600' : 'border-indigo-200 text-gray-400'
    }`}>
      {isOver ? 'Release to make independent' : 'Drop here to start a separate river'}
    </div>
  );
}

function MilestoneCard({
  milestone,
  allTasks,
  subtasksByParent,
  taskResources,
  category,
  goalTitle,
  onToggleSubtask,
  onDeleteSubtask,
  onUpdateSubtaskTitle,
  onAddSubtask,
  onAttachResource,
  onAttachFiles,
  onDeleteResource,
  onDeactivate,
  onResume,
  onOpenFocus,
  onUpdateDeadline,
  onUpdateTime,
  onUpdateTimeRollupMode,
  onUpdateActualTime,
  dependencies,
  onSetDependency,
  onDelete,
}: {

  milestone: DBTask;
  allTasks: DBTask[];
  subtasksByParent: Record<string, DBTask[]>;
  taskResources: Record<string, DBResource[]>;
  category: string;
  goalTitle: string;
  onToggleSubtask: (task: DBTask) => void;
  onDeleteSubtask: (task: DBTask) => void;
  onUpdateSubtaskTitle: (taskId: string, title: string) => void;
  onAddSubtask: (parentTaskId: string, title: string) => Promise<void>;
  onAttachResource: (taskId: string, title: string, url: string | null, type: DBResource['type']) => Promise<void>;
  onAttachFiles: (taskId: string, files: FileList | null) => Promise<void>;
  onDeleteResource: (resourceId: string) => void;
  onDeactivate: (task: DBTask) => void;
  onResume: (task: DBTask) => void;
  onOpenFocus: (taskId: string) => void;
  onUpdateDeadline: (taskId: string, date: string | null) => void;
  onUpdateTime: (taskId: string, minutes: number | null) => void;
  onUpdateTimeRollupMode: (taskId: string, mode: NonNullable<DBTask['time_rollup_mode']>) => void;
  onUpdateActualTime: (taskId: string, minutes: number | null) => void;
  dependencies: DBEdge[];
  onSetDependency: (taskId: string, blockerId: string | null) => Promise<void>;
  onDelete: (task: DBTask) => void;
}) {
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const [actionsOpen, setActionsOpen] = useState(false);
  const spotlightTaskId = useAppStore(s => s.spotlightTaskId);
  const subtasks = [...(subtasksByParent[milestone.id] ?? [])].sort((a, b) =>
    (a.position ?? 0) - (b.position ?? 0) || a.title.localeCompare(b.title)
  );
  const subtaskIds = new Set(subtasks.map(task => task.id));
  const riverEdges = dependencies.filter(edge => subtaskIds.has(edge.source_id) && subtaskIds.has(edge.target_id));
  const taskById = new Map(subtasks.map(task => [task.id, task]));
  const blockerIdsByTask = new Map<string, string[]>();
  for (const edge of riverEdges) {
    blockerIdsByTask.set(edge.target_id, [...(blockerIdsByTask.get(edge.target_id) ?? []), edge.source_id]);
  }
  const rivers = buildTaskRivers(subtasks, riverEdges);

  const dynStatus = deriveMilestoneStatus(milestone, subtasks);
  const highlighted = spotlightTaskId === milestone.id;

  const [expanded, setExpanded] = useState(dynStatus === 'In Progress');
  const [draggedRiverTask, setDraggedRiverTask] = useState<DBTask | null>(null);
  const riverSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const handleRiverDragEnd = (event: DragEndEvent) => {
    const taskId = String(event.active.id).replace('river-drag:', '');
    const overId = event.over ? String(event.over.id) : '';
    setDraggedRiverTask(null);
    if (!overId || overId === `river-after:${taskId}`) return;
    if (overId.startsWith('river-after:')) {
      void onSetDependency(taskId, overId.replace('river-after:', ''));
    } else if (overId.startsWith('river-independent:')) {
      void onSetDependency(taskId, null);
    }
  };

  const dotCls =
    dynStatus === 'Completed'   ? 'bg-[#10B981]' :
    dynStatus === 'In Progress' ? 'bg-[#4648d4]' :
    dynStatus === 'On Hold'     ? 'bg-amber-400' :
    'bg-gray-300';

  const badgeCls =
    dynStatus === 'Completed'   ? 'bg-emerald-50 text-[#10B981]' :
    dynStatus === 'In Progress' ? 'bg-[#4648d4]/10 text-[#4648d4]' :
    dynStatus === 'On Hold'     ? 'bg-amber-50 text-amber-500' :
    'bg-gray-100 text-gray-400';

  const statusLabel = dynStatus;
  const [statusOpen, setStatusOpen] = useState(false);
  const statusRef = useRef<HTMLSpanElement>(null);
  const effectiveDueDate = getEffectiveTaskDueDate(milestone, allTasks);
  const inheritedDueDate = getInheritedTaskDueDate(milestone, allTasks);
  const completedAt = milestone.completed || milestone.status === 'done'
    ? (milestone.last_activity_at ?? milestone.updated_at)
    : dynStatus === 'Completed'
    ? subtasks
        .map(task => task.last_activity_at ?? task.updated_at)
        .sort((a, b) => b.localeCompare(a))[0] ?? null
    : null;

  useEffect(() => {
    if (!statusOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!statusRef.current?.contains(e.target as Node)) setStatusOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStatusOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [statusOpen]);

  const runStatusAction = (action: () => void) => {
    setStatusOpen(false);
    action();
  };

  return (
    <div
      id={`ms-${milestone.id}`}
      data-task-id={milestone.id}
      className={`overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-colors ${
        highlighted ? 'ring-2 ring-[#4648d4]/20' : ''
      }`}
    >
      {isMobile ? <div className="flex items-center gap-1 px-3 py-2">
        <button onClick={() => onOpenFocus(milestone.id)} aria-label={'Open task ' + milestone.title} className="min-w-0 flex-1 py-2 text-left"><span className="block text-sm font-semibold leading-5 text-slate-800">{milestone.title}</span><span className="mt-1 block text-xs text-slate-500">{subtasks.length} subtasks · {statusLabel}{effectiveDueDate ? ' · Due ' + effectiveDueDate.slice(5,10) : ''}</span></button>
        <button onClick={() => setActionsOpen(true)} aria-label={'Options for task ' + milestone.title} className="mobile-icon-button text-slate-400"><MoreHorizontal size={18} /></button>
        <button onClick={() => setExpanded(value => !value)} aria-label={(expanded ? 'Collapse' : 'Expand') + ' subtasks of ' + milestone.title} aria-expanded={expanded} className="mobile-icon-button text-slate-500">{expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>
      </div> : <div
        className="mobile-milestone-header group/mshdr w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#f8f9fa] transition-colors cursor-pointer select-none"
        onClick={() => setExpanded(v => !v)}
      >
        <span className="text-gray-400 hover:text-[#4648d4] transition-colors shrink-0">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotCls}`} />
        <span className="flex-1 min-w-0" onClick={e => e.stopPropagation()}>
          <InlineTitle
            value={milestone.title}
            onSave={title => updateTask(milestone.id, { title })}
            className="text-xs font-mono font-bold uppercase tracking-wide text-gray-800"
          />
        </span>
        {/* Status badge */}
        <span
          ref={statusRef}
          className="relative shrink-0"
          onClick={e => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => setStatusOpen(v => !v)}
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-opacity hover:opacity-80 ${badgeCls}`}
            aria-haspopup="menu"
            aria-expanded={statusOpen}
          >
            {statusLabel}
            <ChevronDown size={9} className={`transition-transform ${statusOpen ? 'rotate-180' : ''}`} />
          </button>
          {statusOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-40 mt-1 flex min-w-[128px] flex-col rounded-lg border border-gray-100 bg-white py-1 shadow-lg"
            >
              {dynStatus !== 'In Progress' && dynStatus !== 'Completed' && (
                <button onClick={() => runStatusAction(() => onResume(milestone))}
                  className="px-3 py-1.5 text-left text-[11px] font-medium text-[#4648d4] transition-colors hover:bg-[#EEF2FF]">
                  {dynStatus === 'On Hold' ? 'Resume' : 'Start'}
                </button>
              )}
              {dynStatus === 'In Progress' && (
                <button onClick={() => runStatusAction(() => onDeactivate(milestone))}
                  className="px-3 py-1.5 text-left text-[11px] font-medium text-amber-500 transition-colors hover:bg-amber-50">
                  Pause
                </button>
              )}
              {dynStatus !== 'Completed' && (
                <button onClick={() => runStatusAction(() => onToggleSubtask(milestone))}
                  className="px-3 py-1.5 text-left text-[11px] font-medium text-emerald-600 transition-colors hover:bg-emerald-50">
                  Mark complete
                </button>
              )}
              {dynStatus === 'Completed' && (
                <button onClick={() => runStatusAction(() => onToggleSubtask(milestone))}
                  className="px-3 py-1.5 text-left text-[11px] font-medium text-gray-600 transition-colors hover:bg-gray-50">
                  Reopen
                </button>
              )}
            </div>
          )}
        </span>
        <span className="text-[10px] font-mono text-gray-400 shrink-0">{subtasks.length}</span>
        <span onClick={e => e.stopPropagation()}>
          <DeadlinePill
            value={effectiveDueDate}
            label="milestone deadline"
            onSave={d => onUpdateDeadline(milestone.id, d)}
            completedAt={completedAt}
            inherited={Boolean(inheritedDueDate)}
          />
        </span>
        <span onClick={e => e.stopPropagation()}>
          <InlineTimePill
            task={milestone}
            allTasks={allTasks}
            onSave={m => onUpdateTime(milestone.id, m)}
            onSaveRollupMode={mode => onUpdateTimeRollupMode(milestone.id, mode)}
          />
        </span>
        <button
          onClick={e => { e.stopPropagation(); onOpenFocus(milestone.id); }}
          className="mobile-open-task text-gray-300 hover:text-[#4648d4] transition-colors p-1 rounded"
          title="Open focus page"
          aria-label={`Open task ${milestone.title}`}
        >
          <FileText size={13} /><span className="md:hidden">Open</span>
        </button>
        <button
          onClick={e => { e.stopPropagation(); onDelete(milestone); }}
          className="text-gray-200 hover:text-red-400 transition-colors p-1 rounded"
          title="Delete section"
        >
          <Trash2 size={12} />
        </button>
      </div>}
      {actionsOpen && <MobileSheet title="Task actions" onClose={() => setActionsOpen(false)}>
        <p className="mb-3 text-sm text-slate-500">{milestone.title}</p>
        <button onClick={() => { setActionsOpen(false); onOpenFocus(milestone.id); }} className="min-h-14 w-full text-left text-sm">Edit task & dates</button>
        <button onClick={() => { setActionsOpen(false); onToggleSubtask(milestone); }} className="min-h-14 w-full text-left text-sm text-emerald-700">{dynStatus === 'Completed' ? 'Reopen task' : 'Mark complete'}</button>
        <button onClick={() => { setActionsOpen(false); dynStatus === 'In Progress' ? onDeactivate(milestone) : onResume(milestone); }} className="min-h-14 w-full text-left text-sm">{dynStatus === 'In Progress' ? 'Pause task' : 'Start / resume task'}</button>
        <button onClick={() => { setActionsOpen(false); onDelete(milestone); }} className="min-h-14 w-full text-left text-sm text-red-600">Delete task</button>
      </MobileSheet>}

      {/* Expanded body */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 border-t border-gray-100 pt-2">
              {/* Subtasks */}
              {isMobile ? <div>{rivers.flat().map(sub => (
                  <TaskTreeRow
                    key={sub.id} task={sub}
                    allTasks={allTasks}
                    childrenByParent={subtasksByParent}
                    taskResources={taskResources}
                    onToggleSubtask={onToggleSubtask}
                    onDeleteSubtask={onDeleteSubtask}
                    onUpdateSubtaskTitle={onUpdateSubtaskTitle}
                    onAddSubtask={onAddSubtask}
                    onAttachResource={onAttachResource}
                    onAttachFiles={onAttachFiles}
                    onDeleteResource={onDeleteResource}
                    onDeactivate={onDeactivate}
                    onResume={onResume}
                    onOpenFocus={onOpenFocus}
                    onUpdateDeadline={onUpdateDeadline}
                    onUpdateTime={onUpdateTime}
                    onUpdateTimeRollupMode={onUpdateTimeRollupMode}
                    onUpdateActualTime={onUpdateActualTime}
                    sequenceLocked={!sub.completed && (blockerIdsByTask.get(sub.id) ?? []).some(id => { const blocker = taskById.get(id); return blocker && !blocker.completed && blocker.status !== 'done'; })}
                  />))}</div> : subtasks.length > 1 ? (
                <DndContext
                  sensors={riverSensors}
                  collisionDetection={closestCenter}
                  onDragStart={event => setDraggedRiverTask(taskById.get(String(event.active.id).replace('river-drag:', '')) ?? null)}
                  onDragCancel={() => setDraggedRiverTask(null)}
                  onDragEnd={handleRiverDragEnd}
                >
                <div className="mb-3">
                  {draggedRiverTask && <div className="mb-2"><IndependentRiverDropZone milestoneId={milestone.id} /></div>}
                  <div className="space-y-3">
                  {rivers.map((river, riverIndex) => (
                    <div key={river[0].id} className={`min-w-0 ${riverIndex > 0 ? 'border-t border-gray-100 pt-2' : ''}`}>
                      {rivers.length > 1 && river.length > 1 && (
                        <div className="mb-1 px-8 font-mono text-[8px] text-gray-300">
                          Sequence {riverIndex + 1}
                        </div>
                      )}
                  {river.map((sub, index) => {
                    const done = sub.completed || sub.status === 'done';
                    const blockerIds = blockerIdsByTask.get(sub.id) ?? [];
                    const locked = !done && blockerIds.some(id => {
                      const blocker = taskById.get(id);
                      return blocker && !blocker.completed && blocker.status !== 'done';
                    });
                    const current = !done && !locked;
                    return (
                    <div key={sub.id} className="relative flex gap-2">
                      <div className="flex w-6 shrink-0 flex-col items-center">
                        <span className={`z-10 flex h-5 w-5 items-center justify-center rounded-full border text-[8px] font-mono font-bold ${
                          done ? 'border-emerald-400 bg-emerald-500 text-white' : current ? 'border-[#4648d4] bg-[#4648d4] text-white shadow-[0_0_0_3px_rgba(70,72,212,0.12)]' : 'border-gray-200 bg-white text-gray-300'
                        }`}>{done ? <Check size={10} /> : index + 1}</span>
                        {index < river.length - 1 && <span className={`min-h-5 w-px flex-1 ${done ? 'bg-emerald-300' : 'bg-gray-200'}`} />}
                      </div>
                      <div className={`min-w-0 flex-1 pb-1 ${locked ? 'opacity-60' : ''}`}>
                        <div className="flex items-center gap-2 px-1">
                          {current && <span className="text-[8px] font-mono font-bold uppercase tracking-widest text-[#4648d4]">Ready now</span>}
                          {locked && <span className="text-[8px] font-mono font-bold uppercase tracking-widest text-gray-400">Waiting</span>}
                        </div>
                        <RiverTaskConnector
                          task={sub}
                          blocker={blockerIds[0] ? taskById.get(blockerIds[0]) ?? null : null}
                          stepNumber={index + 1}
                          showStepLabel={river.length > 1}
                          onDetach={() => void onSetDependency(sub.id, null)}
                        />
                        <TaskTreeRow
                      task={sub}
                      allTasks={allTasks}
                      childrenByParent={subtasksByParent}
                      taskResources={taskResources}
                      onToggleSubtask={onToggleSubtask}
                      onDeleteSubtask={onDeleteSubtask}
                      onUpdateSubtaskTitle={onUpdateSubtaskTitle}
                      onAddSubtask={onAddSubtask}
                      onAttachResource={onAttachResource}
                      onAttachFiles={onAttachFiles}
                      onDeleteResource={onDeleteResource}
                      onDeactivate={onDeactivate}
                      onResume={onResume}
                      onOpenFocus={onOpenFocus}
                      onUpdateDeadline={onUpdateDeadline}
                      onUpdateTime={onUpdateTime}
                      onUpdateTimeRollupMode={onUpdateTimeRollupMode}
                      onUpdateActualTime={onUpdateActualTime}
                      sequenceLocked={locked}
                    />
                      </div>
                    </div>
                  )})}
                    </div>
                  ))}
                  </div>
                </div>
                <DragOverlay>
                  {draggedRiverTask ? (
                    <div className="max-w-64 rounded-lg border border-[#4648d4]/30 bg-white px-3 py-2 text-xs font-semibold text-gray-700 shadow-xl">
                      <span className="mr-2 text-[#4648d4]">Move</span>{draggedRiverTask.title}
                    </div>
                  ) : null}
                </DragOverlay>
                </DndContext>
              ) : subtasks.length === 1 ? (
                <div className="mb-3 rounded-xl border border-gray-200 bg-white px-2 py-1 shadow-sm">
                  <TaskTreeRow
                    task={subtasks[0]}
                    allTasks={allTasks}
                    childrenByParent={subtasksByParent}
                    taskResources={taskResources}
                    onToggleSubtask={onToggleSubtask}
                    onDeleteSubtask={onDeleteSubtask}
                    onUpdateSubtaskTitle={onUpdateSubtaskTitle}
                    onAddSubtask={onAddSubtask}
                    onAttachResource={onAttachResource}
                    onAttachFiles={onAttachFiles}
                    onDeleteResource={onDeleteResource}
                    onDeactivate={onDeactivate}
                    onResume={onResume}
                    onOpenFocus={onOpenFocus}
                    onUpdateDeadline={onUpdateDeadline}
                    onUpdateTime={onUpdateTime}
                    onUpdateTimeRollupMode={onUpdateTimeRollupMode}
                    onUpdateActualTime={onUpdateActualTime}
                    sequenceLocked={false}
                  />
                </div>
              ) : (
                <p className="text-[11px] text-gray-300 italic mb-3">No subtasks yet.</p>
              )}

              {/* Add subtask */}
              <GhostTaskRow
                onAdd={title => onAddSubtask(milestone.id, title)}
                placeholder="Add a task…"
                getSuggestions={input => generateSuggestions(goalTitle, category, milestone.title, input, subtasks.map(s => s.title))}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Goal resources (collapsible) ────────────────────────────────────────────
function GoalResourcesSection({
  resources,
  goalFileInputRef,
  onUploadFiles,
  onDrop,
  onAddLink,
  onDeleteResource,
}: {
  resources: DBResource[];
  goalFileInputRef: React.RefObject<HTMLInputElement | null>;
  onUploadFiles: (files: FileList | null) => Promise<void>;
  onDrop: (e: React.DragEvent) => Promise<void>;
  onAddLink: () => void;
  onDeleteResource: (id: string) => void;
}) {
  const { navigateToResource } = useAppStore();
  const [open, setOpen] = useState(resources.length > 0);

  return (
    <section>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 group"
      >
        <FolderOpen size={13} className="text-gray-400 shrink-0" />
        <span className="font-headline text-sm font-bold text-gray-900 flex-1 text-left">Goal Resources</span>
        {resources.length > 0 && (
          <span className="font-mono text-[9px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full shrink-0">
            {resources.length}
          </span>
        )}
        <span className="text-gray-300 group-hover:text-gray-500 transition-colors ml-1 shrink-0">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="pt-3 space-y-1.5">
              {/* Compact drop / upload strip */}
              <input
                ref={goalFileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={async (e) => { await onUploadFiles(e.currentTarget.files); e.currentTarget.value = ''; }}
              />
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
                onClick={() => goalFileInputRef.current?.click()}
                className="flex items-center gap-2 border border-dashed border-gray-200 hover:border-[#4648d4]/40 rounded-lg px-3 py-2 bg-[#f8f9fa] hover:bg-white transition-all cursor-pointer group/drop"
              >
                <Upload size={11} className="text-gray-300 group-hover/drop:text-[#4648d4] shrink-0 transition-colors" />
                <span className="text-[10px] font-mono text-gray-400 flex-1">Drop files or click to upload</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onAddLink(); }}
                  className="text-[9px] font-mono text-gray-400 hover:text-[#4648d4] transition-colors shrink-0"
                >
                  + link
                </button>
              </div>

              {/* Resource rows — compact */}
              {resources.map(r => (
                <div
                  key={r.id}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-gray-100 hover:border-gray-200 bg-white group/res transition-colors"
                >
                  {r.type === 'figma'
                    ? <span className="text-red-500 font-bold font-mono text-[9px] border border-red-200 bg-red-50 px-1 py-0.5 rounded shrink-0">F</span>
                    : <FileText size={11} className="text-gray-300 shrink-0" />}
                  <button
                    onClick={() => navigateToResource(r.id)}
                    className="text-[11px] text-gray-700 truncate flex-1 min-w-0 text-left hover:text-[#4648d4] transition-colors"
                  >{r.title}</button>
                  {r.info && (
                    <span className="text-[9px] font-mono text-gray-300 shrink-0 opacity-0 group-hover/res:opacity-100 transition-opacity">{r.info}</span>
                  )}
                  <button
                    onClick={() => onDeleteResource(r.id)}
                    className="text-gray-200 hover:text-red-400 transition-colors shrink-0 opacity-0 group-hover/res:opacity-100"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

// ─── Sortable task row wrapper (DnD handle) ───────────────────────────────────
function SortableTaskRow(props: Parameters<typeof TaskTreeRow>[0]) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.task.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="relative group/sortable rounded-xl border border-slate-200 bg-white px-4 py-2 shadow-sm"
    >
      <button
        {...attributes}
        {...listeners}
        className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-5 p-0.5 text-gray-300 opacity-0 group-hover/sortable:opacity-100 transition-opacity cursor-grab active:cursor-grabbing hover:text-gray-500 touch-none"
        tabIndex={-1}
        title="Drag to reorder"
      >
        <GripVertical size={12} />
      </button>
      <TaskTreeRow {...props} />
    </div>
  );
}

// ─── Goal Time Panel ─────────────────────────────────────────────────────────
function GoalTimePanel({ tasks }: { tasks: DBTask[] }) {
  const stats = computeGoalTimeStats(tasks);
  const { spentMinutes, adjustedRemainingMinutes, velocityRatio, velocityConfidence, totalEstimatedMinutes } = stats;

  const projectedTotalMinutes =
    adjustedRemainingMinutes !== null ? spentMinutes + adjustedRemainingMinutes :
    totalEstimatedMinutes !== null    ? totalEstimatedMinutes :
    null;

  const spentPct = projectedTotalMinutes && projectedTotalMinutes > 0
    ? Math.min(100, Math.round((spentMinutes / projectedTotalMinutes) * 100))
    : 0;

  if (stats.taskCount === 0) return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-1.5 mb-3">
        <Clock size={12} className="text-[#4648d4]" />
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-[#4648d4]">Time Intelligence</span>
        {velocityConfidence !== 'none' && (
          <span className="ml-auto font-mono text-[9px] text-gray-400 capitalize">{velocityConfidence} confidence</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-3">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-widest text-gray-400 mb-0.5">Spent</p>
          <p className="text-sm font-bold text-gray-900">{spentMinutes > 0 ? formatTaskTime(spentMinutes) : '—'}</p>
          <p className="font-mono text-[9px] text-gray-400">{stats.completedWithActual} logged</p>
        </div>
        <div>
          <p className="font-mono text-[9px] uppercase tracking-widest text-gray-400 mb-0.5">Remaining</p>
          <p className="text-sm font-bold text-gray-900">
            {adjustedRemainingMinutes != null ? formatTaskTime(adjustedRemainingMinutes) : '—'}
          </p>
          {velocityRatio !== null && adjustedRemainingMinutes !== stats.estimatedRemainingMinutes && (
            <p className="font-mono text-[9px] text-gray-400">adjusted</p>
          )}
          {adjustedRemainingMinutes === stats.estimatedRemainingMinutes && stats.estimatedRemainingMinutes !== null && (
            <p className="font-mono text-[9px] text-gray-400">estimated</p>
          )}
        </div>
        <div>
          <p className="font-mono text-[9px] uppercase tracking-widest text-gray-400 mb-0.5">Velocity</p>
          {velocityRatio !== null ? (
            <>
              <p className={`text-sm font-bold ${velocityColor(velocityRatio)}`}>{velocityRatio.toFixed(2)}×</p>
              <p className={`font-mono text-[9px] ${velocityColor(velocityRatio)}`}>{formatVelocity(velocityRatio)}</p>
            </>
          ) : (
            <>
              <p className="text-sm font-bold text-gray-300">—</p>
              <p className="font-mono text-[9px] text-gray-300">complete tasks to see</p>
            </>
          )}
        </div>
        <div>
          <p className="font-mono text-[9px] uppercase tracking-widest text-gray-400 mb-0.5">Est. Total</p>
          <p className="text-sm font-bold text-gray-900">
            {projectedTotalMinutes != null ? formatTaskTime(projectedTotalMinutes) : '—'}
          </p>
          <p className="font-mono text-[9px] text-gray-400">
            {stats.tasksWithEstimate}/{stats.taskCount} tasks timed
          </p>
        </div>
      </div>

      {projectedTotalMinutes != null && projectedTotalMinutes > 0 && (
        <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden mb-2">
          <div
            className="h-full rounded-full bg-[#4648d4] transition-all duration-700"
            style={{ width: `${spentPct}%` }}
          />
        </div>
      )}

      {(() => {
        const finishDate = projectedFinishDate(stats);
        if (!finishDate) return null;
        return (
          <p className="font-mono text-[10px] text-gray-400 flex items-center gap-1.5">
            <span>At your pace:</span>
            <span className="font-bold text-gray-700">done by {formatProjectedDate(finishDate)}</span>
          </p>
        );
      })()}
    </div>
  );
}

// ─── Deadline Modal ───────────────────────────────────────────────────────────
const DEADLINE_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#10b981',
  '#3b82f6', '#8b5cf6', '#ec4899', '#6366f1',
];

function DeadlineModal({
  initial,
  onSave,
  onClose,
}: {
  initial?: DBDeadline;
  onSave: (d: { title: string; date: string; color: string }) => Promise<void>;
  onClose: () => void;
}) {
  const [title,   setTitle]   = useState(initial?.title ?? '');
  const [date,    setDate]    = useState(initial?.date  ?? '');
  const [color,   setColor]   = useState(initial?.color ?? '#ef4444');
  const [saving,  setSaving]  = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !date) return;
    setSaving(true);
    await onSave({ title: title.trim(), date, color });
    setSaving(false);
  };

  return (
    <ModalFrame titleId="deadline-form-title" onClose={onClose} className="w-full max-w-md rounded-xl bg-[#1a1a2e] shadow-2xl"><h2 id="deadline-form-title" className="sr-only">Deadline</h2>
      <form
        className="bg-[#1a1a2e] border border-gray-700 rounded-xl p-5 w-full flex flex-col gap-3 shadow-2xl"
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-bold text-white">{initial ? 'Edit Deadline' : 'New Deadline'}</span>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-white"><X size={16} /></button>
        </div>
        <input
          autoFocus
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#6063ee]"
          placeholder="Deadline name (e.g. Alpha Review)"
          value={title}
          onChange={e => setTitle(e.target.value)}
          required
        />
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">Date</label>
          <input
            type="date"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#6063ee] [color-scheme:dark]"
            value={date}
            onChange={e => setDate(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">Color</label>
          <div className="flex gap-2 flex-wrap">
            {DEADLINE_COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className="w-6 h-6 rounded-full border-2 transition-transform hover:scale-110"
                style={{ backgroundColor: c, borderColor: color === c ? 'white' : 'transparent' }}
              />
            ))}
          </div>
        </div>
        <div className="flex gap-2 justify-end mt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-xs text-gray-400 hover:text-white">Cancel</button>
          <button
            type="submit"
            disabled={saving || !title.trim() || !date}
            className="px-4 py-2 text-xs rounded-lg font-semibold text-white disabled:opacity-40 transition-colors"
            style={{ backgroundColor: color }}
          >
            {saving ? 'Saving…' : initial ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}

// ─── Deadline Card ─────────────────────────────────────────────────────────────
function DeadlineCard({
  deadline,
  tasks,
  allTasks,
  onEdit,
  onDelete,
  onAssign,
  onUnassign,
  onAddTask,
}: {
  deadline: DBDeadline;
  tasks: DBTask[];          // tasks assigned to this deadline
  allTasks: DBTask[];       // all goal tasks (for assign dropdown)
  onEdit: () => void;
  onDelete: () => void;
  onAssign: (taskId: string) => void;
  onUnassign: (taskId: string) => void;
  onAddTask: (title: string) => void;
}) {
  const spotlightDeadlineId = useAppStore(s => s.spotlightDeadlineId);
  const [showAssign,   setShowAssign]   = useState(false);
  const [addingTask,   setAddingTask]   = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [collapsed,    setCollapsed]    = useState(false);
  const assignRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showAssign) return;
    const handler = (e: MouseEvent) => {
      if (assignRef.current && !assignRef.current.contains(e.target as Node)) setShowAssign(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAssign]);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dl    = new Date(deadline.date);
  const daysLeft = Math.ceil((dl.getTime() - today.getTime()) / 86400000);
  const isPast   = daysLeft < 0;
  const isToday  = daysLeft === 0;
  const isSoon   = daysLeft > 0 && daysLeft <= 3;

  const done  = tasks.filter(t => t.completed || t.status === 'done').length;
  const total = tasks.length;
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  const highlighted = spotlightDeadlineId === deadline.id;

  const unassigned = allTasks.filter(t =>
    !t.completed &&
    !(t.deadline_id) &&
    !tasks.find(dt => dt.id === t.id)
  );

  const dateLabel = dl.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const countdownLabel = isPast
    ? `${Math.abs(daysLeft)}d overdue`
    : isToday ? 'Today'
    : `${daysLeft}d left`;

  return (
    <div
      data-deadline-id={deadline.id}
      className={`overflow-hidden rounded-xl border transition-colors ${highlighted ? 'ring-2 ring-[#4648d4]/20' : ''}`}
      style={{ borderColor: deadline.color + '44' }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer select-none"
        style={{ backgroundColor: deadline.color + '12' }}
        onClick={() => setCollapsed(c => !c)}
      >
        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: deadline.color }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-gray-900 leading-tight">{deadline.title}</span>
            <span className="text-[10px] font-mono text-gray-500">{dateLabel}</span>
            <span
              className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-full ${
                isPast ? 'bg-red-100 text-red-600' : isToday ? 'bg-amber-100 text-amber-700' : isSoon ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-500'
              }`}
            >
              {countdownLabel}
            </span>
          </div>
          {total > 0 && (
            <div className="flex items-center gap-2 mt-1">
              <div className="flex-1 h-1 rounded-full bg-gray-200 overflow-hidden" style={{ maxWidth: 80 }}>
                <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: deadline.color }} />
              </div>
              <span className="text-[9px] font-mono text-gray-400">{done}/{total} done</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
          <button onClick={onEdit} className="p-1 text-gray-400 hover:text-gray-700 transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          </button>
          <button onClick={onDelete} className="p-1 text-gray-400 hover:text-red-500 transition-colors"><Trash2 size={12} /></button>
          <div className="w-4 h-4 flex items-center justify-center text-gray-400">
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </div>
        </div>
      </div>

      {/* Body */}
      {!collapsed && (
        <div className="px-3 py-2 bg-white">
          {/* Assigned tasks */}
          {tasks.length === 0 && !addingTask && (
            <p className="text-[11px] text-gray-400 italic py-1">No tasks assigned yet.</p>
          )}
          <div className="flex flex-col">
            {tasks.map(t => {
              const isDone = t.completed || t.status === 'done';
              return (
                <div key={t.id} className="flex items-center gap-2 py-1.5 group/dt border-b border-gray-50 last:border-0">
                  <span className={`text-xs font-mono shrink-0 ${isDone ? 'text-emerald-500' : 'text-gray-400'}`}>
                    {isDone ? '✓' : t.status === 'in_progress' ? '▶' : '○'}
                  </span>
                  <span className={`text-xs flex-1 min-w-0 truncate ${isDone ? 'text-gray-400 line-through' : 'text-gray-700'}`}>
                    {t.title}
                  </span>
                  {t.kind === 'critical_path' && (
                    <span className="text-[9px] font-mono text-indigo-400 bg-indigo-50 px-1 rounded shrink-0">milestone</span>
                  )}
                  {t.due_date && (
                    <span className="text-[9px] font-mono text-gray-400 shrink-0">
                      {new Date(t.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                  <button
                    onClick={() => onUnassign(t.id)}
                    className="opacity-0 group-hover/dt:opacity-100 p-0.5 text-gray-300 hover:text-red-400 transition-all shrink-0"
                    title="Remove from deadline"
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* New task inline */}
          {addingTask && (
            <form
              className="flex items-center gap-2 mt-1 py-1"
              onSubmit={async e => {
                e.preventDefault();
                if (!newTaskTitle.trim()) return;
                await onAddTask(newTaskTitle.trim());
                setNewTaskTitle('');
                setAddingTask(false);
              }}
            >
              <span className="text-xs text-gray-400 font-mono">○</span>
              <input
                autoFocus
                className="flex-1 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1 outline-none focus:border-indigo-400"
                placeholder="Task title…"
                value={newTaskTitle}
                onChange={e => setNewTaskTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { setAddingTask(false); setNewTaskTitle(''); } }}
              />
              <button type="submit" className="text-[10px] text-indigo-600 font-semibold hover:text-indigo-700">Add</button>
              <button type="button" onClick={() => { setAddingTask(false); setNewTaskTitle(''); }} className="text-[10px] text-gray-400">Cancel</button>
            </form>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-3 mt-2 pt-1.5 border-t border-gray-50">
            <button
              onClick={() => { setAddingTask(true); setShowAssign(false); }}
              className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-indigo-600 transition-colors font-medium"
            >
              <Plus size={11} /> New task
            </button>
            <div className="relative" ref={assignRef}>
              <button
                onClick={() => setShowAssign(s => !s)}
                className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-indigo-600 transition-colors font-medium"
              >
                <ChevronDown size={11} /> Assign existing
              </button>
              {showAssign && (
                <div className="absolute bottom-full mb-1 left-0 bg-white border border-gray-200 rounded-xl shadow-xl z-30 w-64 max-h-48 overflow-y-auto py-1">
                  {unassigned.length === 0 ? (
                    <p className="text-[11px] text-gray-400 px-3 py-2">All tasks are assigned</p>
                  ) : (
                    unassigned.map(t => (
                      <button
                        key={t.id}
                        onClick={() => { onAssign(t.id); setShowAssign(false); }}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-indigo-50 flex items-center gap-2"
                      >
                        <span className="text-gray-400 font-mono">{t.kind === 'critical_path' ? '◆' : '○'}</span>
                        <span className="text-gray-700 truncate">{t.title}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Meeting Modal ────────────────────────────────────────────────────────────
function MeetingModal({
  initial,
  onSave,
  onClose,
}: {
  initial?: DBMeeting;
  onSave: (data: { title: string; scheduled_at: string; location: string; notes: string }) => Promise<void>;
  onClose: () => void;
}) {
  const [title,        setTitle]        = useState(initial?.title        ?? '');
  const [scheduledAt,  setScheduledAt]  = useState(initial?.scheduled_at ?? '');
  const [location,     setLocation]     = useState(initial?.location     ?? '');
  const [meetingNotes, setMeetingNotes] = useState(initial?.notes        ?? '');
  const [saving,       setSaving]       = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !scheduledAt) return;
    setSaving(true);
    await onSave({ title: title.trim(), scheduled_at: scheduledAt, location: location.trim(), notes: meetingNotes.trim() });
    setSaving(false);
  };

  return (
    <ModalFrame titleId="meeting-form-title" onClose={onClose} className="w-full max-w-md rounded-xl bg-[#1a1a2e] shadow-2xl"><h2 id="meeting-form-title" className="sr-only">Meeting</h2>
      <form
        className="bg-[#1a1a2e] border border-gray-700 rounded-xl p-5 w-full flex flex-col gap-3 shadow-2xl"
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-bold text-white">{initial ? 'Edit Meeting' : 'New Meeting'}</span>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-white transition-colors"><X size={16} /></button>
        </div>

        <input
          autoFocus
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#6063ee]"
          placeholder="Meeting title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          required
        />
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">Date & Time</label>
          <input
            type="datetime-local"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#6063ee] [color-scheme:dark]"
            value={scheduledAt}
            onChange={e => setScheduledAt(e.target.value)}
            required
          />
        </div>
        <input
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#6063ee]"
          placeholder="Location (optional)"
          value={location}
          onChange={e => setLocation(e.target.value)}
        />
        <textarea
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#6063ee] resize-none h-20"
          placeholder="Notes (optional)"
          value={meetingNotes}
          onChange={e => setMeetingNotes(e.target.value)}
        />
        <div className="flex gap-2 justify-end mt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-xs text-gray-400 hover:text-white transition-colors">Cancel</button>
          <button
            type="submit"
            disabled={saving || !title.trim() || !scheduledAt}
            className="px-4 py-2 text-xs bg-[#6063ee] text-white rounded-lg hover:bg-[#7b7ef0] disabled:opacity-40 transition-colors font-semibold"
          >
            {saving ? 'Saving…' : initial ? 'Save Changes' : 'Create Meeting'}
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}

// ─── Goal Detail ──────────────────────────────────────────────────────────────
export function GoalDetail() {
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const {
    selectedGoalId,
    setSelectedGoalId,
    setFocusedTaskId,
    setCurrentTab,
    openAddResourceModal,
    triggerToast,
    setSelectedEventId,
    setIsDrawerOpen,
    showConfirm,
    spotlightTaskId,
    spotlightDeadlineId,
    clearSpotlight,
  } = useAppStore();

  const [editingGoalTitle, setEditingGoalTitle] = useState(false);
  const [goalTitleVal, setGoalTitleVal] = useState('');
  const [quickTaskTitle, setQuickTaskTitle] = useState('');
  const [quickTaskTime, setQuickTaskTime] = useState('');
  const [showTimeField, setShowTimeField] = useState(false);
  const [showProgressTree, setShowProgressTree] = useState(false);
  const goalTitleRef = useRef<HTMLInputElement>(null);
  const goalFileInputRef = useRef<HTMLInputElement>(null);
  const quickTaskRef = useRef<HTMLInputElement>(null);
  const quickTimeRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editingGoalTitle) goalTitleRef.current?.focus(); }, [editingGoalTitle]);

  // Global N shortcut: jump to quick-add when not typing in an input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      quickTaskRef.current?.focus();
      quickTaskRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const { data: goal } = useGoal(selectedGoalId);
  const { data: allTasks = [] } = useGoalTasks(selectedGoalId);
  const { data: taskDependencies = [] } = useGoalTaskDependencies(selectedGoalId);
  const { data: goalResourceList = [] } = useGoalResources(selectedGoalId);
  const { data: meetings   = [] } = useGoalMeetings(selectedGoalId);
  const { data: deadlines  = [] } = useGoalDeadlines(selectedGoalId);
  const { data: goalMilestones = [] } = useGoalMilestones(selectedGoalId);

  useEffect(() => {
    const selector = spotlightTaskId
      ? `[data-task-id="${spotlightTaskId}"]`
      : spotlightDeadlineId
        ? `[data-deadline-id="${spotlightDeadlineId}"]`
        : null;
    if (!selector) return;

    const scrollTimer = window.setTimeout(() => {
      document.querySelector<HTMLElement>(selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
    const clearTimer = window.setTimeout(() => clearSpotlight(), 3600);
    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [spotlightTaskId, spotlightDeadlineId, allTasks.length, deadlines.length, selectedGoalId, clearSpotlight]);

  // Build per-task resources using a single batch fetch (avoids N+1)
  const taskIds = allTasks.map(t => t.id);
  const [taskResourceMap, setTaskResourceMap] = useState<Record<string, DBResource[]>>({});
  useEffect(() => {
    if (taskIds.length === 0) { setTaskResourceMap({}); return; }
    apiFetch<Array<DBResource & { task_id: string }>>(`/api/resources?task_ids=${taskIds.join(',')}`)
      .then(rows => {
        const map: Record<string, DBResource[]> = {};
        for (const row of rows) {
          if (!map[row.task_id]) map[row.task_id] = [];
          map[row.task_id].push(row);
        }
        setTaskResourceMap(map);
      })
      .catch(() => {});
  }, [JSON.stringify(taskIds)]);

  const groupedResources = { goalResources: goalResourceList, taskResources: taskResourceMap };

  const invalidate = useInvalidate();
  const queryClient = useQueryClient();
  const createWorkSession = useCreateWorkSession();

  const patchTaskCaches = (taskId: string, updates: Partial<DBTask> | ((task: DBTask) => Partial<DBTask>)) => {
    queryClient.setQueriesData<DBTask[]>({ queryKey: ['tasks'] }, old => {
      if (!old) return old;
      let changed = false;
      const next = old.map(task => {
        if (task.id !== taskId) return task;
        changed = true;
        const patch = typeof updates === 'function' ? updates(task) : updates;
        return { ...task, ...patch };
      });
      return changed ? next : old;
    });
  };

  // ── Deadline state ─────────────────────────────────────────────────────────
  const [deadlineModal, setDeadlineModal] = useState<{ mode: 'create' } | { mode: 'edit'; deadline: DBDeadline } | null>(null);

  const handleSaveDeadline = async (data: { title: string; date: string; color: string }) => {
    if (!selectedGoalId) return;
    if (deadlineModal?.mode === 'edit') {
      await updateDeadline(deadlineModal.deadline.id, data);
    } else {
      await createDeadline({ goal_id: selectedGoalId, ...data });
    }
    invalidate.deadlines(selectedGoalId);
    setDeadlineModal(null);
  };

  const handleDeleteDeadline = async (id: string) => {
    await deleteDeadline(id);
    invalidate.deadlines(selectedGoalId ?? undefined);
    invalidate.tasks(selectedGoalId ?? undefined);
  };

  const handleAssignTask = async (taskId: string, deadlineId: string | null) => {
    await assignTaskToDeadline(taskId, deadlineId);
    invalidate.tasks(selectedGoalId ?? undefined);
  };

  // ── Meeting state ──────────────────────────────────────────────────────────
  const [meetingModal, setMeetingModal] = useState<{ mode: 'create' } | { mode: 'edit'; meeting: DBMeeting } | null>(null);

  const handleSaveMeeting = async (data: { title: string; scheduled_at: string; location: string; notes: string }) => {
    if (!selectedGoalId) return;
    if (meetingModal?.mode === 'edit') {
      await updateMeeting(meetingModal.meeting.id, data);
    } else {
      await createMeeting({ goal_id: selectedGoalId, ...data });
    }
    invalidate.meetings(selectedGoalId);
    setMeetingModal(null);
  };

  const handleDeleteMeeting = async (id: string) => {
    await deleteMeeting(id);
    invalidate.meetings(selectedGoalId ?? undefined);
  };

  // ── DnD sensors must be called before any conditional return (Rules of Hooks) ──
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  if (!goal) return null;

  // Derive tree
  const milestones  = allTasks.filter(t => t.kind === 'critical_path' && !t.parent_task_id);
  const manualTasks = allTasks.filter(t => t.kind === 'manual' && !t.parent_task_id);
  const aiTasks     = allTasks.filter(t => t.kind === 'ai_generated' && !t.parent_task_id);
  const rootWorkItems = [...milestones, ...manualTasks].sort((a, b) => {
    const aGroup = a.kind === 'critical_path' ? 0 : 1;
    const bGroup = b.kind === 'critical_path' ? 0 : 1;
    return aGroup - bGroup || (a.position ?? 0) - (b.position ?? 0) || a.title.localeCompare(b.title);
  });
  const subtasksByParent: Record<string, DBTask[]> = {};
  allTasks.filter(t => t.parent_task_id).forEach(t => {
    subtasksByParent[t.parent_task_id!] = [...(subtasksByParent[t.parent_task_id!] ?? []), t];
  });

  const dynStatus = computeGoalStatus(goal, allTasks);
  const statusDot = dynStatus === 'Safe' ? 'bg-[#10B981]' : dynStatus === 'Watch' ? 'bg-[#F59E0B]' : 'bg-[#EF4444]';
  const finishEstimate = getGoalFinishEstimate(goal, allTasks);
  const taskMetrics = calculateGoalTaskMetrics(allTasks);

  // ── Goal title edit ──
  const startGoalTitleEdit = () => { setGoalTitleVal(goal.title); setEditingGoalTitle(true); };
  const saveGoalTitle = async () => {
    const t = goalTitleVal.trim();
    if (t && t !== goal.title) { await updateGoal(goal.id, { title: t }); invalidate.goals(); }
    setEditingGoalTitle(false);
  };

  // ── Subtask actions ──
  const handleToggleSubtask = async (task: DBTask) => {
    if (!task.completed) {
      const blockers = taskDependencies
        .filter(edge => edge.relationship === 'blocks' && edge.target_id === task.id)
        .map(edge => allTasks.find(candidate => candidate.id === edge.source_id))
        .filter((candidate): candidate is DBTask => Boolean(candidate));
      const unfinished = blockers.filter(blocker => !blocker.completed && blocker.status !== 'done');
      if (unfinished.length) {
        triggerToast(`Finish ${unfinished.map(blocker => blocker.title).join(', ')} first.`, 'info');
        return;
      }
    }
    const now = new Date().toISOString();
    if (!task.completed) {
      patchTaskCaches(task.id, {
        completed: true,
        status: 'done',
        completion_note: '',
        last_activity_at: now,
        updated_at: now,
      });
      try {
        await completeTask(task.id, '');
        triggerToast('Task completed.', 'success');
      } catch {
        triggerToast('Could not complete task.', 'error');
      } finally {
        invalidate.tasks(selectedGoalId ?? undefined);
      }
    } else {
      patchTaskCaches(task.id, previous => ({
        completed: false,
        status: previous.last_activity_at ? 'in_progress' : 'todo',
        updated_at: now,
      }));
      try {
        await toggleTask(task.id);
        triggerToast('Task reopened.', 'info');
      } catch {
        triggerToast('Could not reopen task.', 'error');
      } finally {
        invalidate.tasks(selectedGoalId ?? undefined);
      }
    }
  };

  const handleDeactivateSubtask = async (task: DBTask) => {
    patchTaskCaches(task.id, { status: 'inactive', updated_at: new Date().toISOString() });
    try {
      await deactivateTask(task.id);
      triggerToast('Task paused.', 'info');
    } catch {
      triggerToast('Could not pause task.', 'error');
    } finally {
      invalidate.tasks(selectedGoalId ?? undefined);
    }
  };

  const handleResumeSubtask = async (task: DBTask) => {
    const unfinishedBlocker = taskDependencies
      .filter(edge => edge.relationship === 'blocks' && edge.target_id === task.id)
      .map(edge => allTasks.find(candidate => candidate.id === edge.source_id))
      .find(blocker => blocker && !blocker.completed && blocker.status !== 'done');
    if (unfinishedBlocker) {
      triggerToast(`Finish ${unfinishedBlocker.title} first.`, 'info');
      return;
    }
    const now = new Date().toISOString();
    patchTaskCaches(task.id, {
      status: task.status === 'in_progress' || task.completed || task.status === 'done' ? task.status : 'in_progress',
      last_activity_at: now,
      updated_at: now,
    });
    try {
      await touchTask(task.id);
      triggerToast(task.status === 'inactive' || task.status === 'paused' ? 'Task resumed.' : 'Task started.', 'info');
    } catch {
      triggerToast('Could not update task status.', 'error');
    } finally {
      invalidate.tasks(selectedGoalId ?? undefined);
    }
  };

  const handleDeleteSubtask = (task: DBTask) => {
    showConfirm(`Delete subtask "${task.title}"?`, async () => {
      await deleteTask(task.id);
      triggerToast('Subtask removed.', 'info');
    });
  };

  const handleUpdateSubtaskTitle = async (taskId: string, title: string) => {
    await updateTask(taskId, { title });
  };

  const handleSetTaskDependency = async (taskId: string, blockerId: string | null) => {
    const oldEdges = taskDependencies.filter(edge => edge.relationship === 'blocks' && edge.target_id === taskId);
    if (blockerId && wouldCreateTaskRiverCycle(taskId, blockerId, taskDependencies)) {
      triggerToast('That drop would create a circular river. Choose an earlier step instead.', 'error');
      return;
    }
    try {
      if (blockerId) {
        if (!oldEdges.some(edge => edge.source_id === blockerId)) {
          await apiPost('/api/edges', {
            source_id: blockerId,
            source_type: 'task',
            target_id: taskId,
            target_type: 'task',
            relationship: 'blocks',
            metadata: JSON.stringify({ origin: 'smart_task_river' }),
          });
        }
      }
      await Promise.all(oldEdges.filter(edge => edge.source_id !== blockerId).map(edge => apiDelete(`/api/edges/${edge.id}`)));
      await queryClient.invalidateQueries({ queryKey: ['task-dependencies', selectedGoalId] });
      triggerToast(blockerId ? 'Task dependency updated.' : 'Task moved to an independent river.', 'success');
    } catch (error) {
      await queryClient.invalidateQueries({ queryKey: ['task-dependencies', selectedGoalId] });
      triggerToast(error instanceof Error ? error.message : 'Could not update dependency.', 'error');
    }
  };

  const handleUpdateDeadline = async (taskId: string, date: string | null) => {
    const violation = getTaskDeadlineViolation(taskId, date, allTasks);
    if (violation) {
      triggerToast(violation, 'error');
      return;
    }
    try {
      await updateTask(taskId, { due_date: date });
    } catch (error) {
      triggerToast(error instanceof Error ? error.message : 'Could not update the deadline.', 'error');
      invalidate.tasks(selectedGoalId ?? undefined);
    }
  };

  const handleUpdateTime = async (taskId: string, minutes: number | null) => {
    await updateTask(taskId, { estimated_minutes: minutes });
  };

  const handleUpdateTimeRollupMode = async (taskId: string, mode: NonNullable<DBTask['time_rollup_mode']>) => {
    await updateTask(taskId, { time_rollup_mode: mode });
  };

  const handleUpdateActualTime = async (taskId: string, minutes: number | null) => {
    if (minutes == null || minutes <= 0) return;
    await createWorkSession.mutateAsync({ task_id: taskId, minutes, source: 'manual' });
  };

  const handleManualTaskDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = manualTasks.map(t => t.id);
    const changed = reorderPositions(ids, String(active.id), String(over.id));
    if (Object.keys(changed).length === 0) return;
    await Promise.all(
      Object.entries(changed).map(([id, pos]) => updateTask(id, { position: pos }))
    );
  };

  const handleAddSubtask = async (milestoneId: string, title: string) => {
    const milestone = allTasks.find(t => t.id === milestoneId);
    if (!milestone) return;
    const pos = (subtasksByParent[milestoneId] ?? []).length;
    await createTask({
      goal_id: goal.id,
      parent_task_id: milestoneId,
      title,
      description: '',
      status: 'todo',
      priority: 'medium',
      kind: 'manual',
      critical_path_status: null,
      tags_json: '[]',
      due_date: null,
      estimated_duration: null,
      estimated_minutes: null,
      completed: false,
      position: pos,
    });
    triggerToast('Subtask added.', 'success');
  };

  const handleQuickAddTask = async () => {
    const title = quickTaskTitle.trim();
    if (!title) return;
    const estimatedMinutes = quickTaskTime.trim()
      ? parseTaskTimeInput(quickTaskTime.trim())
      : null;
    const nextPosition = rootWorkItems.reduce((max, task) => Math.max(max, task.position ?? -1), -1) + 1;

    await createTask({
      goal_id: goal.id,
      parent_task_id: null,
      title,
      description: '',
      status: 'todo',
      priority: 'medium',
      kind: 'critical_path',
      critical_path_status: 'Future',
      tags_json: '[]',
      due_date: null,
      estimated_duration: null,
      estimated_minutes: estimatedMinutes,
      completed: false,
      position: nextPosition,
    });
    setQuickTaskTitle('');
    setQuickTaskTime('');
    setShowTimeField(false);
    quickTaskRef.current?.focus();
    triggerToast('Task added.', 'success');
  };

  const handleAttachResource = async (
    taskId: string,
    title: string,
    url: string | null,
    type: DBResource['type'],
  ) => {
    await createResource({ title, url, type, info: 'attached now' }, goal.id, taskId);
    triggerToast('Resource attached.', 'success');
  };

  const handleAttachFiles = async (taskId: string, files: FileList | null) => {
    const selected = Array.from(files ?? []);
    if (selected.length === 0) return;

    for (const file of selected) {
      await createResource(
        { title: file.name, url: null, type: 'document', info: `${formatBytes(file.size)} from file picker` },
        goal.id,
        taskId,
      );
    }
    triggerToast(`${selected.length} file${selected.length === 1 ? '' : 's'} attached.`, 'success');
  };

  const handleDeleteResource = (resourceId: string) => {
    showConfirm('Remove this resource?', async () => {
      await deleteResource(resourceId);
      triggerToast('Resource removed.', 'info');
    });
  };

  const handleRestoreGoal = async () => {
    await restoreGoal(goal.id);
    invalidate.goals();
    triggerToast('Goal restored with progress intact.', 'success');
  };

  const handleArchiveGoal = () => {
    showConfirm(`Archive goal "${goal.title}"? Your tasks, resources, and progress will be saved.`, async () => {
      await archiveGoal(goal.id);
      invalidate.goals();
      triggerToast('Goal archived. Progress saved.', 'info');
    });
  };

  // ── AI task toggle ──
  const handleToggleAiTask = async (task: DBTask) => {
    await toggleTask(task.id);
    invalidate.tasks(selectedGoalId ?? undefined);
  };

  // ── Goal-level resource drop ──
  const handleGoalFiles = async (files: FileList | null) => {
    const selected = Array.from(files ?? []);
    if (selected.length === 0) return;

    for (const file of selected) {
      await createResource(
        { title: file.name, url: null, type: 'document', info: `${formatBytes(file.size)} from file picker` },
        goal.id,
      );
    }
    triggerToast(`${selected.length} goal file${selected.length === 1 ? '' : 's'} attached.`, 'success');
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    await handleGoalFiles(e.dataTransfer.files);
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
      className="mobile-goal-detail max-w-[860px] mx-auto px-4 md:px-10 py-6"
    >
      {/* Back */}
      <button
        onClick={() => setSelectedGoalId(null)}
        className="mobile-duplicate-back group mb-5 font-mono text-xs uppercase tracking-wider text-gray-400 hover:text-black flex items-center gap-1.5 cursor-pointer"
      >
        <ChevronLeft size={15} className="group-hover:-translate-x-0.5 transition-transform" />
        Back to goals
      </button>

      {/* Header */}
      <header className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-6 border-b border-gray-100 pb-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-gray-400 font-mono text-[10px] uppercase tracking-wider mb-2 font-bold">
            <Folder size={12} />
            {goal.category}
          </div>

          {editingGoalTitle ? (
            <input
              ref={goalTitleRef}
              value={goalTitleVal}
              onChange={e => setGoalTitleVal(e.target.value)}
              onBlur={saveGoalTitle}
              onKeyDown={e => { if (e.key === 'Enter') saveGoalTitle(); if (e.key === 'Escape') setEditingGoalTitle(false); }}
              className="font-headline text-2xl font-black text-gray-900 leading-tight w-full bg-transparent border-b-2 border-[#4648d4] outline-none"
            />
          ) : (
            <h1
              onClick={startGoalTitleEdit}
              className="font-headline text-2xl font-black text-gray-900 leading-tight cursor-text hover:text-[#4648d4] transition-colors"
              title="Click to edit goal title"
            >
              {goal.title}
            </h1>
          )}

          <p className="text-xs text-gray-400 mt-2 flex items-center gap-1 flex-wrap">
            {milestones.length} milestone{milestones.length !== 1 ? 's' : ''}
            {' · '}
            {allTasks.filter(t => t.parent_task_id).length} subtask{allTasks.filter(t => t.parent_task_id).length !== 1 ? 's' : ''}
            {' · '}
            <span
              className="relative cursor-default"
              onMouseEnter={() => setShowProgressTree(true)}
              onMouseLeave={() => setShowProgressTree(false)}
            >
              <span className="underline decoration-dotted underline-offset-2">
                {taskMetrics.completedTasks}/{taskMetrics.totalTasks} tasks done
              </span>
              {taskMetrics.usesExplicitWeights && ' / weighted progress'}
              {showProgressTree && (
                <div className="absolute z-50 top-full left-0 mt-2 bg-gray-950 border border-gray-800 rounded-xl p-3 shadow-2xl min-w-[220px] max-h-[60vh] overflow-y-auto">
                  <p className="text-[8px] font-bold text-gray-600 uppercase tracking-widest mb-2">Task Tree</p>
                  <TaskProgressTree tasks={allTasks} />
                  <div className="border-t border-gray-800 mt-2 pt-2 flex items-center justify-between">
                    <span className="text-[8px] text-gray-600">{taskMetrics.completedTasks} explicitly done</span>
                    <span className="text-[8px] font-mono text-gray-500">{taskMetrics.progress}% by time</span>
                  </div>
                </div>
              )}
            </span>
          </p>

          {/* Topic memberships — the semantic clusters this goal belongs to */}
          {!isMobile && <div className="mt-2.5"><EntityTopicChips entityType="goal" entityId={goal.id} /></div>}
        </div>

        <MobileDisclosure title="Planning & dates" description={`${taskMetrics.progress}% complete · ${finishEstimate.label}`} storageKey="goal-planning"><div className="mobile-goal-status flex items-center gap-4 bg-white rounded-xl p-4 border border-gray-100 shadow-ambient shrink-0">
          {isMobile && <EntityTopicChips entityType="goal" entityId={goal.id} />}
          <DetailRing progress={taskMetrics.progress} status={dynStatus} />
          <div>
            <div className="font-headline text-base font-bold text-gray-900 flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${statusDot}`} />
              {dynStatus}
            </div>
            <div className="font-mono text-[10px] text-gray-400 flex items-center gap-1 mt-1">
              <Calendar size={11} />
              <span className="uppercase tracking-wider">{finishEstimate.caption}</span>
              <span title={finishEstimate.title}>{finishEstimate.label}</span>
            </div>
            <div className="mt-2">
              <GoalPlanningPanel goal={goal} onChanged={() => invalidate.goals()} />
            </div>
            <button
              onClick={goal.archived_at ? handleRestoreGoal : handleArchiveGoal}
              className="mt-3 text-[9px] font-mono uppercase bg-[#f8f9fa] hover:bg-gray-100 text-gray-500 py-1 px-2 rounded border border-gray-200 transition-colors"
            >
              {goal.archived_at ? 'Restore Goal' : 'Archive Goal'}
            </button>
          </div>
        </div></MobileDisclosure>
      </header>

      <div className="mobile-goal-sections space-y-8">
        {/* ── Time Intelligence ── */}
        <MobileDisclosure title="Time & progress" storageKey="goal-time"><GoalTimePanel tasks={allTasks} /></MobileDisclosure>

        {/* ── Archived State ── */}
        {goal.archived_at && (
          <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-bold text-amber-900">Archived goal</p>
              <p className="text-xs text-amber-700 mt-0.5">
                This goal is hidden from Active and Completed, but its tasks, resources, and progress are still saved.
              </p>
            </div>
            <button
              onClick={handleRestoreGoal}
              className="bg-amber-900 text-white text-[10px] font-mono uppercase py-2 px-3 rounded-lg font-bold hover:opacity-90 shrink-0"
            >
              Restore Goal
            </button>
          </section>
        )}

        {/* ── Goal Milestones ── */}
        <MobileDisclosure title="Milestones" description={`${goalMilestones.length} milestones`} storageKey="goal-milestones"><GoalMilestonesSection
          goalId={goal.id}
          milestones={goalMilestones}
          tasks={allTasks}
          onInvalidate={() => invalidate.milestones(goal.id)}
          onInvalidateTasks={() => invalidate.tasks(goal.id)}
        /></MobileDisclosure>

        {/* ── Tasks ── */}
        <section className="mobile-goal-tasks">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="font-headline text-sm font-bold text-gray-900 flex items-center gap-2">
              <CheckSquare size={15} className="text-black" />
              Tasks
              <span className="font-mono text-[10px] text-gray-400 font-normal">
                {taskMetrics.completedTasks}/{taskMetrics.totalTasks}
              </span>
            </h2>

            <div className="flex w-full max-w-sm items-center gap-1.5 sm:w-auto">
              <input
                ref={quickTaskRef}
                value={quickTaskTitle}
                onChange={e => setQuickTaskTitle(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { handleQuickAddTask(); return; }
                  if (e.key === 'Tab') {
                    e.preventDefault();
                    setShowTimeField(true);
                    setTimeout(() => quickTimeRef.current?.focus(), 0);
                  }
                }}
                aria-label="New task title" placeholder="Add a task…"
                className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700 outline-none transition-all placeholder:text-gray-300 focus:border-[#4648d4] focus:ring-2 focus:ring-[#4648d4]/10"
              />
              <AnimatePresence>
                {showTimeField && (
                  <motion.input
                    ref={quickTimeRef}
                    key="time-field"
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: 76, opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    value={quickTaskTime}
                    onChange={e => setQuickTaskTime(e.target.value.replace(/[^\d.hm\s]/gi, ''))}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { handleQuickAddTask(); return; }
                      if (e.key === 'Escape') { setShowTimeField(false); setQuickTaskTime(''); quickTaskRef.current?.focus(); }
                      if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); quickTaskRef.current?.focus(); }
                    }}
                    placeholder="e.g. 2h"
                    className="rounded-lg border border-[#4648d4]/20 bg-[#EEF2FF] px-2.5 py-2 text-xs font-mono text-[#4648d4] outline-none transition-all placeholder:text-[#4648d4]/30 focus:border-[#4648d4] focus:ring-2 focus:ring-[#4648d4]/10"
                    style={{ minWidth: 0 }}
                  />
                )}
              </AnimatePresence>
              <button
                onClick={handleQuickAddTask}
                disabled={!quickTaskTitle.trim()}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-900 text-white transition-all hover:bg-black disabled:cursor-not-allowed disabled:opacity-30"
                title="Add root task" aria-label="Add task to goal"
              >
                <Plus size={13} />
              </button>
            </div>
          </div>

          {milestones.length > 1 && (
            <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1 -mx-1 px-1">
              {milestones.map(m => (
                <button
                  key={m.id}
                  onClick={() => document.getElementById(`ms-${m.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
                  className={`shrink-0 font-mono text-[9px] uppercase tracking-wide px-2.5 py-1 rounded-full border transition-colors ${
                    (() => { const s = deriveMilestoneStatus(m, subtasksByParent[m.id] ?? []);
                      return s === 'Completed'   ? 'border-emerald-200 bg-emerald-50 text-[#10B981]' :
                             s === 'In Progress' ? 'border-[#4648d4]/20 bg-[#4648d4]/5 text-[#4648d4]' :
                             s === 'On Hold'     ? 'border-amber-200 bg-amber-50 text-amber-500' :
                             'border-gray-200 text-gray-400 hover:border-gray-300 hover:text-gray-600';
                    })()
                  }`}
                >
                  {m.title.length > 22 ? m.title.slice(0, 21) + '…' : m.title}
                </button>
              ))}
            </div>
          )}

          <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleManualTaskDragEnd}>
            <SortableContext items={manualTasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
              {rootWorkItems.length === 0 ? (
                <div className="text-center py-8 text-xs text-gray-400 italic border-2 border-dashed border-gray-200 rounded-xl">
                  No tasks yet. Add a root task to start shaping this goal.
                </div>
              ) : (
                <div className="space-y-3">
                  {rootWorkItems.map(item => (
                    <MilestoneCard
                      key={item.id}
                      milestone={item}
                      allTasks={allTasks}
                      subtasksByParent={subtasksByParent}
                      taskResources={groupedResources.taskResources}
                      category={goal.category}
                      goalTitle={goal.title}
                      onToggleSubtask={handleToggleSubtask}
                      onDeleteSubtask={handleDeleteSubtask}
                      onUpdateSubtaskTitle={handleUpdateSubtaskTitle}
                      onAddSubtask={handleAddSubtask}
                      onAttachResource={handleAttachResource}
                      onAttachFiles={handleAttachFiles}
                      onDeleteResource={handleDeleteResource}
                      onDeactivate={handleDeactivateSubtask}
                      onResume={handleResumeSubtask}
                      onOpenFocus={setFocusedTaskId}
                      onUpdateDeadline={handleUpdateDeadline}
                      onUpdateTime={handleUpdateTime}
                      onUpdateTimeRollupMode={handleUpdateTimeRollupMode}
                      onUpdateActualTime={handleUpdateActualTime}
                      dependencies={taskDependencies}
                      onSetDependency={handleSetTaskDependency}
                      onDelete={handleDeleteSubtask}
                    />
                  ))}
                </div>
              )}
            </SortableContext>
          </DndContext>
          </section>

        {/* ── Task Graph ── */}
        {allTasks.length > 0 && (
          <MobileDisclosure title="Task connections" storageKey="goal-graph"><TaskGraphView
            goalId={goal.id}
            goalTitle={goal.title}
            tasks={allTasks}
            onNodeClick={setFocusedTaskId}
          /></MobileDisclosure>
        )}

        {/* ── AI Micro-tasks ── */}
        {aiTasks.length > 0 && (
          <section>
            <h2 className="font-headline text-sm font-bold text-gray-900 flex items-center gap-2 mb-3">
              <Sparkles size={14} className="text-[#4648d4]" />
              AI Micro-tasks
              <NeedsImplementationBadge />
            </h2>
            <div className="bg-[#EEF2FF] rounded-xl border border-[#4648d4]/10 p-4 space-y-2">
              {aiTasks.map(t => (
                <div
                  key={t.id}
                  onClick={() => handleToggleAiTask(t)}
                  className="bg-white rounded-lg p-3 border border-slate-200 flex items-start gap-3 cursor-pointer select-none hover:shadow-sm transition-shadow"
                >
                  <button className="text-gray-300 hover:text-[#4648d4] shrink-0 mt-0.5">
                    {t.completed
                      ? <CheckSquare size={14} className="text-[#4648d4]" />
                      : <Square size={14} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs font-semibold text-gray-800 leading-tight ${t.completed ? 'line-through text-gray-400' : ''}`}>
                      {t.title}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Deadlines ── */}
        <MobileDisclosure title="Deadlines" description={deadlines.length + ' dates'} storageKey="goal-deadlines"><div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-mono uppercase tracking-wider text-gray-400">Deadlines</span>
            <button
              onClick={() => setDeadlineModal({ mode: 'create' })}
              className="flex items-center gap-1.5 text-xs text-[#6063ee] hover:text-indigo-500 transition-colors font-mono"
            >
              <Plus size={13} /> Add Deadline
            </button>
          </div>
          {deadlines.length === 0 ? (
            <p className="text-xs text-gray-400 font-mono">No deadlines. Add one to group tasks by target date.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {deadlines.map(dl => {
                const assigned = allTasks.filter(t => t.deadline_id === dl.id);
                return (
                  <DeadlineCard
                    key={dl.id}
                    deadline={dl}
                    tasks={assigned}
                    allTasks={allTasks}
                    onEdit={() => setDeadlineModal({ mode: 'edit', deadline: dl })}
                    onDelete={() => handleDeleteDeadline(dl.id)}
                    onAssign={async (taskId) => {
                      await handleAssignTask(taskId, dl.id);
                    }}
                    onUnassign={async (taskId) => {
                      await handleAssignTask(taskId, null);
                    }}
                    onAddTask={async (title) => {
                      if (!selectedGoalId) return;
                      const id = await createTask({
                        goal_id: selectedGoalId,
                        parent_task_id: null,
                        title,
                        description: '',
                        status: 'todo',
                        priority: 'medium',
                        kind: 'manual',
                        tags_json: '[]',
                        completed: false,
                        position: allTasks.length,
                      } as Parameters<typeof createTask>[0]);
                      await handleAssignTask(id, dl.id);
                      invalidate.tasks(selectedGoalId);
                    }}
                  />
                );
              })}
            </div>
          )}
        </div></MobileDisclosure>

        {/* ── Meetings ── */}
        <MobileDisclosure title="Meetings" description={meetings.length + ' meetings'} storageKey="goal-meetings"><div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono uppercase tracking-wider text-gray-400">Meetings</span>
            <button
              onClick={() => setMeetingModal({ mode: 'create' })}
              className="flex items-center gap-1.5 text-xs text-[#9b9dff] hover:text-white transition-colors font-mono"
            >
              <Plus size={13} /> Add Meeting
            </button>
          </div>
          {meetings.length === 0 ? (
            <p className="text-xs text-gray-600 font-mono">No meetings. Click "Add Meeting" to attach a deadline event.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {meetings.map(meeting => {
                const dt   = new Date(meeting.scheduled_at);
                const isPast = dt < new Date();
                const dateStr = dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
                const timeStr = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                const prereqTasks = allTasks
                  .filter(t => t.due_date && t.due_date <= meeting.scheduled_at)
                  .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''));
                return (
                  <div
                    key={meeting.id}
                    className={`rounded-xl border p-4 ${isPast ? 'border-gray-700 bg-gray-900/30' : 'border-amber-500/30 bg-amber-500/5'}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <div className={`mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${isPast ? 'bg-gray-800' : 'bg-amber-500/20'}`}>
                          <Calendar size={14} className={isPast ? 'text-gray-500' : 'text-amber-400'} />
                        </div>
                        <div className="min-w-0">
                          <p className={`text-sm font-semibold leading-tight ${isPast ? 'text-gray-400' : 'text-white'}`}>{meeting.title}</p>
                          <p className={`text-xs font-mono mt-0.5 ${isPast ? 'text-gray-600' : 'text-amber-300/80'}`}>
                            {dateStr} · {timeStr}{isPast ? ' (past)' : ''}
                          </p>
                          {meeting.location && (
                            <p className="text-xs text-gray-500 mt-0.5">📍 {meeting.location}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={() => setMeetingModal({ mode: 'edit', meeting })}
                          className="text-gray-500 hover:text-white transition-colors p-1"
                          title="Edit meeting"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                        </button>
                        <button
                          onClick={() => handleDeleteMeeting(meeting.id)}
                          className="text-gray-500 hover:text-red-400 transition-colors p-1"
                          title="Delete meeting"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>

                    {meeting.notes && (
                      <p className="text-xs text-gray-500 mt-2.5 pl-9.5">{meeting.notes}</p>
                    )}

                    {prereqTasks.length > 0 && (
                      <div className="mt-3 pl-9.5">
                        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-600 mb-1.5">Tasks to complete before</p>
                        <div className="flex flex-col gap-1">
                          {prereqTasks.map(t => {
                            const done = t.completed || t.status === 'done';
                            return (
                              <div key={t.id} className="flex items-center gap-2">
                                <span className={`text-xs font-mono ${done ? 'text-emerald-500' : 'text-gray-500'}`}>
                                  {done ? '✓' : '○'}
                                </span>
                                <span className={`text-xs ${done ? 'text-gray-500 line-through' : 'text-gray-300'}`}>{t.title}</span>
                                {t.due_date && (
                                  <span className="text-[10px] font-mono text-gray-600 ml-auto">
                                    due {new Date(t.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div></MobileDisclosure>

        {/* ── Resources ── */}
        <GoalResourcesSection
          resources={groupedResources.goalResources}
          goalFileInputRef={goalFileInputRef}
          onUploadFiles={handleGoalFiles}
          onDrop={handleDrop}
          onAddLink={() => openAddResourceModal(goal.id)}
          onDeleteResource={handleDeleteResource}
        />
      </div>

      {deadlineModal && (
        <DeadlineModal
          initial={deadlineModal.mode === 'edit' ? deadlineModal.deadline : undefined}
          onSave={handleSaveDeadline}
          onClose={() => setDeadlineModal(null)}
        />
      )}

      {meetingModal && (
        <MeetingModal
          initial={meetingModal.mode === 'edit' ? meetingModal.meeting : undefined}
          onSave={handleSaveMeeting}
          onClose={() => setMeetingModal(null)}
        />
      )}

    </motion.div>
  );
}
