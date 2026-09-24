import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle, ArrowRight, CalendarDays, CheckCircle2, ChevronDown,
  Clock3, Gauge, History, TimerReset,
} from 'lucide-react';
import type { SchedulerResult, ScheduleTaskInfo } from '../../api/hooks';
import type { DBTask } from '../../db/schema';
import { addDays, parseLocalDate } from '../../utils/calendar';

type Diagnostic = SchedulerResult['task_diagnostics'][number];

export type WorkloadHorizonMode = 'week' | 'month';

export interface WorkloadHorizonTask {
  id: string;
  title: string;
  path: string;
  goalTitle: string | null;
  dueDate: string | null;
  outcome: Diagnostic['outcome'];
  estimate: number;
  logged: number;
  committed: number;
  creditedLogged: number;
  creditedCommitted: number;
  commitmentOverage: number;
  remaining: number;
  plannedInRange: number;
  shortfall: number;
  overdue: boolean;
  recoveryFinishDate: string | null;
  unscheduledMinutes: number;
}

export interface WorkloadHorizonDay {
  date: string;
  available: number;
  planned: number;
  free: number;
  dueCount: number;
  missedCount: number;
}

export interface WorkloadHorizonModel {
  tasks: WorkloadHorizonTask[];
  days: WorkloadHorizonDay[];
  estimateMinutes: number;
  loggedMinutes: number;
  committedMinutes: number;
  creditedLoggedMinutes: number;
  creditedCommittedMinutes: number;
  commitmentOverageMinutes: number;
  remainingMinutes: number;
  plannedMinutes: number;
  availableMinutes: number;
  freeMinutes: number;
  remainingAfterRangeMinutes: number;
  overdueCount: number;
  overdueMinutes: number;
  missedCount: number;
  shortfallMinutes: number;
  unestimatedCount: number;
  undatedCount: number;
}

function datesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let date = start, guard = 0; date <= end && guard < 120; date = addDays(date, 1), guard += 1) dates.push(date);
  return dates;
}

function taskPath(taskId: string, taskById: Map<string, DBTask>): string {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = taskById.get(taskId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current.title);
    current = current.parent_task_id ? taskById.get(current.parent_task_id) : undefined;
  }
  return path.join(' › ');
}

