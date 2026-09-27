import { useMemo, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, CalendarDays, ChevronRight, FolderTree, PanelLeftClose, Plus, X } from 'lucide-react';
import { TaskTree } from '../../components/TaskTree';
import { buildTaskForest } from '../../utils/taskTree';
import { parseTaskTimeInput } from '../../utils/taskTime';
import type { DBGoal, DBTask } from '../../db/schema';

export interface CalendarTaskDraft {
  title: string;
  goalId: string | null;
  parentTaskId: string | null;
  startDate: string | null;
  estimatedMinutes: number | null;
  dueDate: string | null;
}

/** Kept as an alias for callers that used the old standalone-only composer. */
export type OneOffTaskDraft = CalendarTaskDraft;

type ComposerProps = {
  onCreate: (draft: CalendarTaskDraft) => Promise<void>;
  onCancel: () => void;
  tasks?: DBTask[];
  goals?: DBGoal[];
  defaultStartDate?: string | null;
  variant?: 'inline' | 'modal';
};

export function OneOffTaskComposer({
  onCreate,
  onCancel,
  tasks = [],
  goals = [],
  defaultStartDate = null,
  variant = 'inline',
}: ComposerProps) {
  const [title, setTitle] = useState('');
  const [placement, setPlacement] = useState<'one-off' | 'goal' | 'subtask'>('one-off');
  const [goalId, setGoalId] = useState('');
  const [parentTaskId, setParentTaskId] = useState('');
  const [startDate, setStartDate] = useState(defaultStartDate ?? '');
  const [estimate, setEstimate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const parentOptions = useMemo(
    () => tasks
      .filter(task => !task.completed && task.status !== 'done' && task.goal_id === goalId)
      .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title)),
    [goalId, tasks],
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError('Give the task a title.');
      return;
    }
    const estimatedMinutes = parseTaskTimeInput(estimate);
    if (estimate.trim() && !estimatedMinutes) {
      setError('Use a time like 30m, 1h, or 1h 30m.');
      return;
    }
    if (placement !== 'one-off' && !goalId) {
      setError('Choose the goal this task belongs to.');
      return;
    }
    if (placement === 'subtask' && !parentTaskId) {
      setError('Choose the parent task.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onCreate({
        title: cleanTitle,
        goalId: placement === 'one-off' ? null : goalId,
        parentTaskId: placement === 'subtask' ? parentTaskId : null,
        startDate: startDate || null,
        estimatedMinutes,
        dueDate: dueDate || null,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create the task.');
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className={variant === 'modal' ? 'p-5' : 'border-b border-indigo-100 bg-indigo-50/50 p-3'}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className={variant === 'modal' ? 'font-headline text-lg font-bold text-gray-950' : 'text-[11px] font-bold text-[#33359c]'}>New all-day task</p>
          <p className={`${variant === 'modal' ? 'mt-1 text-xs' : 'text-[9px]'} leading-snug text-indigo-400`}>No fixed clock time. Decide when and how long when you start.</p>
        </div>
        <button type="button" onClick={onCancel} className="rounded p-0.5 text-indigo-300 hover:bg-white hover:text-indigo-600" aria-label="Cancel new task">
          <X size={13} />
        </button>
      </div>

      <label className="block">
        <span className="sr-only">Task title</span>
        <input
          autoFocus
          value={title}
          onChange={event => setTitle(event.target.value)}
          placeholder="What needs doing?"
          className="h-8 w-full rounded-lg border border-indigo-100 bg-white px-2.5 text-xs text-gray-800 outline-none focus:border-[#4648d4]"
        />
      </label>

      <fieldset className="mt-3">
        <legend className="mb-1.5 font-mono text-[8px] font-bold uppercase tracking-wide text-indigo-400">Where it belongs</legend>
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-white p-1 ring-1 ring-indigo-100">
          {([
            ['one-off', 'One-off'],
            ['goal', 'Goal'],
            ['subtask', 'Subtask'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setPlacement(value);
                setError('');
                if (value === 'one-off') {
                  setGoalId('');
                  setParentTaskId('');
                }
              }}
              aria-pressed={placement === value}
              aria-label={value === 'goal' ? 'Attach to goal' : value === 'subtask' ? 'Nest under parent task' : 'Keep as one-off task'}
              className={`rounded-md px-1.5 py-1.5 text-[9px] font-bold transition-colors ${placement === value ? 'bg-[#4648d4] text-white' : 'text-gray-400 hover:bg-indigo-50 hover:text-[#4648d4]'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      {placement !== 'one-off' && (
        <div className={`mt-2 grid gap-2 ${placement === 'subtask' && variant === 'modal' ? 'sm:grid-cols-2' : ''}`}>
          <label className="block">
            <span className="mb-1 block font-mono text-[8px] font-bold uppercase tracking-wide text-indigo-400">Goal</span>
            <select
              aria-label="Task goal"
              value={goalId}
              onChange={event => { setGoalId(event.target.value); setParentTaskId(''); setError(''); }}
              className="h-8 w-full rounded-lg border border-indigo-100 bg-white px-2 text-[10px] text-gray-700 outline-none focus:border-[#4648d4]"
            >
              <option value="">Choose a goal...</option>
              {goals.map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
            </select>
          </label>
          {placement === 'subtask' && (
            <label className="block">
              <span className="mb-1 block font-mono text-[8px] font-bold uppercase tracking-wide text-indigo-400">Parent task</span>
              <select
                aria-label="Parent task"
                value={parentTaskId}
                onChange={event => { setParentTaskId(event.target.value); setError(''); }}
                disabled={!goalId}
                className="h-8 w-full rounded-lg border border-indigo-100 bg-white px-2 text-[10px] text-gray-700 outline-none focus:border-[#4648d4] disabled:bg-gray-50 disabled:text-gray-300"
              >
                <option value="">Choose a parent...</option>
                {parentOptions.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
              </select>
            </label>
          )}
        </div>
      )}

      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 flex items-center gap-1 font-mono text-[8px] font-bold uppercase tracking-wide text-indigo-400"><CalendarDays size={9} /> Calendar day</span>
          <input
            aria-label="Calendar day"
            type="date"
            value={startDate}
            onChange={event => setStartDate(event.target.value)}
            className="h-8 w-full rounded-lg border border-indigo-100 bg-white px-2 text-[10px] text-gray-700 outline-none focus:border-[#4648d4]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[8px] font-bold uppercase tracking-wide text-indigo-400">Estimate (optional)</span>
          <input
            value={estimate}
            onChange={event => setEstimate(event.target.value.replace(/[^\d.hm\s]/gi, ''))}
            placeholder="Decide later"
            className="h-8 w-full rounded-lg border border-indigo-100 bg-white px-2 text-[10px] text-gray-700 outline-none focus:border-[#4648d4]"
          />
        </label>
      </div>

      <label className="mt-2 block">
        <span className="mb-1 block font-mono text-[8px] font-bold uppercase tracking-wide text-indigo-400">Deadline (optional)</span>
        <input
          aria-label="Due date"
          type="date"
          value={dueDate}
          onChange={event => setDueDate(event.target.value)}
          className="h-8 w-full rounded-lg border border-indigo-100 bg-white px-2 text-[10px] text-gray-700 outline-none focus:border-[#4648d4]"
        />
      </label>

      <p className="mt-2 rounded-lg bg-white/75 px-2.5 py-2 text-[9px] leading-4 text-indigo-500">
        It stays in the all-day row. Drag it into the hourly grid to plan a Focus block, or press Play on the task to start recording actual work.
      </p>
      {error && <p role="alert" className="mt-2 text-[10px] text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={saving}
        className="mt-2 flex h-8 w-full items-center justify-center gap-1 rounded-lg bg-[#4648d4] font-mono text-[9px] font-bold uppercase tracking-wider text-white hover:opacity-90 disabled:opacity-50"
      >
        <Plus size={11} /> {saving ? 'Creating...' : startDate ? 'Add all-day task' : 'Create task'}
      </button>
    </form>
  );
}

/**
 * Left drawer of the Schedule, goal-first: pick a goal, get that goal's task
 * tree, drag tasks onto the calendar, or create a task with optional context.
 */
export function TaskTreeDrawer({ tasks, goals, draggableIds, scheduledDates, onCollapse, onCreateTask }: {
  tasks: DBTask[];
  goals: DBGoal[];
  draggableIds: Set<string>;
  scheduledDates: Map<string, string>;
  onCollapse: () => void;
  onCreateTask: (draft: CalendarTaskDraft) => Promise<void>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: 'backlog' });
  const [goalId, setGoalId] = useState<string | null | undefined>(undefined);
  const [creatingTask, setCreatingTask] = useState(false);

  const groups = useMemo(() => buildTaskForest(tasks, goals), [tasks, goals]);
  const active = goalId === undefined ? undefined : groups.find(group => group.goalId === goalId);
  const activeGoal = goalId ? goals.find(goal => goal.id === goalId) : null;
  const scopedTasks = useMemo(() => {
    if (goalId === undefined) return [];
    return tasks.filter(task => (task.goal_id ?? null) === goalId);
  }, [tasks, goalId]);

  return (
    <div
      ref={setNodeRef}
      className={`sticky top-20 flex max-h-[calc(100vh-140px)] flex-col overflow-hidden rounded-xl border bg-white transition-colors ${isOver ? 'border-indigo-400 bg-indigo-50/60 ring-1 ring-indigo-300/50' : 'border-gray-200'}`}
    >
      <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2.5">
        <p className="flex min-w-0 items-center gap-1.5 text-[11px] font-bold text-gray-700">
          {active !== undefined ? (
            <>
              <button onClick={() => setGoalId(undefined)} className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="All goals"><ArrowLeft size={13} /></button>
              <span className="truncate">{active?.goalTitle ?? activeGoal?.title ?? 'Goal'}</span>
            </>
          ) : (
            <><FolderTree size={12} className="shrink-0 text-gray-400" /> Tasks by goal</>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setCreatingTask(value => !value)}
            className={`rounded p-1 transition-colors ${creatingTask ? 'bg-indigo-50 text-[#4648d4]' : 'text-gray-300 hover:bg-indigo-50 hover:text-[#4648d4]'}`}
            title="Create a task, goal task, or subtask"
            aria-label="Create task"
            aria-pressed={creatingTask}
          ><Plus size={13} /></button>
          <button onClick={onCollapse} className="rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-600" title="Hide the task drawer"><PanelLeftClose size={13} /></button>
        </div>
      </div>

      {creatingTask && (
        <OneOffTaskComposer
          tasks={tasks}
          goals={goals}
          onCancel={() => setCreatingTask(false)}
          onCreate={async draft => {
            await onCreateTask(draft);
            setGoalId(draft.goalId);
            setCreatingTask(false);
          }}
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <AnimatePresence mode="wait" initial={false}>
          {active === undefined ? (
            <motion.div key="goals" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}>
              <p className="mb-2 text-[10px] leading-snug text-gray-400">Pick a goal to open its task tree. Drop a task back here to unschedule it.</p>
              <div className="space-y-1">
                {groups.map(group => (
                  <button key={group.goalId ?? '__none__'} onClick={() => setGoalId(group.goalId)} className="flex w-full items-center gap-2 rounded-lg border border-gray-100 px-2.5 py-2 text-left transition-colors hover:border-[#4648d4]/40 hover:bg-indigo-50/50">
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-800">{group.goalTitle}</span>
                    <span className="shrink-0 rounded-full bg-gray-100 px-1.5 font-mono text-[9px] text-gray-500">{group.taskCount}</span>
                    <ChevronRight size={12} className="shrink-0 text-gray-300" />
                  </button>
                ))}
                {groups.length === 0 && <p className="px-1 py-2 text-[11px] text-gray-400">No open tasks anywhere.</p>}
              </div>
            </motion.div>
          ) : (
            <motion.div key={`goal-${goalId}`} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}>
              <p className="mb-2 text-[10px] leading-snug text-gray-400">Drag a task into the all-day row, or onto an hour to make a Focus block.</p>
              <TaskTree tasks={scopedTasks} goals={goals} mode="drag" draggableIds={draggableIds} scheduledDates={scheduledDates} searchPlaceholder="Find a task..." hideGoalHeaders />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
