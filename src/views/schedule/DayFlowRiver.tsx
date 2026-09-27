import { useMemo, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, GripVertical, Lock, Waves } from 'lucide-react';
import type { DBEvent, DBGoal, DBTask } from '../../db/schema';
import type { DBEventTaskLinkFull } from '../../api/hooks';
import { fmtTimeRange, parseLocalDate } from '../../utils/calendar';
import { useAppStore } from '../../store/useAppStore';
import type { CalendarMeeting, PlacedEvent } from './WeekTimeGrid';

type FlowEntry =
  | {
      id: string;
      kind: 'task';
      task: DBTask;
      title: string;
      subtitle: string;
      minutes: number | null;
      orderLabel: string;
      goalId: string | null;
    }
  | {
      id: string;
      kind: 'block';
      title: string;
      subtitle: string;
      minutes: number | null;
      orderLabel: string;
      goalId: string | null;
      taskId: string | null;
    }
  | {
      id: string;
      kind: 'meeting';
      title: string;
      subtitle: string;
      minutes: number | null;
      orderLabel: string;
      goalId: string | null;
    };

function fmtMins(mins: number | null): string {
  if (!mins) return '?';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${m ? ` ${m}m` : ''}`;
}

function dayTitle(date: string): string {
  return parseLocalDate(date).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function SortableFlowTaskCard({ entry, index, onOpenTask }: {
  entry: Extract<FlowEntry, { kind: 'task' }>;
  index: number;
  onOpenTask: (task: DBTask) => void;
}) {
  const sortableId = `flow-task:${entry.task.start_date ?? 'none'}:${entry.task.id}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sortableId });
  const above = index % 2 === 0;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative flex w-44 shrink-0 flex-col ${above ? 'pb-16' : 'pt-16'} ${isDragging ? 'z-20 opacity-60' : 'z-10'}`}
    >
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-12 w-px -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-b from-transparent via-amber-300 to-transparent opacity-70" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-amber-200 bg-white shadow-[0_0_18px_rgba(217,119,6,0.35)]" />
      <article
        className={`relative rounded-lg border border-amber-200 bg-white px-2.5 py-2 shadow-sm ring-1 ring-amber-100/80 ${above ? 'mb-auto' : 'mt-auto'}`}
      >
        <div className="mb-1 flex items-start gap-1.5">
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="mt-0.5 shrink-0 cursor-grab rounded p-0.5 text-amber-500 hover:bg-amber-50 active:cursor-grabbing touch-none"
            title="Drag to reorder this day flow"
            aria-label={`Drag ${entry.title} to reorder this day flow`}
          >
            <GripVertical size={12} />
          </button>
          <button
            type="button"
            onClick={e => {
              if (e.altKey || !entry.goalId) onOpenTask(entry.task);
            }}
            className="min-w-0 flex-1 text-left"
            title={`${entry.title}. Alt-click to open the goal.`}
          >
            <span className="block truncate text-[11px] font-bold text-gray-900">{entry.title}</span>
            <span className="mt-0.5 block truncate text-[9px] text-gray-400">{entry.subtitle}</span>
          </button>
          <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase text-amber-700">
            {fmtMins(entry.minutes)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[8px] font-bold uppercase tracking-wide text-amber-600">{entry.orderLabel}</span>
          <span className="h-1.5 w-8 rounded-full bg-gradient-to-r from-amber-300 to-[#4648d4]/60" />
        </div>
      </article>
    </div>
  );
}

function FixedFlowCard({ entry, index, onOpenLinkedTask }: {
  entry: Exclude<FlowEntry, { kind: 'task' }>;
  index: number;
  onOpenLinkedTask: (taskId: string | null, goalId: string | null) => void;
}) {
  const above = index % 2 === 0;
  const tone = entry.kind === 'meeting'
    ? 'border-purple-200 bg-purple-50/70 text-purple-700'
    : 'border-indigo-200 bg-indigo-50/70 text-[#4648d4]';

  return (
    <div className={`relative flex w-44 shrink-0 flex-col ${above ? 'pb-16' : 'pt-16'}`}>
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-10 w-px -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-b from-transparent via-indigo-200 to-transparent" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-indigo-100 bg-white shadow-[0_0_16px_rgba(70,72,212,0.22)]" />
      <article className={`relative rounded-lg border px-2.5 py-2 shadow-sm ${tone} ${above ? 'mb-auto' : 'mt-auto'}`}>
        <div className="mb-1 flex items-start gap-1.5">
          <Lock size={11} className="mt-0.5 shrink-0 opacity-60" />
          <button
            type="button"
            onClick={() => onOpenLinkedTask(entry.kind === 'block' ? entry.taskId : null, entry.goalId)}
            className="min-w-0 flex-1 text-left"
            title={entry.kind === 'block' ? 'Open linked task or goal' : 'Fixed meeting'}
          >
            <span className="block truncate text-[11px] font-bold">{entry.title}</span>
            <span className="mt-0.5 block truncate text-[9px] opacity-70">{entry.subtitle}</span>
          </button>
          <span className="shrink-0 rounded bg-white/70 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase">
            {fmtMins(entry.minutes)}
          </span>
        </div>
        <span className="font-mono text-[8px] font-bold uppercase tracking-wide opacity-70">{entry.orderLabel}</span>
      </article>
    </div>
  );
}

export function DayFlowRiver({ date, tasks, goals, placedEvents, meetings, linksByEvent, blockDates, taskOrder }: {
  date: string;
  tasks: DBTask[];
  goals: DBGoal[];
  placedEvents: PlacedEvent[];
  meetings: CalendarMeeting[];
  linksByEvent: Map<string, DBEventTaskLinkFull[]>;
  blockDates: Set<string>;
  taskOrder?: string[];
}) {
  const [open, setOpen] = useState(false);
  const { setNodeRef, isOver } = useDroppable({ id: `flow-day:${date}` });
  const { navigateToGoal, setTaskSpotlight, triggerToast } = useAppStore();
  const taskById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
  const goalById = useMemo(() => new Map(goals.map(goal => [goal.id, goal])), [goals]);

  const entries = useMemo<FlowEntry[]>(() => {
    const orderIndex = new Map((taskOrder ?? []).map((taskId, index) => [taskId, index]));
    const dayTasks = tasks
      .filter(task => task.start_date === date && !blockDates.has(`${task.id}|${date}`))
      .sort((a, b) => {
        const ai = orderIndex.get(a.id);
        const bi = orderIndex.get(b.id);
        if (ai !== undefined || bi !== undefined) {
          if (ai === undefined) return 1;
          if (bi === undefined) return -1;
          if (ai !== bi) return ai - bi;
        }
        return (a.position ?? 0) - (b.position ?? 0) || a.title.localeCompare(b.title);
      });

    const taskEntries: FlowEntry[] = dayTasks.map((task, index) => ({
      id: `task:${task.id}`,
      kind: 'task',
      task,
      title: task.title,
      subtitle: task.goal_id ? goalById.get(task.goal_id)?.title ?? 'Goal' : 'One-off task',
      minutes: task.estimated_minutes ?? null,
      orderLabel: `Queue ${index + 1}`,
      goalId: task.goal_id,
    }));

    const blockEntries: FlowEntry[] = placedEvents
      .filter(placed => placed.date === date)
      .sort((a, b) => a.event.start_hour - b.event.start_hour || a.event.title.localeCompare(b.event.title))
      .map(placed => {
        const firstLink = (linksByEvent.get(placed.event.id) ?? []).find(link => link.task_id);
        const task = firstLink?.task_id ? taskById.get(firstLink.task_id) : null;
        return {
          id: `block:${placed.event.id}`,
          kind: 'block',
          title: placed.event.title,
          subtitle: `${fmtTimeRange(placed.event.start_hour, placed.event.duration_hours)}${task?.title ? ` - ${task.title}` : ''}`,
          minutes: Math.round(placed.event.duration_hours * 60),
          orderLabel: 'Timed block',
          goalId: task?.goal_id ?? null,
          taskId: task?.id ?? null,
        };
      });

    const meetingEntries: FlowEntry[] = meetings
      .filter(meeting => meeting.date === date)
      .sort((a, b) => a.startHour - b.startHour || a.title.localeCompare(b.title))
      .map(meeting => ({
        id: `meeting:${meeting.id}`,
        kind: 'meeting',
        title: meeting.title,
        subtitle: fmtTimeRange(meeting.startHour, meeting.durationHours),
        minutes: Math.round(meeting.durationHours * 60),
        orderLabel: 'Fixed',
        goalId: null,
      }));

    return [...taskEntries, ...blockEntries, ...meetingEntries];
  }, [tasks, date, blockDates, taskOrder, goalById, placedEvents, linksByEvent, taskById, meetings]);

  const sortableTaskIds = entries
    .filter((entry): entry is Extract<FlowEntry, { kind: 'task' }> => entry.kind === 'task')
    .map(entry => `flow-task:${date}:${entry.task.id}`);
  const totalMinutes = entries.reduce((sum, entry) => sum + (entry.minutes ?? 0), 0);

  const openTask = (task: DBTask) => {
    if (!task.goal_id) {
      triggerToast('This task is not attached to a goal yet.', 'info');
      return;
    }
    setTaskSpotlight(task.id);
    navigateToGoal(task.goal_id);
  };

  const openLinkedTask = (taskId: string | null, goalId: string | null) => {
    if (taskId && goalId) {
      setTaskSpotlight(taskId);
      navigateToGoal(goalId);
    } else if (goalId) {
      navigateToGoal(goalId);
    }
  };

  return (
    <section ref={setNodeRef} className={`mt-2 overflow-hidden rounded-xl border bg-white transition-colors ${isOver ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200'}`}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
        aria-expanded={open}
        aria-controls="day-flow-river"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-amber-200 bg-amber-50 text-amber-700">
          <Waves size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-bold text-gray-800">Day flow river</span>
          <span className="block truncate text-[10px] text-gray-400">
            {dayTitle(date)} - {entries.length ? `${entries.length} node${entries.length !== 1 ? 's' : ''}, ${fmtMins(totalMinutes)}` : 'drop tasks here to build the day order'}
          </span>
        </span>
        <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-[8px] font-bold uppercase text-gray-500">
          Hidden visual
        </span>
        <ChevronDown size={14} className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div id="day-flow-river" className="border-t border-gray-100 bg-[linear-gradient(180deg,#fff,#fffaf2)] px-3 py-4">
          {entries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-amber-200 bg-white/70 px-3 py-8 text-center">
              <p className="text-[12px] font-bold text-gray-700">No flow for this day yet.</p>
              <p className="mt-1 text-[10px] text-gray-400">Drop schedule tasks here or assign them to this day.</p>
            </div>
          ) : (
            <div className="relative overflow-x-auto pb-2">
              <div className="pointer-events-none absolute left-5 right-5 top-1/2 h-1 -translate-y-1/2 rounded-full bg-gradient-to-r from-amber-100 via-amber-500/70 to-[#4648d4]/40 shadow-[0_0_22px_rgba(217,119,6,0.24)]" />
              <SortableContext items={sortableTaskIds} strategy={horizontalListSortingStrategy}>
                <div className="relative flex min-w-max items-stretch gap-3 px-1 py-3">
                  {entries.map((entry, index) => entry.kind === 'task' ? (
                    <SortableFlowTaskCard key={entry.id} entry={entry} index={index} onOpenTask={openTask} />
                  ) : (
                    <FixedFlowCard key={entry.id} entry={entry} index={index} onOpenLinkedTask={openLinkedTask} />
                  ))}
                </div>
              </SortableContext>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