export function buildWorkloadHorizonModel({
  scheduler, taskLookup, allTasks, rangeStart, rangeEnd, today, mode,
}: {
  scheduler: SchedulerResult;
  taskLookup: Record<string, ScheduleTaskInfo>;
  allTasks: DBTask[];
  rangeStart: string;
  rangeEnd: string;
  today: string;
  mode: WorkloadHorizonMode;
}): WorkloadHorizonModel {
  const taskById = new Map(allTasks.map(task => [task.id, task]));
  const capacityByDate = new Map(scheduler.capacity_days.map(day => [day.date, day]));
  const rangeDates = datesBetween(rangeStart, rangeEnd);
  const plannedIds = new Set<string>();
  for (const date of rangeDates) {
    for (const id of capacityByDate.get(date)?.task_ids ?? []) plannedIds.add(id);
  }

  const diagnostics = scheduler.task_diagnostics.filter(item => {
    if (plannedIds.has(item.task_id)) return true;
    if (!item.due_date) return mode === 'month';
    return item.due_date <= rangeEnd && (item.due_date >= rangeStart || item.due_date < today);
  });
  const scopedIds = new Set(diagnostics.map(item => item.task_id));

  const plannedByTask = new Map<string, number>();
  for (const date of rangeDates) {
    const day = capacityByDate.get(date);
    if (!day) continue;
    if (day.task_minutes) {
      for (const [taskId, minutes] of Object.entries(day.task_minutes)) {
        if (scopedIds.has(taskId)) plannedByTask.set(taskId, (plannedByTask.get(taskId) ?? 0) + Number(minutes));
      }
    }
  }

  const tasks = diagnostics.map(item => {
    const info = taskLookup[item.task_id];
    const estimate = Number(info?.estimated_minutes ?? 0);
    const logged = Number(info?.logged_minutes ?? 0);
    const committed = Number(info?.committed_minutes ?? 0);
    const remaining = Number(info?.remaining_minutes ?? item.required_minutes ?? 0);
    const creditedTotal = Math.max(0, estimate - remaining);
    const creditedLogged = Math.min(logged, creditedTotal);
    const creditedCommitted = Math.min(committed, Math.max(0, creditedTotal - creditedLogged));
    return {
      id: item.task_id,
      title: info?.title ?? taskById.get(item.task_id)?.title ?? 'Untitled task',
      path: taskPath(item.task_id, taskById),
      goalTitle: info?.goal_title ?? null,
      dueDate: item.due_date,
      outcome: item.outcome,
      estimate,
      logged,
      committed,
      creditedLogged,
      creditedCommitted,
      commitmentOverage: Math.max(0, committed - creditedCommitted),
      remaining,
      plannedInRange: plannedByTask.get(item.task_id) ?? 0,
      shortfall: Number(item.shortfall_minutes ?? 0),
      overdue: Boolean(item.due_date && item.due_date < today && remaining > 0),
      recoveryFinishDate: item.recovery_finish_date ?? null,
      unscheduledMinutes: Number(item.unscheduled_minutes ?? 0),
    } satisfies WorkloadHorizonTask;
  }).sort((a, b) => {
    const rank = (task: WorkloadHorizonTask) => task.overdue ? 0 : task.outcome === 'overflow' ? 1 : task.outcome === 'unestimated' ? 2 : 3;
    return rank(a) - rank(b) || String(a.dueDate ?? '9999-12-31').localeCompare(String(b.dueDate ?? '9999-12-31'));
  });

  const days = rangeDates.map(date => {
    const capacity = capacityByDate.get(date);
    const due = tasks.filter(task => task.dueDate === date);
    const planned = capacity?.task_minutes
      ? Object.entries(capacity.task_minutes).reduce((sum, [taskId, minutes]) => sum + (scopedIds.has(taskId) ? Number(minutes) : 0), 0)
      : Number(capacity?.used_minutes ?? 0);
    const available = Number(capacity?.available_minutes ?? 0);
    return {
      date,
      available,
      planned,
      free: Math.max(0, available - planned),
      dueCount: due.length,
      missedCount: due.filter(task => task.overdue || task.outcome === 'overflow').length,
    };
  });

  const sum = (pick: (task: WorkloadHorizonTask) => number) => tasks.reduce((total, task) => total + pick(task), 0);
  const remainingMinutes = sum(task => task.remaining);
  const plannedMinutes = days.reduce((total, day) => total + day.planned, 0);
  const availableMinutes = days.reduce((total, day) => total + day.available, 0);
  const overdue = tasks.filter(task => task.overdue);
  const missed = tasks.filter(task => !task.overdue && task.outcome === 'overflow');

  return {
    tasks,
    days,
    estimateMinutes: sum(task => task.estimate),
    loggedMinutes: sum(task => task.logged),
    committedMinutes: sum(task => task.committed),
    creditedLoggedMinutes: sum(task => task.creditedLogged),
    creditedCommittedMinutes: sum(task => task.creditedCommitted),
    commitmentOverageMinutes: sum(task => task.commitmentOverage),
    remainingMinutes,
    plannedMinutes,
    availableMinutes,
    freeMinutes: Math.max(0, availableMinutes - plannedMinutes),
    remainingAfterRangeMinutes: Math.max(0, remainingMinutes - plannedMinutes),
    overdueCount: overdue.length,
    overdueMinutes: overdue.reduce((total, task) => total + task.remaining, 0),
    missedCount: missed.length,
    shortfallMinutes: missed.reduce((total, task) => total + task.shortfall, 0),
    unestimatedCount: tasks.filter(task => task.outcome === 'unestimated').length,
    undatedCount: tasks.filter(task => !task.dueDate).length,
  };
}

