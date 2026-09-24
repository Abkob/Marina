import { useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  Activity, AlertTriangle, CalendarRange, CheckCircle2, ChevronRight, CircleHelp,
  GitBranch, Layers3, Minus, Plus,
} from 'lucide-react';
import type { DBTask } from '../../db/schema';
import type { SchedulerResult, ScheduleTaskInfo } from '../../api/hooks';
import { parseLocalDate } from '../../utils/calendar';
import { readActiveWorkTimer } from '../../utils/workTimer';

type Diagnostic = SchedulerResult['task_diagnostics'][number];
type CapacityDay = SchedulerResult['capacity_days'][number];

type Props = {
  selectedTaskId: string;
  diagnostics: Diagnostic[];
  taskLookup: Record<string, ScheduleTaskInfo>;
  allTasks: DBTask[];
  capacityDays: CapacityDay[];
};

type TreeRow = { task: DBTask; depth: number };
type DailyRow = {
  date: string;
  capacity: number;
  alreadyClaimed: number;
  spareBefore: number;
  proposed: number;
  spareAfter: number;
  remainingAfter: number;
  afterDeadline: boolean;
};

function duration(minutes: number) {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function preciseDuration(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  return `${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${rest}s`.trim();
}

function dateLabel(date: string, long = false) {
  return parseLocalDate(date).toLocaleDateString('en-US', long
    ? { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric' });
}

function collectSubtree(root: DBTask, children: Map<string, DBTask[]>) {
  const rows: TreeRow[] = [];
  const visit = (task: DBTask, depth: number) => {
    rows.push({ task, depth });
    for (const child of children.get(task.id) ?? []) visit(child, depth + 1);
  };
  visit(root, 0);
  return rows;
}

export function HierarchyWorkloadPanel({
  selectedTaskId, diagnostics, taskLookup, allTasks, capacityDays,
}: Props) {
  const reduceMotion = useReducedMotion();
  const [effortShare, setEffortShare] = useState(60);
  const [selectedDay, setSelectedDay] = useState(0);
  const [todayOverrideMinutes, setTodayOverrideMinutes] = useState<number | null>(null);
  const [liveTimerState, setLiveTimerState] = useState(() => ({ timer: readActiveWorkTimer(), now: Date.now() }));

  useEffect(() => {
    const tick = () => {
      const timer = readActiveWorkTimer();
      setLiveTimerState(previous => {
        if (!timer && !previous.timer) return previous;
        return { timer, now: Date.now() };
      });
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    window.addEventListener('storage', tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('storage', tick);
    };
  }, []);

  const model = useMemo(() => {
    const taskById = new Map(allTasks.map(task => [task.id, task]));
    const diagnosticById = new Map(diagnostics.map(item => [item.task_id, item]));
    const children = new Map<string, DBTask[]>();
    for (const task of allTasks) {
      if (!task.parent_task_id) continue;
      if (!children.has(task.parent_task_id)) children.set(task.parent_task_id, []);
      children.get(task.parent_task_id)!.push(task);
    }
    for (const items of children.values()) items.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));

    const selected = taskById.get(selectedTaskId);
    if (!selected) return null;

    const path: DBTask[] = [];
    const seen = new Set<string>();
    let cursor: DBTask | undefined = selected;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      path.unshift(cursor);
      cursor = cursor.parent_task_id ? taskById.get(cursor.parent_task_id) : undefined;
    }

    const branch = selected.parent_task_id ? taskById.get(selected.parent_task_id) ?? selected : selected;
    const treeRows = collectSubtree(branch, children);
    const subtreeIds = new Set(treeRows.map(row => row.task.id));
    const branchDiagnostics = diagnostics.filter(item => subtreeIds.has(item.task_id));
    const knownRemaining = branchDiagnostics.reduce((sum, item) => sum + item.required_minutes, 0);
    const unknownCount = branchDiagnostics.filter(item => item.outcome === 'unestimated').length;
    const knownDiagnostics = branchDiagnostics.filter(item => item.outcome !== 'unestimated' && item.required_minutes > 0);
    const effectiveDeadline = (knownDiagnostics.length ? knownDiagnostics : branchDiagnostics)
      .map(item => item.due_date)
      .filter((date): date is string => Boolean(date))
      .sort()[0] ?? null;

    const descendantsFor = (taskId: string) => {
      const root = taskById.get(taskId);
      return root ? collectSubtree(root, children).map(row => row.task.id) : [];
    };
    const estimateWarnings = path.flatMap(task => {
      const estimate = Number(task.estimated_minutes ?? 0);
      if (!(estimate > 0) || task.time_rollup_mode !== 'inclusive') return [];
      const descendantIds = new Set(descendantsFor(task.id));
      descendantIds.delete(task.id);
      const leafTotal = diagnostics
        .filter(item => descendantIds.has(item.task_id))
        .reduce((sum, item) => sum + item.required_minutes, 0);
      if (leafTotal <= estimate) return [];
      return [{ task, estimate, leafTotal }];
    });
    const branchPathIndex = path.findIndex(task => task.id === branch.id);
    const estimateOrigin = !(Number(branch.estimated_minutes ?? 0) > 0)
      ? path.slice(0, Math.max(0, branchPathIndex)).reverse().find(task => Number(task.estimated_minutes ?? 0) > 0) ?? null
      : null;

    const groupAllocationByDate = new Map<string, number>();
    for (const day of capacityDays) {
      const allocated = [...subtreeIds].reduce((sum, taskId) => sum + (day.task_minutes?.[taskId] ?? 0), 0);
      if (allocated > 0) groupAllocationByDate.set(day.date, allocated);
    }
    // Older/test payloads may not include the per-task allocation map.
    if (groupAllocationByDate.size === 0) {
      for (const item of branchDiagnostics) {
        if (item.outcome !== 'fit') continue;
        for (const day of item.days) {
          groupAllocationByDate.set(day.date, (groupAllocationByDate.get(day.date) ?? 0) + day.allocated_minutes);
        }
      }
    }

    const baseCapacity = [...capacityDays]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(day => {
        const selectedGroupKept = groupAllocationByDate.get(day.date) ?? 0;
        const alreadyClaimed = Math.max(0, day.used_minutes - selectedGroupKept);
        return {
          day,
          alreadyClaimed,
          spareBefore: Math.max(0, day.available_minutes - alreadyClaimed),
        };
      });

    return {
      selected, path, branch, treeRows, diagnosticById, branchDiagnostics,
      knownRemaining, unknownCount, effectiveDeadline, estimateWarnings, estimateOrigin, baseCapacity, subtreeIds,
    };
  }, [allTasks, capacityDays, diagnostics, selectedTaskId]);

  const dailyRows = useMemo(() => {
    if (!model) return [] as DailyRow[];
    let remaining = model.knownRemaining;
    const rows: DailyRow[] = [];
    for (const [index, item] of model.baseCapacity.entries()) {
      if (remaining <= 0 && rows.length > 0) break;
      const effortPlan = Math.round(item.spareBefore * effortShare / 100);
      const proposed = Math.min(
        remaining,
        item.spareBefore,
        index === 0 && todayOverrideMinutes !== null ? Math.max(0, todayOverrideMinutes) : effortPlan,
      );
      remaining = Math.max(0, remaining - proposed);
      rows.push({
        date: item.day.date,
        capacity: item.day.available_minutes,
        alreadyClaimed: item.alreadyClaimed,
        spareBefore: item.spareBefore,
        proposed,
        spareAfter: Math.max(0, item.spareBefore - proposed),
        remainingAfter: remaining,
        afterDeadline: Boolean(model.effectiveDeadline && item.day.date > model.effectiveDeadline),
      });
    }
    return rows;
  }, [effortShare, model, todayOverrideMinutes]);

  useEffect(() => setSelectedDay(0), [effortShare, selectedTaskId]);
  useEffect(() => setTodayOverrideMinutes(null), [selectedTaskId]);

  if (!model) return null;
  const day = dailyRows[Math.min(selectedDay, Math.max(0, dailyRows.length - 1))];
  const deadlinePassed = Boolean(model.effectiveDeadline && model.baseCapacity[0]?.day.date > model.effectiveDeadline);
  const beforeDeadline = model.baseCapacity.filter(item => !model.effectiveDeadline || item.day.date <= model.effectiveDeadline);
  const spareBeforeDeadline = beforeDeadline.reduce((sum, item) => sum + item.spareBefore, 0);
  const requiredShare = spareBeforeDeadline > 0 ? Math.ceil(model.knownRemaining / spareBeforeDeadline * 100) : null;
  const projectedFinish = dailyRows.find(item => item.remainingAfter === 0)?.date ?? null;
  const horizonRemaining = dailyRows.at(-1)?.remainingAfter ?? model.knownRemaining;
  const workDays = dailyRows.filter(item => item.proposed > 0);
  const averageDaily = workDays.length
    ? Math.round(workDays.reduce((sum, item) => sum + item.proposed, 0) / workDays.length)
    : 0;
  const firstCapacity = model.baseCapacity[0];
  const todayMax = Math.min(model.knownRemaining, firstCapacity?.spareBefore ?? 0);
  const todayRow = dailyRows[0];
  const todayWork = todayRow?.proposed ?? 0;
  const todaySuggestion = Math.min(model.knownRemaining, Math.round((firstCapacity?.spareBefore ?? 0) * effortShare / 100));
  const todayPlanDifference = todayWork - todaySuggestion;
  const activeTimer = liveTimerState.timer && model.subtreeIds.has(liveTimerState.timer.taskId)
    ? liveTimerState.timer
    : null;
  const activeTimerTask = activeTimer ? allTasks.find(task => task.id === activeTimer.taskId) : null;
  const activeStartedAt = activeTimer ? Date.parse(activeTimer.startedAt) : Number.NaN;
  const activeElapsedSeconds = activeTimer && Number.isFinite(activeStartedAt)
    ? Math.max(0, Math.floor((liveTimerState.now - activeStartedAt) / 1000))
    : 0;
  const liveRemainingSeconds = Math.max(0, model.knownRemaining * 60 - activeElapsedSeconds);
  const setTodayWork = (minutes: number) => setTodayOverrideMinutes(Math.max(0, Math.min(todayMax, Math.round(minutes))));

  return (
    <div className="border-t border-slate-100 bg-slate-50/60 p-3 sm:p-4">
      <div className="grid gap-4 2xl:grid-cols-[minmax(420px,0.85fr)_minmax(0,1.4fr)]">
        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-start gap-3">
            <GitBranch size={19} className="mt-0.5 shrink-0 text-indigo-600" />
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-indigo-600">Parent and subtask breakdown</p>
              <h4 className="mt-1 truncate font-headline text-lg font-bold text-slate-950">{model.branch.title}</h4>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1 text-xs font-semibold text-slate-500">
            {model.path.map((task, index) => (
              <span key={task.id} className="flex items-center gap-1">
                {index > 0 && <ChevronRight size={12} />}
                <span className={task.id === model.selected.id ? 'text-indigo-700' : ''}>{task.title}</span>
              </span>
            ))}
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <div className="rounded-xl bg-indigo-50 p-3"><p className="text-[11px] font-bold uppercase tracking-wide text-indigo-600">Known leaf work</p><p className="mt-1 text-xl font-bold text-indigo-900">{duration(model.knownRemaining)}</p></div>
            <div className="rounded-xl bg-amber-50 p-3"><p className="text-[11px] font-bold uppercase tracking-wide text-amber-600">Unknown subtasks</p><p className="mt-1 text-xl font-bold text-amber-900">{model.unknownCount}</p></div>
            <div className="rounded-xl bg-slate-50 p-3"><p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Earliest cutoff</p><p className="mt-1 text-sm font-bold text-slate-900">{model.effectiveDeadline ? dateLabel(model.effectiveDeadline) : 'No date'}</p></div>
          </div>

          {model.estimateOrigin && (
            <div className="mt-3 flex gap-2 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-xs leading-5 text-indigo-900">
              <CircleHelp size={16} className="mt-0.5 shrink-0" />
              <p><strong>{model.branch.title} has no saved estimate of its own.</strong> The {duration(Number(model.estimateOrigin.estimated_minutes ?? 0))} value is stored on its parent container, {model.estimateOrigin.title}. The open executable leaves inside {model.branch.title} currently contain {duration(model.knownRemaining)} of known work{model.unknownCount ? ` plus ${model.unknownCount} unknown estimate${model.unknownCount === 1 ? '' : 's'}` : ''}.</p>
            </div>
          )}

          {model.estimateWarnings.map(warning => (
            <div key={warning.task.id} data-testid="estimate-warning" className="mt-3 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <p><strong>{warning.task.title}</strong> says {duration(warning.estimate)} total, but its open executable leaves currently add to {duration(warning.leafTotal)}. Marina counts the leaves and does not add the parent again. One of these estimates likely needs correction.</p>
            </div>
          ))}

          <div className="mt-3 overflow-hidden rounded-xl border border-slate-200">
            {model.treeRows.map(({ task, depth }) => {
              const diagnostic = model.diagnosticById.get(task.id);
              const hasChildren = model.treeRows.some(row => row.task.parent_task_id === task.id);
              const info = taskLookup[task.id];
              const state = task.completed
                ? 'Done'
                : diagnostic?.outcome === 'unestimated'
                  ? 'Estimate missing'
                  : diagnostic
                    ? `${duration(diagnostic.required_minutes)} left`
                    : hasChildren ? 'Container: children counted below' : 'Not in planner';
              return (
                <div key={task.id} className={`flex items-start justify-between gap-3 border-t border-slate-100 px-3 py-2.5 first:border-t-0 ${task.id === model.selected.id ? 'bg-indigo-50' : 'bg-white'}`}>
                  <div className="min-w-0" style={{ paddingLeft: `${Math.min(depth, 4) * 16}px` }}>
                    <div className="flex items-center gap-1.5"><Layers3 size={13} className={hasChildren ? 'text-indigo-500' : 'text-slate-300'} /><p className="truncate text-sm font-semibold text-slate-800">{task.title}</p></div>
                    <p className="mt-0.5 text-[11px] text-slate-400">{task.estimated_minutes ? `${duration(task.estimated_minutes)} ${task.time_rollup_mode === 'inclusive' ? 'inclusive estimate' : 'estimate'}` : 'No saved estimate'}{info?.due_date ? ` / due ${dateLabel(info.due_date)}` : ''}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-bold ${task.completed ? 'bg-emerald-50 text-emerald-700' : diagnostic?.outcome === 'overflow' ? 'bg-red-50 text-red-700' : diagnostic?.outcome === 'unestimated' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>{state}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <CalendarRange size={19} className="mt-0.5 shrink-0 text-indigo-600" />
              <div><p className="text-xs font-bold uppercase tracking-[0.12em] text-indigo-600">Daily workload calendar</p><h4 className="mt-1 font-headline text-lg font-bold text-slate-950">How much time should {model.branch.title} get?</h4></div>
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Choose share of daily spare time">
              {[[40, 'Gentle'], [60, 'Balanced'], [80, 'Strong'], [100, 'Maximum']] .map(([value, label]) => (
                <button key={value} type="button" onClick={() => setEffortShare(Number(value))} aria-pressed={effortShare === value} className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${effortShare === value ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-300'}`}>{label} {value}%</button>
              ))}
            </div>
          </div>

          <div className={`mt-3 rounded-xl border p-3 ${deadlinePassed || (requiredShare !== null && requiredShare > 100) ? 'border-red-200 bg-red-50' : 'border-indigo-200 bg-indigo-50'}`}>
            <div className="flex gap-2">
              {deadlinePassed || (requiredShare !== null && requiredShare > 100) ? <AlertTriangle size={17} className="mt-0.5 shrink-0 text-red-600" /> : <CircleHelp size={17} className="mt-0.5 shrink-0 text-indigo-600" />}
              <div className="text-sm leading-6 text-slate-700">
                {deadlinePassed ? (
                  <p>The effective deadline, <strong>{dateLabel(model.effectiveDeadline!, true)}</strong>, has passed. This is therefore a <strong>recovery plan starting now</strong>, not an on-time plan.</p>
                ) : requiredShare !== null && requiredShare > 100 ? (
                  <p>Even 100% of the spare time before the cutoff is not enough. The known work needs about <strong>{requiredShare}%</strong> of the available time.</p>
                ) : (
                  <p>To meet the cutoff, this group needs about <strong>{requiredShare ?? 0}% of all spare time before the deadline</strong>. Use the buttons to compare gentler and stronger daily plans.</p>
                )}
              </div>
            </div>
          </div>

          {activeTimer && (
            <motion.div data-testid="live-focus-status" initial={reduceMotion ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="mt-3 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" aria-live="polite">
              <Activity size={17} className={`mt-0.5 shrink-0 ${reduceMotion ? '' : 'animate-pulse'}`} />
              <p><strong>Focus is running on {activeTimerTask?.title ?? model.branch.title}:</strong> {preciseDuration(activeElapsedSeconds)} worked in this session. Known work remaining right now is <strong>{preciseDuration(liveRemainingSeconds)}</strong>. This updates every second.</p>
            </motion.div>
          )}

          <div data-testid="today-calculator" className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50/70 p-4">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-indigo-600">Live today calculator</p>
                <p className="mt-1 text-sm text-slate-700">If I work <strong className="text-indigo-800">{duration(todayWork)}</strong> on {model.branch.title} today…</p>
              </div>
              {todayOverrideMinutes !== null && <button type="button" onClick={() => setTodayOverrideMinutes(null)} className="self-start text-xs font-bold text-indigo-700 hover:underline sm:self-auto">Use {effortShare}% suggestion</button>}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button type="button" onClick={() => setTodayWork(todayWork - 30)} disabled={todayWork <= 0} aria-label="Decrease today work by 30 minutes" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-indigo-200 bg-white text-indigo-700 disabled:opacity-40"><Minus size={15} /></button>
              <label className="min-w-0 flex-1">
                <span className="sr-only">What if work today</span>
                <input aria-label="What if work today" type="range" min={0} max={Math.max(0, todayMax)} step={15} value={todayWork} onChange={event => setTodayWork(Number(event.target.value))} className="w-full accent-indigo-600" />
              </label>
              <button type="button" onClick={() => setTodayWork(todayWork + 30)} disabled={todayWork >= todayMax} aria-label="Increase today work by 30 minutes" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-indigo-200 bg-white text-indigo-700 disabled:opacity-40"><Plus size={15} /></button>
            </div>
            <div className="mt-1 flex justify-between text-[11px] font-semibold text-slate-500"><span>0m</span><span>Today’s spare-time limit: {duration(todayMax)}</span></div>

            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg bg-white/80 p-2.5"><p className="text-[10px] font-bold uppercase text-slate-400">Task left tonight</p><motion.p key={`left-${todayRow?.remainingAfter ?? model.knownRemaining}`} initial={reduceMotion ? false : { scale: 0.97 }} animate={{ scale: 1 }} className="mt-1 text-lg font-bold text-slate-950">{duration(todayRow?.remainingAfter ?? model.knownRemaining)}</motion.p></div>
              <div className="rounded-lg bg-white/80 p-2.5"><p className="text-[10px] font-bold uppercase text-slate-400">Spare left today</p><motion.p key={`spare-${todayRow?.spareAfter ?? 0}`} initial={reduceMotion ? false : { scale: 0.97 }} animate={{ scale: 1 }} className="mt-1 text-lg font-bold text-emerald-700">{duration(todayRow?.spareAfter ?? 0)}</motion.p></div>
              <div className="rounded-lg bg-white/80 p-2.5"><p className="text-[10px] font-bold uppercase text-slate-400">New finish estimate</p><motion.p key={`finish-${projectedFinish ?? 'beyond'}`} initial={reduceMotion ? false : { scale: 0.97 }} animate={{ scale: 1 }} className="mt-1 text-sm font-bold text-slate-950">{projectedFinish ? dateLabel(projectedFinish) : `Beyond ${capacityDays.length}-day view`}</motion.p></div>
            </div>
            <p data-testid="today-calculator-explanation" className="mt-3 text-xs leading-5 text-slate-700" aria-live="polite">Do {duration(todayWork)} today and {duration(todayRow?.remainingAfter ?? model.knownRemaining)} of known work is left tonight. You keep {duration(todayRow?.spareAfter ?? 0)} spare today. {todayPlanDifference === 0 ? `That matches the ${effortShare}% suggestion.` : todayPlanDifference > 0 ? `That is ${duration(todayPlanDifference)} more than the ${effortShare}% suggestion.` : `That is ${duration(-todayPlanDifference)} less than the ${effortShare}% suggestion.`}</p>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">This slider is only a preview. A running Focus session updates the live remaining amount above; finishing it records the work and refreshes the real schedule automatically.</p>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="rounded-xl bg-slate-50 p-3"><p className="text-[11px] font-bold uppercase text-slate-400">Average on workdays</p><p className="mt-1 text-lg font-bold text-slate-900">{duration(averageDaily)}/day</p></div>
            <div className="rounded-xl bg-slate-50 p-3"><p className="text-[11px] font-bold uppercase text-slate-400">Projected finish</p><p className="mt-1 text-sm font-bold text-slate-900">{projectedFinish ? dateLabel(projectedFinish) : `Beyond ${capacityDays.length}-day view`}</p></div>
            <div className="rounded-xl bg-slate-50 p-3"><p className="text-[11px] font-bold uppercase text-slate-400">Left at view end</p><p className={`mt-1 text-lg font-bold ${horizonRemaining ? 'text-red-700' : 'text-emerald-700'}`}>{duration(horizonRemaining)}</p></div>
          </div>

          {day ? (
            <motion.div key={`${selectedTaskId}-${effortShare}-${day.date}`} initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-3 rounded-xl bg-slate-950 p-4 text-white" aria-live="polite">
              <p className="text-xs font-bold uppercase tracking-wide text-indigo-300">{dateLabel(day.date, true)}{day.afterDeadline ? ' / after deadline' : ''}</p>
              <p data-testid="daily-explanation" className="mt-2 text-sm leading-6 text-slate-200">This day has <strong className="text-white">{duration(day.capacity)} usable</strong>. Other scheduled work claims {duration(day.alreadyClaimed)}, leaving {duration(day.spareBefore)} spare. At {effortShare}%, give <strong className="text-indigo-300">{duration(day.proposed)} to {model.branch.title}</strong>; keep {duration(day.spareAfter)} spare; then {duration(day.remainingAfter)} of known work remains.</p>
              <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-white/10">
                <div className="bg-slate-500" style={{ width: `${day.capacity ? day.alreadyClaimed / day.capacity * 100 : 0}%` }} title="Other scheduled work" />
                <motion.div className="bg-indigo-400" initial={reduceMotion ? false : { width: 0 }} animate={{ width: `${day.capacity ? day.proposed / day.capacity * 100 : 0}%` }} title={model.branch.title} />
                <div className="bg-emerald-400" style={{ width: `${day.capacity ? day.spareAfter / day.capacity * 100 : 0}%` }} title="Spare after" />
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-slate-400"><span>Gray: other work</span><span>Indigo: this group</span><span>Green: spare after</span></div>
            </motion.div>
          ) : (
            <p className="mt-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No future workday capacity is available in this planning view.</p>
          )}

          <div className="mt-3 flex snap-x snap-mandatory gap-2 overflow-x-auto pb-2" aria-label="Scrollable daily workload calendar">
            {dailyRows.map((row, index) => (
              <button key={row.date} type="button" onClick={() => setSelectedDay(index)} aria-current={selectedDay === index ? 'date' : undefined} className={`min-w-[150px] snap-center rounded-xl border p-3 text-left transition ${selectedDay === index ? 'border-indigo-500 bg-indigo-50 shadow-sm' : row.afterDeadline ? 'border-red-100 bg-red-50/40' : 'border-slate-200 bg-white hover:border-indigo-300'}`}>
                <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{dateLabel(row.date)}</p>
                <p className="mt-2 text-sm font-bold text-indigo-700">Give {duration(row.proposed)}</p>
                <p className="mt-1 text-xs text-slate-500">Spare after: {duration(row.spareAfter)}</p>
                <p className={`mt-2 text-xs font-bold ${row.remainingAfter ? 'text-slate-700' : 'text-emerald-700'}`}>{row.remainingAfter ? `${duration(row.remainingAfter)} work left` : 'Known work done'}</p>
              </button>
            ))}
          </div>
          {model.unknownCount > 0 && <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-amber-700"><AlertTriangle size={14} className="mt-0.5 shrink-0" />This projection excludes {model.unknownCount} subtask{model.unknownCount === 1 ? '' : 's'} with no estimate, so the real workload may be larger.</p>}
          {!horizonRemaining && projectedFinish && <p className="mt-2 flex items-center gap-2 text-xs font-semibold text-emerald-700"><CheckCircle2 size={14} />At this effort level, all known work fits by {dateLabel(projectedFinish, true)}.</p>}
        </section>
      </div>
    </div>
  );
}