function duration(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function dateLabel(date: string, includeWeekday = false): string {
  return parseLocalDate(date).toLocaleDateString('en-US', includeWeekday
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric' });
}

function relativeDeadline(date: string | null, today: string): string {
  if (!date) return 'No deadline';
  const days = Math.round((parseLocalDate(date).getTime() - parseLocalDate(today).getTime()) / 86400000);
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days === -1) return 'Due yesterday';
  if (days < 0) return `${Math.abs(days)} days overdue`;
  return `Due in ${days} days`;
}

function Metric({ label, value, note, tone = 'slate' }: { label: string; value: string; note: string; tone?: 'slate' | 'indigo' | 'emerald' | 'amber' | 'red' }) {
  const cls = {
    slate: 'border-slate-200 bg-slate-50 text-slate-950',
    indigo: 'border-indigo-100 bg-indigo-50 text-indigo-950',
    emerald: 'border-emerald-100 bg-emerald-50 text-emerald-950',
    amber: 'border-amber-100 bg-amber-50 text-amber-950',
    red: 'border-red-100 bg-red-50 text-red-950',
  }[tone];
  return <div className={`rounded-2xl border p-3.5 ${cls}`}><p className="text-[10px] font-bold uppercase tracking-[0.12em] opacity-60">{label}</p><p className="mt-1.5 font-headline text-2xl font-bold">{value}</p><p className="mt-1 text-[11px] leading-4 opacity-65">{note}</p></div>;
}

export function WorkloadHorizon({
  scheduler, taskLookup, allTasks, rangeStart, rangeEnd, today, mode, onOpenAudit, onSelectDate,
}: {
  scheduler?: SchedulerResult;
  taskLookup: Record<string, ScheduleTaskInfo>;
  allTasks: DBTask[];
  rangeStart: string;
  rangeEnd: string;
  today: string;
  mode: WorkloadHorizonMode;
  onOpenAudit: () => void;
  onSelectDate?: (date: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const model = useMemo(() => scheduler ? buildWorkloadHorizonModel({
    scheduler, taskLookup, allTasks, rangeStart, rangeEnd, today, mode,
  }) : null, [allTasks, mode, rangeEnd, rangeStart, scheduler, taskLookup, today]);

  if (!scheduler || !model) return <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500">Calculating remaining work and capacity…</div>;

  const pressureCount = model.overdueCount + model.missedCount + model.unestimatedCount;
  const pressureTasks = model.tasks.filter(task => task.overdue || task.outcome !== 'fit');
  const taskRows = (pressureTasks.length ? pressureTasks : model.tasks).slice(0, showAll ? undefined : 6);
  const rangeTitle = mode === 'week' ? `${dateLabel(rangeStart)} – ${dateLabel(rangeEnd)}` : `Next 35 days · ${dateLabel(rangeStart)} – ${dateLabel(rangeEnd)}`;
  const utilisation = model.availableMinutes > 0 ? Math.round(model.plannedMinutes / model.availableMinutes * 100) : 0;
  const creditedHandled = model.creditedLoggedMinutes + model.creditedCommittedMinutes;
  const routineMinutes = scheduler.capacity_days.filter(day => day.date >= rangeStart && day.date <= rangeEnd).reduce((sum, day) => sum + (day.routine_minutes ?? 0), 0);
  const explanation = pressureCount > 0
    ? `${duration(model.remainingMinutes)} of known work is still unfinished in this view.${model.unestimatedCount ? ` ${model.unestimatedCount} unestimated task${model.unestimatedCount === 1 ? ' is' : 's are'} visible but excluded from the hour total.` : ''}`
    : `${duration(model.remainingMinutes)} remains, and every estimated task in this view can currently be placed.`;

  return (
    <section className="mb-3 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Hide' : 'Show'} schedule explanation`}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white"><Gauge size={17} /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-bold text-slate-900">Schedule explanation</span>
          <span className="mt-0.5 block truncate text-[11px] text-slate-500">
            {duration(model.remainingMinutes)} left
            {model.overdueCount ? ` · ${model.overdueCount} overdue` : ''}
            {model.missedCount ? ` · ${model.missedCount} deadline${model.missedCount === 1 ? '' : 's'} need attention` : ''}
            {model.unestimatedCount ? ` · ${model.unestimatedCount} need estimates` : ''}
          </span>
        </span>
        <span className="hidden shrink-0 text-[10px] font-bold text-indigo-700 sm:inline">{expanded ? 'Hide details' : 'Show details'}</span>
        <ChevronDown size={16} className={`shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && <motion.div initial={reduceMotion ? false : { opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
      <div className="border-t border-slate-100 bg-gradient-to-br from-white via-white to-indigo-50/60 p-5 lg:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-indigo-600">How Marina calculated this</p>
              <h3 className="mt-1 font-headline text-xl font-bold text-slate-950">{rangeTitle}</h3>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">{explanation}</p>
          </div>
          <button type="button" onClick={onOpenAudit} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-bold text-slate-700 shadow-sm hover:border-indigo-200 hover:text-indigo-700">
            See every calculation <ArrowRight size={14} />
          </button>
        </div>

        <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Known estimates" value={duration(model.estimateMinutes)} note="Actionable leaf tasks only; parents are not double-counted" tone="indigo" />
          <Metric label="Already handled" value={duration(creditedHandled)} note={`${duration(model.loggedMinutes)} worked · ${duration(model.committedMinutes)} recorded on calendar${model.commitmentOverageMinutes ? ` · ${duration(model.commitmentOverageMinutes)} exceeds its task estimate` : ''}`} tone="emerald" />
          <Metric label="Still left" value={duration(model.remainingMinutes)} note={`${duration(model.plannedMinutes)} suggested by the planner in this view · ${duration(model.remainingAfterRangeMinutes)} later`} tone={model.overdueCount || model.missedCount ? 'red' : 'slate'} />
          <Metric label="Usable time in view" value={duration(model.availableMinutes)} note={`Planner uses ${utilisation}% · ${duration(model.freeMinutes)} open after fixed events${routineMinutes ? ` and ${duration(routineMinutes)} of routines` : ''}`} tone={utilisation > 90 ? 'amber' : 'slate'} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-semibold">
          <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-slate-600">Estimate {duration(model.estimateMinutes)}</span>
          <span className="text-slate-300">−</span>
          <span className="rounded-full border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-emerald-700">worked {duration(model.creditedLoggedMinutes)}</span>
          <span className="text-slate-300">−</span>
          <span className="rounded-full border border-indigo-100 bg-indigo-50 px-2.5 py-1 text-indigo-700">calendar credit {duration(model.creditedCommittedMinutes)}</span>
          <span className="text-slate-300">=</span>
          <span className="rounded-full border border-slate-300 bg-slate-950 px-2.5 py-1 text-white">{duration(model.remainingMinutes)} left</span>
        </div>
      </div>

      {(model.overdueCount > 0 || model.missedCount > 0 || model.unestimatedCount > 0) && (
        <div className="grid gap-2 border-b border-slate-100 bg-slate-50/70 p-4 lg:grid-cols-3 lg:px-6">
          {model.overdueCount > 0 && <div className="flex gap-2 rounded-xl border border-red-100 bg-white p-3 text-xs leading-5 text-slate-700"><History size={15} className="mt-0.5 shrink-0 text-red-600" /><p><strong className="text-red-700">{model.overdueCount} overdue · {duration(model.overdueMinutes)} still left.</strong> The old date stays red, but the work is carried into the next available catch-up slots.</p></div>}
          {model.missedCount > 0 && <div className="flex gap-2 rounded-xl border border-orange-100 bg-white p-3 text-xs leading-5 text-slate-700"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-orange-600" /><p><strong className="text-orange-700">{model.missedCount} upcoming cutoff{model.missedCount === 1 ? '' : 's'} miss by {duration(model.shortfallMinutes)}.</strong> {scheduler.gap_minutes > 0 ? `${duration(scheduler.gap_minutes)} is free later, but later hours cannot repair an earlier deadline.` : 'There is not enough reachable capacity before those dates.'}</p></div>}
          {model.unestimatedCount > 0 && <div className="flex gap-2 rounded-xl border border-amber-100 bg-white p-3 text-xs leading-5 text-slate-700"><TimerReset size={15} className="mt-0.5 shrink-0 text-amber-600" /><p><strong className="text-amber-700">{model.unestimatedCount} task{model.unestimatedCount === 1 ? '' : 's'} need a rough estimate.</strong> They remain visible, but Marina will not invent hours for them.</p></div>}
        </div>
      )}

      <div className="space-y-6 p-4 lg:p-6">
        <div className="min-w-0">
          <div className="mb-3 flex items-end justify-between gap-3"><div><p className="text-xs font-bold text-slate-900">{mode === 'week' ? 'Day-by-day capacity' : 'Five-week load map'}</p><p className="mt-0.5 text-[11px] text-slate-500">Indigo is the planner’s suggested task time, not saved calendar blocks. Pale space is usable time still open; red dates contain a deadline miss.</p></div><span className="shrink-0 text-[10px] font-bold text-slate-400">{duration(model.plannedMinutes)} / {duration(model.availableMinutes)}</span></div>
          <div className="overflow-x-auto pb-1">
            <div className="min-w-[700px]">
              <div className="mb-1 grid grid-cols-7 gap-1.5 px-1 text-center text-[9px] font-bold uppercase tracking-wider text-slate-400">{model.days.slice(0, 7).map(day => <span key={`heading-${day.date}`}>{parseLocalDate(day.date).toLocaleDateString('en-US', { weekday: 'short' })}</span>)}</div>
              <div className="grid grid-cols-7 gap-1.5">
                {model.days.map((day, index) => {
                  const fill = day.available > 0 ? Math.min(100, Math.round(day.planned / day.available * 100)) : 0;
                  const isToday = day.date === today;
                  const isPast = day.date < today;
                  const off = day.available <= 0;
                  return <button key={day.date} type="button" onClick={() => onSelectDate?.(day.date)} disabled={!onSelectDate} className={`relative min-h-[86px] rounded-xl border p-2 text-left transition ${day.missedCount ? 'border-red-200 bg-red-50/70' : isToday ? 'border-indigo-300 bg-indigo-50/70 ring-2 ring-indigo-100' : 'border-slate-100 bg-slate-50/70'} ${onSelectDate ? 'hover:border-indigo-300 hover:bg-indigo-50' : ''}`}>
                    <div className="flex items-center justify-between gap-1"><span className={`text-[10px] font-bold ${isToday ? 'text-indigo-700' : 'text-slate-600'}`}>{index === 0 || parseLocalDate(day.date).getDate() === 1 ? parseLocalDate(day.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : parseLocalDate(day.date).getDate()}</span>{day.dueCount > 0 && <span className={`rounded-full px-1.5 py-0.5 text-[8px] font-bold ${day.missedCount ? 'bg-red-100 text-red-700' : 'bg-white text-slate-500'}`}>{day.dueCount} due</span>}</div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-white"><motion.div initial={reduceMotion ? false : { width: 0 }} animate={{ width: `${fill}%` }} transition={{ duration: 0.35, delay: Math.min(index * 0.01, 0.2) }} className={`h-full rounded-full ${day.missedCount ? 'bg-red-500' : fill > 90 ? 'bg-amber-500' : 'bg-indigo-500'}`} /></div>
                    <p className="mt-2 truncate text-[9px] font-semibold text-slate-500">{isPast ? 'Past' : off ? 'Off day' : `${duration(day.planned)} of ${duration(day.available)}`}</p>
                    {!isPast && !off && <p className="mt-0.5 text-[8px] text-slate-400">{duration(day.free)} open</p>}
                  </button>;
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <div className="mb-3 flex items-end justify-between gap-3"><div><p className="text-xs font-bold text-slate-900">{pressureTasks.length ? 'Tasks needing attention' : 'Tasks shaping this view'}</p><p className="mt-0.5 text-[11px] text-slate-500">Every row shows the leaf task once, with its parent path for context.</p></div><span className="shrink-0 text-[10px] text-slate-400">{pressureTasks.length || model.tasks.length} task{(pressureTasks.length || model.tasks.length) === 1 ? '' : 's'}</span></div>
          <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
            {taskRows.length === 0 ? <div className="rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">No actionable task hours fall inside this view.</div> : taskRows.map(task => {
              const tone = task.overdue ? 'border-red-100 bg-red-50/60' : task.outcome === 'overflow' ? 'border-orange-100 bg-orange-50/60' : task.outcome === 'unestimated' ? 'border-amber-100 bg-amber-50/60' : 'border-emerald-100 bg-emerald-50/50';
              const status = task.overdue ? `${relativeDeadline(task.dueDate, today)} · ${duration(task.remaining)} left` : task.outcome === 'overflow' ? `${relativeDeadline(task.dueDate, today)} · short ${duration(task.shortfall)}` : task.outcome === 'unestimated' ? 'Needs a time estimate' : `${relativeDeadline(task.dueDate, today)} · fits`;
              const recovery = task.recoveryFinishDate ? `Planner catch-up reaches ${dateLabel(task.recoveryFinishDate, true)}` : task.unscheduledMinutes > 0 ? `${duration(task.unscheduledMinutes)} remains outside the 35-day plan` : task.outcome === 'fit' ? `${duration(task.plannedInRange)} suggested in this view` : null;
              return <div key={task.id} className={`rounded-xl border p-3 ${tone}`}>
                <div className="flex items-start gap-2"><div className="mt-0.5 shrink-0">{task.overdue || task.outcome === 'overflow' ? <AlertTriangle size={14} className={task.overdue ? 'text-red-600' : 'text-orange-600'} /> : task.outcome === 'unestimated' ? <Clock3 size={14} className="text-amber-600" /> : <CheckCircle2 size={14} className="text-emerald-600" />}</div><div className="min-w-0 flex-1"><p className="truncate text-xs font-bold text-slate-900" title={task.title}>{task.title}</p><p className="mt-0.5 truncate text-[10px] text-slate-500" title={task.path}>{task.goalTitle ? `${task.goalTitle} · ` : ''}{task.path || task.title}</p></div></div>
                <p className={`mt-2 text-[10px] font-bold ${task.overdue ? 'text-red-700' : task.outcome === 'overflow' ? 'text-orange-700' : task.outcome === 'unestimated' ? 'text-amber-700' : 'text-emerald-700'}`}>{status}</p>
                {task.outcome !== 'unestimated' && <p className="mt-1 text-[9px] leading-4 text-slate-500">{duration(task.estimate)} estimate − {duration(task.creditedLogged)} worked − {duration(task.creditedCommitted)} calendar credit = <strong className="text-slate-700">{duration(task.remaining)} left</strong>{task.commitmentOverage ? ` · ${duration(task.commitmentOverage)} extra calendar time is not subtracted twice` : ''}{recovery ? ` · ${recovery}` : ''}</p>}
              </div>;
            })}
          </div>
          {(pressureTasks.length || model.tasks.length) > 6 && <button type="button" onClick={() => setShowAll(value => !value)} className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg py-2 text-[10px] font-bold text-indigo-700 hover:bg-indigo-50"><ChevronDown size={12} className={showAll ? 'rotate-180' : ''} />{showAll ? 'Show fewer tasks' : `Show all ${pressureTasks.length || model.tasks.length}`}</button>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 bg-slate-50 px-5 py-3 text-[10px] text-slate-500"><span className="inline-flex items-center gap-1"><CalendarDays size={11} /> Fixed events are removed from usable capacity first.</span><span>The load map is a suggested plan; the calendar below is what is actually saved.</span><span>Completed tasks add 0 remaining hours.</span><span>Unfinished parents are labels; unfinished leaves carry the estimates.</span></div>
      </motion.div>}
    </section>
  );
}
