import {
  AlertTriangle, ArrowLeft, CalendarDays, CheckCircle2, ChevronDown,
  CircleHelp, Clock3, Flag, TimerReset,
} from 'lucide-react';
import type { DBGoal, DBTask } from '../../db/schema';
import type { ScheduleDay, SchedulerResult, ScheduleTaskInfo } from '../../api/hooks';
import { parseLocalDate } from '../../utils/calendar';
import { InteractiveTaskTimeline } from './InteractiveTaskTimeline';

type SchedulePrefsSummary = {
  daily_capacity_minutes?: number;
  buffer_ratio?: number;
  work_start?: number;
  work_end?: number;
};

type Props = {
  scheduler: SchedulerResult;
  taskLookup: Record<string, ScheduleTaskInfo>;
  goals: DBGoal[];
  allTasks: DBTask[];
  weekDays: string[];
  previewDays: ScheduleDay[];
  prefs?: SchedulePrefsSummary;
  onBack: () => void;
};

type Diagnostic = SchedulerResult['task_diagnostics'][number];
type DueTask = ScheduleDay['tasks'][number];
type TaskClass = 'estimated' | 'missing' | 'context';

function duration(minutes: number) {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function dateLabel(date: string, includeYear = false) {
  return parseLocalDate(date).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', ...(includeYear ? { year: 'numeric' } : {}),
  });
}

function hourLabel(hour: number) {
  const whole = Math.floor(hour);
  const minutes = Math.round((hour - whole) * 60);
  return new Date(2000, 0, 1, whole, minutes).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: minutes ? '2-digit' : undefined,
  });
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function calendarDayDifference(from: string, to: string) {
  return Math.round((parseLocalDate(to).getTime() - parseLocalDate(from).getTime()) / 86400000);
}

function timelineSourceLabel(source: ScheduleTaskInfo['due_date_source'] | ScheduleTaskInfo['start_date_source']) {
  if (!source) return null;
  const scope = {
    task: 'Task', parent_task: 'Parent task', milestone: 'Milestone', goal: 'Goal',
  }[source.scope];
  const field = {
    start_date: 'start', hard_deadline: 'hard deadline', target_date: 'target',
    due_date: 'due date', deadline: 'deadline',
  }[source.field];
  return `${scope} ${field}`;
}

function datesBetween(from: string, to: string) {
  const dates: string[] = [];
  const cursor = parseLocalDate(from);
  const end = parseLocalDate(to);
  while (cursor <= end && dates.length < 120) {
    dates.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function contextReason(task: DBTask | undefined, parentIds: Set<string>) {
  if (!task) return 'Not included in the automatic planner';
  if (parentIds.has(task.id)) return 'Parent/container; its incomplete child tasks are counted instead';
  if (task.kind === 'critical_path') return 'Critical-path context; not scheduled as a separate work block';
  if (task.scheduling_enabled === false) return 'Automatic scheduling is disabled for this task';
  return 'Context-only task; not counted as separate work';
}

function CountPill({ count, label, tone }: { count: number; label: string; tone: 'blue' | 'amber' | 'slate' | 'red' | 'green' }) {
  const cls = {
    blue: 'border-indigo-200 bg-indigo-50 text-indigo-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    slate: 'border-slate-200 bg-slate-50 text-slate-600',
    red: 'border-red-200 bg-red-50 text-red-700',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  }[tone];
  return <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${cls}`}>{count} {label}</span>;
}

function Metric({ label, value, note, tone = 'slate' }: { label: string; value: string; note: string; tone?: 'slate' | 'red' | 'amber' | 'indigo' }) {
  const cls = {
    slate: 'border-slate-200 bg-white', red: 'border-red-200 bg-red-50/60',
    amber: 'border-amber-200 bg-amber-50/60', indigo: 'border-indigo-200 bg-indigo-50/60',
  }[tone];
  return (
    <div className={`rounded-2xl border p-4 ${cls}`}>
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight text-slate-950">{value}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{note}</p>
    </div>
  );
}

export function FeasibilityReport({
  scheduler, taskLookup, goals, allTasks, weekDays, previewDays, prefs, onBack,
}: Props) {
  const diagnostics = scheduler.task_diagnostics ?? [];
  const capacityDays = scheduler.capacity_days ?? scheduler.day_assignments;
  const diagnosticById = new Map(diagnostics.map(item => [item.task_id, item]));
  const goalById = new Map(goals.map(goal => [goal.id, goal]));
  const taskById = new Map(allTasks.map(task => [task.id, task]));
  const parentIds = new Set(allTasks.map(task => task.parent_task_id).filter((id): id is string => Boolean(id)));
  const previewByDate = new Map(previewDays.map(day => [day.date, day]));
  const capacityByDate = new Map(capacityDays.map(day => [day.date, day]));
  const today = diagnostics[0]?.earliest_date ?? capacityDays[0]?.date ?? weekDays[0] ?? '';

  const classify = (task: DueTask): TaskClass => {
    const diagnostic = diagnosticById.get(task.id);
    if (diagnostic?.outcome === 'unestimated') return 'missing';
    if (diagnostic) return 'estimated';
    return 'context';
  };

  const weekRows = weekDays.map(date => {
    const day = previewByDate.get(date);
    const dueTasks = day?.tasks ?? [];
    const estimated = dueTasks.filter(task => classify(task) === 'estimated');
    const missing = dueTasks.filter(task => classify(task) === 'missing');
    const context = dueTasks.filter(task => classify(task) === 'context');
    const knownMinutes = estimated.reduce((sum, task) => sum + (diagnosticById.get(task.id)?.required_minutes ?? 0), 0);
    const failures = estimated.filter(task => diagnosticById.get(task.id)?.outcome === 'overflow');
    return {
      date, dueTasks, estimated, missing, context, knownMinutes, failures,
      capacity: capacityByDate.get(date), goalDeadlines: day?.deadlines ?? [],
    };
  });

  const overflow = diagnostics
    .filter(item => item.outcome === 'overflow')
    .sort((a, b) => String(a.due_date ?? '9999-12-31').localeCompare(String(b.due_date ?? '9999-12-31')));
  const unestimated = diagnostics.filter(item => item.outcome === 'unestimated');
  const overdueFailures = overflow.filter(item => Boolean(item.due_date && item.due_date < today));
  const upcomingFailures = overflow.filter(item => !item.due_date || item.due_date >= today);
  const totalShortfall = overflow.reduce((sum, item) => sum + item.shortfall_minutes, 0);
  const overdueShortfall = overdueFailures.reduce((sum, item) => sum + item.shortfall_minutes, 0);
  const nextFailure = upcomingFailures.find(item => Boolean(item.due_date));
  const nextFailureTask = nextFailure ? taskLookup[nextFailure.task_id] : undefined;
  const upcomingShortfall = upcomingFailures.reduce((sum, item) => sum + item.shortfall_minutes, 0);

  const groupMap = new Map<string, { date: string | null; failures: Diagnostic[]; unknowns: Diagnostic[] }>();
  for (const item of [...overflow, ...unestimated]) {
    const key = item.due_date ?? 'undated';
    if (!groupMap.has(key)) groupMap.set(key, { date: item.due_date, failures: [], unknowns: [] });
    const group = groupMap.get(key)!;
    if (item.outcome === 'overflow') group.failures.push(item);
    else group.unknowns.push(item);
  }
  const deadlineGroups = [...groupMap.values()].sort((a, b) => String(a.date ?? '9999-12-31').localeCompare(String(b.date ?? '9999-12-31')));
  const taskTimelineRows = diagnostics
    .map(diagnostic => {
      const task = taskLookup[diagnostic.task_id];
      let remainingAfterSlice = diagnostic.required_minutes;
      const slices = diagnostic.days.map(day => {
        remainingAfterSlice = Math.max(0, remainingAfterSlice - day.allocated_minutes);
        return { ...day, remaining_after: remainingAfterSlice };
      });
      const finalSlice = slices.filter(day => day.allocated_minutes > 0).at(-1);
      const finishDate = diagnostic.outcome === 'fit' ? finalSlice?.date ?? null : null;
      return { diagnostic, task, slices, finishDate };
    })
    .sort((a, b) => {
      const outcomeRank = { overflow: 0, unestimated: 1, fit: 2 };
      const rank = outcomeRank[a.diagnostic.outcome] - outcomeRank[b.diagnostic.outcome];
      if (rank !== 0) return rank;
      return String(a.diagnostic.due_date ?? '9999-12-31').localeCompare(String(b.diagnostic.due_date ?? '9999-12-31'));
    });

  let runningRemaining = nextFailure?.required_minutes ?? 0;
  const nextFailureDayMap = new Map(nextFailure?.days.map(day => [day.date, day]) ?? []);
  const nextFailureDays = nextFailure?.due_date
    ? datesBetween(today, nextFailure.due_date).map(date => {
        const attempt = nextFailureDayMap.get(date);
        const capacity = capacityByDate.get(date);
        const usable = attempt?.capacity_minutes ?? capacity?.available_minutes ?? 0;
        const claimed = attempt?.committed_before_minutes ?? (usable ? Math.min(usable, capacity?.used_minutes ?? 0) : 0);
        const given = attempt?.allocated_minutes ?? 0;
        runningRemaining = Math.max(0, runningRemaining - given);
        return { date, usable, claimed, given, remaining: runningRemaining };
      })
    : [];

  const weekDue = weekRows.reduce((sum, day) => sum + day.dueTasks.length, 0);
  const weekEstimated = weekRows.reduce((sum, day) => sum + day.estimated.length, 0);
  const weekMissing = weekRows.reduce((sum, day) => sum + day.missing.length, 0);
  const weekContext = weekRows.reduce((sum, day) => sum + day.context.length, 0);
  const weekKnownMinutes = weekRows.reduce((sum, day) => sum + day.knownMinutes, 0);
  const weekCapacity = weekRows.reduce((sum, day) => sum + (day.capacity?.available_minutes ?? 0), 0);
  const weekGoalDeadlines = weekRows.reduce((sum, day) => sum + day.goalDeadlines.length, 0);
  const rawDaily = Number(prefs?.daily_capacity_minutes ?? 480);
  const bufferMinutes = Math.round(rawDaily * Number(prefs?.buffer_ratio ?? 0.15));
  const effectiveDaily = Math.max(0, rawDaily - bufferMinutes);

  const renderTask = (task: DueTask) => {
    const classification = classify(task);
    const diagnostic = diagnosticById.get(task.id);
    const dbTask = taskById.get(task.id);
    const label = classification === 'estimated'
      ? `${duration(diagnostic?.required_minutes ?? 0)} remaining`
      : classification === 'missing' ? 'Estimate missing' : 'Context only';
    const cls = classification === 'estimated'
      ? diagnostic?.outcome === 'overflow' ? 'bg-red-50 text-red-700' : 'bg-indigo-50 text-indigo-700'
      : classification === 'missing' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600';
    return (
      <div key={task.id} className="flex flex-col gap-2 border-t border-slate-100 py-3 first:border-t-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800">{task.title}</p>
          <p className="mt-0.5 text-xs leading-5 text-slate-500">
            {goalById.get(task.goal_id ?? '')?.title ?? 'No goal'}
            {classification === 'context' ? ` · ${contextReason(dbTask, parentIds)}` : ''}
          </p>
        </div>
        <span className={`shrink-0 self-start rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>{label}</span>
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[1480px] px-4 py-6 md:px-6 2xl:px-8">
      <button onClick={onBack} className="mb-5 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-800">
        <ArrowLeft size={16} /> Back to schedule
      </button>

      <header className="border-b border-slate-200 pb-6">
        <div className={`flex items-center gap-2 ${overflow.length ? 'text-red-600' : 'text-emerald-600'}`}>
          <Flag size={17} /><span className="text-xs font-bold uppercase tracking-[0.14em]">Plain-language schedule check</span>
        </div>
        <h1 className="mt-2 font-headline text-3xl font-bold tracking-tight text-slate-950">
          {overflow.length ? `${plural(overflow.length, 'task')} cannot meet ${overflow.length === 1 ? 'its' : 'their'} dates` : 'All estimated tasks fit their dates'}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          A collection of deadlines is called impossible when even one dated bucket cannot fit before its cutoff. Spare time after that cutoff cannot rescue it.
        </p>
      </header>

      {overflow.length ? (
        <section className="mt-5 rounded-2xl border-2 border-red-200 bg-red-50/60 p-5">
          <div className="flex gap-3">
            <AlertTriangle size={20} className="mt-0.5 shrink-0 text-red-600" />
            <div>
              <p className="text-sm font-bold text-red-950">Why the status is red</p>
              <p className="mt-1 text-sm leading-6 text-red-800">
                {overdueFailures.length > 0 && <>{plural(overdueFailures.length, 'task')} {overdueFailures.length === 1 ? 'is' : 'are'} already past due. </>}
                {upcomingFailures.length > 0 && <>{plural(upcomingFailures.length, 'upcoming task')} cannot fit before {upcomingFailures.length === 1 ? 'its deadline' : 'their deadlines'}, with {duration(upcomingShortfall)} unfinished at the cutoffs. </>}
                Together, every red task leaves <strong>{duration(totalShortfall)} unfinished at its own cutoff</strong>.
              </p>
              {scheduler.gap_minutes > 0 && (
                <p className="mt-2 rounded-lg bg-white/75 px-3 py-2 text-sm leading-6 text-slate-700">
                  You still have <strong>{duration(scheduler.gap_minutes)} spare across the full planning window</strong>. That does not make the plan feasible because those hours arrive after the failing deadlines.
                </p>
              )}

              <div data-testid="shortfall-breakdown" className="mt-3 rounded-xl border border-red-200 bg-white p-4">
                <div className="max-w-4xl">
                  <p className="text-xs font-bold uppercase tracking-[0.12em] text-red-600">What the {duration(totalShortfall)} “doesn’t fit” number contains</p>
                  <p className="mt-1 text-sm leading-6 text-slate-700">
                    It is the <strong>sum of the unfinished amount for each red task at that task’s own deadline</strong>. It is not one {duration(totalShortfall)} block you must somehow do today, and it is not saying the whole planning window lacks {duration(totalShortfall)}.
                  </p>
                </div>
                <div className="mt-3 grid gap-2 xl:grid-cols-2">
                  {overflow.map(failure => {
                    const task = taskLookup[failure.task_id];
                    const goal = task?.goal_id ? goalById.get(task.goal_id) : undefined;
                    return (
                      <div key={failure.task_id} data-testid="shortfall-task" className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-slate-900">{task?.title ?? failure.task_id}</p>
                          <p className="mt-0.5 text-xs leading-5 text-slate-500">{goal?.title ?? 'No goal'} · cutoff {failure.due_date ? dateLabel(failure.due_date) : 'not dated'}</p>
                          <p className="mt-1 text-xs font-semibold text-slate-600">{duration(failure.required_minutes)} remaining − {duration(failure.available_before_deadline_minutes)} reachable before cutoff = {duration(failure.shortfall_minutes)} unfinished</p>
                          {(failure.recovery_allocated_minutes ?? 0) > 0 && (
                            <p className="mt-1 text-xs font-semibold text-indigo-700">
                              Recovery proposal: {duration(failure.recovery_allocated_minutes ?? 0)}{failure.recovery_finish_date ? ` through ${dateLabel(failure.recovery_finish_date)}` : ''}{(failure.unscheduled_minutes ?? 0) > 0 ? `; ${duration(failure.unscheduled_minutes ?? 0)} still outside this planning window` : ''}.
                            </p>
                          )}
                        </div>
                        <span className="justify-self-start whitespace-nowrap rounded-full bg-red-100 px-2.5 py-1 text-xs font-bold text-red-700 sm:justify-self-end">{duration(failure.shortfall_minutes)} does not fit</span>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-bold leading-5 text-red-800">
                  Total unfinished at cutoffs: {overflow.map(item => duration(item.shortfall_minutes)).join(' + ')} = {duration(totalShortfall)}.
                </p>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-800">
          <CheckCircle2 size={18} className="mr-2 inline" />Every task with an estimate currently fits before its deadline.
        </section>
      )}

      <section className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Unfinished at all cutoffs" value={duration(totalShortfall)} note="Sum of the explained red task amounts above" tone={totalShortfall ? 'red' : 'slate'} />
        <Metric label="From passed deadlines" value={duration(overdueShortfall)} note={`${plural(overdueFailures.length, 'task')} already past due`} tone={overdueShortfall ? 'red' : 'slate'} />
        <Metric label="From future deadlines" value={duration(upcomingShortfall)} note={`${plural(upcomingFailures.length, 'task')} still has a future cutoff`} tone={upcomingShortfall ? 'red' : 'slate'} />
        <Metric label="Unknown estimates" value={String(unestimated.length)} note="Not counted in the hour math yet" tone={unestimated.length ? 'amber' : 'slate'} />
      </section>

      <section className="mt-5 rounded-2xl border border-indigo-200 bg-indigo-50/50 p-4">
        <div className="flex gap-3">
          <CircleHelp size={19} className="mt-0.5 shrink-0 text-indigo-600" />
          <div>
            <p className="text-sm font-bold text-indigo-950">What the calculator counts</p>
            <p className="mt-1 text-sm leading-6 text-indigo-800">
              Only unfinished leaf tasks enter the hour math, which prevents parent/child double-counting. Work starts at the latest applicable task/parent/milestone/goal start, and must finish by the earliest applicable cutoff. Missing estimates stay visible as warnings but cannot honestly add hours yet.
            </p>
          </div>
        </div>
      </section>

      <section className="pt-9">
        <div className="mb-4 flex items-center gap-3">
          <Flag size={21} className="text-red-600" />
          <div><h2 className="font-headline text-2xl font-bold text-slate-950">1. Problem deadlines, grouped by date</h2><p className="mt-0.5 text-sm text-slate-500">Each date is one cutoff. Open it to see the tasks that make that cutoff fail or remain unknown.</p></div>
        </div>
        <div className="space-y-3">
          {deadlineGroups.map(group => {
            const isOverdue = Boolean(group.date && group.date < today);
            const hasFailure = group.failures.length > 0;
            return (
              <details key={group.date ?? 'undated'} open={hasFailure} className={`group overflow-hidden rounded-2xl border bg-white ${hasFailure ? 'border-red-200' : 'border-amber-200'}`}>
                <summary className="flex cursor-pointer list-none flex-col gap-3 p-4 hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-base font-bold text-slate-950">{group.date ? dateLabel(group.date, true) : 'No deadline set'}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {isOverdue
                        ? 'This cutoff has passed, so unfinished work has zero future time before it.'
                        : hasFailure
                          ? 'The usable days ending here do not contain enough time for the known work.'
                          : 'The math is incomplete because one or more estimates are missing.'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {isOverdue && <CountPill count={group.failures.length} label="past due" tone="red" />}
                    {!isOverdue && hasFailure && <CountPill count={group.failures.length} label="will miss" tone="red" />}
                    {group.unknowns.length > 0 && <CountPill count={group.unknowns.length} label="unknown" tone="amber" />}
                    <ChevronDown size={18} className="text-slate-400 transition-transform group-open:rotate-180" />
                  </div>
                </summary>
                <div className="border-t border-slate-100 bg-slate-50/50 p-4">
                  <div className="space-y-2">
                    {group.failures.map(failure => {
                      const task = taskLookup[failure.task_id];
                      const goal = task?.goal_id ? goalById.get(task.goal_id) : undefined;
                      return (
                        <div key={failure.task_id} className="rounded-xl border border-red-100 bg-white p-4">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div><p className="font-bold text-slate-900">{task?.title ?? failure.task_id}</p><p className="mt-0.5 text-xs text-slate-500">{goal?.title ?? 'No goal'}</p></div>
                            <span className="self-start rounded-full bg-red-100 px-2.5 py-1 text-xs font-bold text-red-700">{duration(failure.shortfall_minutes)} short</span>
                          </div>
                          <p className="mt-3 text-sm leading-6 text-slate-700">Needs <strong>{duration(failure.required_minutes)}</strong>. The calculator found <strong>{duration(failure.available_before_deadline_minutes)}</strong> before this cutoff, leaving <strong className="text-red-700">{duration(failure.shortfall_minutes)}</strong>.</p>
                          {(failure.recovery_allocated_minutes ?? 0) > 0 && <p className="mt-2 text-xs font-semibold leading-5 text-indigo-700">The best-effort plan still proposes {duration(failure.recovery_allocated_minutes ?? 0)} of recovery work{failure.recovery_finish_date ? ` and projects completion ${dateLabel(failure.recovery_finish_date)}` : ''}.</p>}
                        </div>
                      );
                    })}
                    {group.unknowns.map(item => {
                      const task = taskLookup[item.task_id];
                      const goal = task?.goal_id ? goalById.get(task.goal_id) : undefined;
                      return (
                        <div key={item.task_id} className="rounded-xl border border-amber-100 bg-white p-4">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div><p className="font-bold text-slate-900">{task?.title ?? item.task_id}</p><p className="mt-0.5 text-xs text-slate-500">{goal?.title ?? 'No goal'}</p></div><span className="self-start rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-700">Estimate missing</span></div>
                          <p className="mt-2 text-sm leading-6 text-slate-600">This task is due here but contributes no hours until an estimate is added.</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </details>
            );
          })}
          {!deadlineGroups.length && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-800">No deadline needs attention.</div>}
        </div>
      </section>

      <InteractiveTaskTimeline
        diagnostics={diagnostics}
        taskLookup={taskLookup}
        goalTitles={Object.fromEntries(goals.map(goal => [goal.id, goal.title]))}
        allTasks={allTasks}
        capacityDays={capacityDays}
      />

      <section className="pt-9">
        <details className="group overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 hover:bg-slate-50">
            <div className="flex items-center gap-3">
              <Clock3 size={20} className="text-indigo-600" />
              <div><h2 className="text-base font-bold text-slate-900">Optional: every task as a raw row</h2><p className="mt-0.5 text-sm text-slate-500">Open this only when you want to audit the exact equation and slice table.</p></div>
            </div>
            <ChevronDown size={18} className="text-slate-400 transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-3 border-t border-slate-100 bg-slate-50/40 p-4">
          {taskTimelineRows.map(({ diagnostic, task, slices, finishDate }) => {
            const goalTitle = task?.goal_title ?? (task?.goal_id ? goalById.get(task.goal_id)?.title : null) ?? 'No goal';
            const dueSource = timelineSourceLabel(task?.due_date_source ?? null);
            const startSource = timelineSourceLabel(task?.start_date_source ?? null);
            const estimate = Number(task?.estimated_minutes ?? diagnostic.required_minutes);
            const logged = Number(task?.logged_minutes ?? 0);
            const committed = Number(task?.committed_minutes ?? 0);
            const currentRemaining = Number(task?.remaining_minutes ?? diagnostic.required_minutes);
            const isCovered = diagnostic.outcome === 'fit' && estimate > 0 && currentRemaining === 0;
            const dueDate = diagnostic.due_date;
            const slackDays = finishDate && dueDate ? calendarDayDifference(finishDate, dueDate) : null;
            const outcome = diagnostic.outcome === 'overflow'
              ? `${duration(diagnostic.shortfall_minutes)} left at deadline`
              : diagnostic.outcome === 'unestimated'
                ? 'Estimate needed before time can be calculated'
                : isCovered
                  ? '0 unscheduled time left'
                : slackDays === 0
                  ? 'Finishes on the deadline'
                  : slackDays !== null && slackDays > 0
                    ? `Finishes ${plural(slackDays, 'day')} early`
                    : finishDate ? `Finishes ${dateLabel(finishDate)}` : 'Fits in the planning window';
            const tone = diagnostic.outcome === 'overflow'
              ? 'border-red-200 bg-red-50 text-red-700'
              : diagnostic.outcome === 'unestimated'
                ? 'border-amber-200 bg-amber-50 text-amber-700'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700';

            return (
              <details key={diagnostic.task_id} open={diagnostic.outcome === 'overflow'} className="group overflow-hidden rounded-2xl border border-slate-200 bg-white">
                <summary className="grid cursor-pointer list-none gap-3 p-4 hover:bg-slate-50 md:grid-cols-[1fr_auto_22px] md:items-center">
                  <div className="min-w-0">
                    <p className="truncate text-base font-bold text-slate-950">{task?.title ?? diagnostic.task_id}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {goalTitle} / Can start {dateLabel(diagnostic.earliest_date, true)}
                      {startSource ? ` (${startSource})` : ''}
                      {dueDate ? ` / Due ${dateLabel(dueDate, true)}${dueSource ? ` (${dueSource})` : ''}` : ' / No due date'}
                    </p>
                  </div>
                  <span className={`self-start rounded-full border px-2.5 py-1 text-xs font-bold ${tone}`}>{outcome}</span>
                  <ChevronDown size={18} className="text-slate-400 transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t border-slate-100 bg-slate-50/50 p-4">
                  {diagnostic.outcome === 'unestimated' ? (
                    <div className="rounded-xl border border-amber-200 bg-white p-4">
                      <p className="text-sm font-bold text-amber-800">No honest time math is possible yet.</p>
                      <p className="mt-1 text-sm leading-6 text-slate-600">Add a rough estimate. Marina will subtract logged focus time and calendar work automatically on the next refresh.</p>
                    </div>
                  ) : (
                    <>
                      <div className="rounded-xl border border-indigo-100 bg-white p-4">
                        <p className="text-xs font-bold uppercase tracking-wide text-indigo-600">What is left right now</p>
                        <p className="mt-2 text-lg font-bold tracking-tight text-slate-950">
                          {duration(estimate)} estimate <span className="text-slate-400">-</span> {duration(logged)} logged <span className="text-slate-400">-</span> {duration(committed)} already on calendar <span className="text-slate-400">-&gt;</span> <span className="text-indigo-700">{duration(currentRemaining)} left</span>
                        </p>
                        <p className="mt-2 text-xs leading-5 text-slate-500">Finishing a focus session increases "logged"; adding a timed calendar block increases "already on calendar". The remaining number shrinks on refresh and stops at zero.</p>
                      </div>

                      <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
                        <div className="grid grid-cols-[minmax(120px,1fr)_auto_auto] gap-3 bg-slate-50 px-4 py-2.5 text-xs font-bold text-slate-500">
                          <span>Day</span><span>{diagnostic.outcome === 'overflow' ? 'Possible slice' : 'Planned slice'}</span><span className="text-right">Left after that day</span>
                        </div>
                        <ol className="divide-y divide-slate-100">
                          {slices.filter(slice => slice.allocated_minutes > 0).map(slice => (
                            <li key={slice.date} className="grid grid-cols-[minmax(120px,1fr)_auto_auto] gap-3 px-4 py-3 text-sm">
                              <span className="font-semibold text-slate-800">{dateLabel(slice.date)}</span>
                              <span className="font-bold text-indigo-700">{duration(slice.allocated_minutes)}</span>
                              <span className={`text-right font-bold ${slice.remaining_after ? 'text-slate-700' : 'text-emerald-700'}`}>{slice.remaining_after ? `${duration(slice.remaining_after)} left` : 'Done'}</span>
                            </li>
                          ))}
                          {!slices.some(slice => slice.allocated_minutes > 0) && (
                            <li className="px-4 py-4 text-sm text-slate-500">
                              {isCovered ? 'No new slice is needed: the full estimate is already logged or placed on the calendar.' : 'No usable work slice exists between the start and deadline.'}
                            </li>
                          )}
                        </ol>
                      </div>
                      {diagnostic.outcome === 'overflow' && (
                        <div className="mt-3 space-y-2 text-xs leading-5">
                          <p className="text-red-700">These are deadline-feasibility slices, not kept calendar blocks. Even using every slice shown, {duration(diagnostic.shortfall_minutes)} would still remain at the cutoff.</p>
                          {(diagnostic.recovery_allocated_minutes ?? 0) > 0 && (
                            <p className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 font-semibold text-indigo-800">The schedule proposal does not drop this task: it adds {duration(diagnostic.recovery_allocated_minutes ?? 0)} of best-effort recovery work{diagnostic.recovery_finish_date ? ` through ${dateLabel(diagnostic.recovery_finish_date)}` : ''}{(diagnostic.unscheduled_minutes ?? 0) > 0 ? `, with ${duration(diagnostic.unscheduled_minutes ?? 0)} still beyond the visible horizon` : ''}.</p>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </details>
            );
          })}
          {!taskTimelineRows.length && <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500">No schedulable leaf tasks are available to calculate.</div>}
          </div>
        </details>
      </section>

      {nextFailure && nextFailureTask && nextFailure.due_date && (
        <section className="pt-9">
          <div className="mb-4 flex items-center gap-3">
            <TimerReset size={21} className="text-indigo-600" />
            <div><h2 className="font-headline text-2xl font-bold text-slate-950">3. The next conflict, day by day</h2><p className="mt-0.5 text-sm text-slate-500">This is the calculator's attempted path to the nearest future deadline.</p></div>
          </div>
          <article className="overflow-hidden rounded-2xl border border-red-200 bg-white">
            <div className="border-b border-red-100 bg-red-50/60 p-5">
              <p className="text-lg font-bold text-slate-950">{nextFailureTask.title}</p>
              <p className="mt-1 text-sm leading-6 text-slate-700">Needs <strong>{duration(nextFailure.required_minutes)}</strong> by <strong>{dateLabel(nextFailure.due_date, true)}</strong>. Only <strong>{duration(nextFailure.available_before_deadline_minutes)}</strong> is reachable, so <strong className="text-red-700">{duration(nextFailure.shortfall_minutes)} remains unfinished</strong>.</p>
            </div>
            <ol className="divide-y divide-slate-100">
              {nextFailureDays.map(day => (
                <li key={day.date} className="grid gap-2 px-5 py-4 md:grid-cols-[150px_1fr_180px] md:items-center">
                  <div><p className="font-bold text-slate-900">{dateLabel(day.date)}</p>{day.date === nextFailure.due_date && <span className="mt-1 inline-block rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-700">Deadline</span>}</div>
                  <p className="text-sm leading-6 text-slate-600">
                    {day.usable > 0 ? <>{duration(day.usable)} usable{day.claimed > 0 ? `; ${duration(day.claimed)} already claimed by earlier-deadline work` : ''}; <strong>{duration(day.given)}</strong> can go to this task.</> : <>No planning capacity on this day.</>}
                  </p>
                  <p className={`text-sm font-bold md:text-right ${day.remaining ? 'text-red-700' : 'text-emerald-700'}`}>{duration(day.remaining)} still left</p>
                </li>
              ))}
            </ol>
            <p className="border-t border-slate-100 bg-slate-50 px-5 py-3 text-xs leading-5 text-slate-500">The calculator rolls this trial allocation back after it fails, which is why these hours may look free on the normal calendar.</p>
          </article>
        </section>
      )}

      <section className="pt-9">
        <div className="mb-4 flex items-center gap-3">
          <CalendarDays size={21} className="text-indigo-600" />
          <div><h2 className="font-headline text-2xl font-bold text-slate-950">{nextFailure ? '4' : '3'}. The selected week, day by day</h2><p className="mt-0.5 text-sm text-slate-500">The task count, estimate quality, and goal markers for each calendar day.</p></div>
        </div>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Task dates this week" value={String(weekDue)} note="Every incomplete task shown on a due date" />
          <Metric label="Known work" value={duration(weekKnownMinutes)} note={`${plural(weekEstimated, 'estimated leaf task')} in the math`} tone="indigo" />
          <Metric label="Incomplete math" value={String(weekMissing + weekContext)} note={`${weekMissing} missing estimates; ${weekContext} context-only items`} tone={weekMissing ? 'amber' : 'slate'} />
          <Metric label="Goal markers" value={String(weekGoalDeadlines)} note="Visible cutoffs that do not add hours by themselves" />
        </div>
        <div className="space-y-3">
          {weekRows.map(row => {
            const isPast = row.date < today;
            const hasAttention = row.failures.length > 0 || row.missing.length > 0;
            return (
              <details key={row.date} open={hasAttention} className={`group overflow-hidden rounded-2xl border bg-white ${row.failures.length ? 'border-red-300' : row.missing.length ? 'border-amber-200' : 'border-slate-200'}`}>
                <summary className="grid cursor-pointer list-none gap-3 p-4 hover:bg-slate-50 md:grid-cols-[165px_1fr_auto_22px] md:items-center">
                  <div><p className="text-base font-bold text-slate-900">{dateLabel(row.date)}</p><p className="mt-0.5 text-xs text-slate-400">{row.capacity ? `${duration(row.capacity.available_minutes)} usable` : isPast ? 'Past day' : 'Off day; no planning capacity'}</p></div>
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-600">{row.dueTasks.length ? row.dueTasks.map(task => task.title).join(' · ') : 'No tasks due'}</p>
                    {row.goalDeadlines.length > 0 && <p className="mt-1 truncate text-xs font-semibold text-orange-600">Goal marker: {row.goalDeadlines.map(item => item.title).join(' · ')}</p>}
                  </div>
                  <div className="flex flex-wrap gap-1.5"><CountPill count={row.dueTasks.length} label="due" tone={row.failures.length ? 'red' : 'blue'} />{row.missing.length > 0 && <CountPill count={row.missing.length} label="unknown" tone="amber" />}{row.context.length > 0 && <CountPill count={row.context.length} label="context" tone="slate" />}</div>
                  <ChevronDown size={18} className="text-slate-400 transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t border-slate-100 bg-slate-50/40 p-4">
                  {row.dueTasks.length === 0 && row.goalDeadlines.length === 0 ? <p className="text-sm text-slate-500">Nothing is due on this date.</p> : (
                    <div className="grid gap-4 lg:grid-cols-3">
                      <div className="rounded-xl border border-indigo-100 bg-white p-4"><h3 className="text-sm font-bold text-indigo-800">Estimated work · {row.estimated.length}</h3><p className="mt-1 text-xs text-slate-500">{duration(row.knownMinutes)} remaining in the feasibility math</p><div className="mt-3">{row.estimated.length ? row.estimated.map(renderTask) : <p className="text-sm text-slate-400">None</p>}</div></div>
                      <div className="rounded-xl border border-amber-100 bg-white p-4"><h3 className="text-sm font-bold text-amber-800">Missing estimates · {row.missing.length}</h3><p className="mt-1 text-xs text-slate-500">Due, but not included in any hour total</p><div className="mt-3">{row.missing.length ? row.missing.map(renderTask) : <p className="text-sm text-slate-400">None</p>}</div></div>
                      <div className="rounded-xl border border-slate-200 bg-white p-4"><h3 className="text-sm font-bold text-slate-700">Context only · {row.context.length}</h3><p className="mt-1 text-xs text-slate-500">Visible on the calendar, excluded from planner math</p><div className="mt-3">{row.context.length ? row.context.map(renderTask) : <p className="text-sm text-slate-400">None</p>}</div></div>
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      </section>

      <section className="pt-9">
        <details className="group overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 hover:bg-slate-50"><div className="flex items-center gap-3"><Clock3 size={20} className="text-indigo-600" /><div><h2 className="text-base font-bold text-slate-900">Capacity settings and exact weekly hours</h2><p className="mt-0.5 text-sm text-slate-500">Optional audit details. The explanation above is all you need for the result.</p></div></div><ChevronDown size={18} className="text-slate-400 transition-transform group-open:rotate-180" /></summary>
          <div className="border-t border-slate-100 p-5">
            <div className="grid gap-3 sm:grid-cols-4"><Metric label="Work window" value={`${hourLabel(Number(prefs?.work_start ?? 9))}–${hourLabel(Number(prefs?.work_end ?? 18))}`} note="Configured working range" /><Metric label="Daily setting" value={duration(rawDaily)} note="Maximum before safety buffer" /><Metric label="Safety buffer" value={`−${duration(bufferMinutes)}`} note="Reserved, not plan-filled" /><Metric label="Normal focus cap" value={duration(effectiveDaily)} note="Before meetings, blocks, or overrides" tone="indigo" /></div>
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[650px] text-left text-sm"><thead><tr className="bg-slate-50 text-xs text-slate-500"><th className="px-4 py-3">Day</th><th className="px-4 py-3">Usable</th><th className="px-4 py-3">Kept in plan</th><th className="px-4 py-3">Free after kept work</th><th className="px-4 py-3">Task dates</th></tr></thead><tbody className="divide-y divide-slate-100">{weekRows.map(day => <tr key={day.date}><td className="px-4 py-3 font-semibold text-slate-800">{dateLabel(day.date)}</td><td className="px-4 py-3">{day.capacity ? duration(day.capacity.available_minutes) : day.date < today ? 'Past day' : 'Off day'}</td><td className="px-4 py-3">{duration(day.capacity?.used_minutes ?? 0)}</td><td className="px-4 py-3">{duration(day.capacity ? Math.max(0, day.capacity.available_minutes - day.capacity.used_minutes) : 0)}</td><td className="px-4 py-3 font-semibold">{day.dueTasks.length}</td></tr>)}</tbody></table></div>
            <p className="mt-3 text-sm leading-6 text-slate-500">Selected-week usable capacity: <strong className="text-slate-800">{duration(weekCapacity)}</strong>. Failed trial allocations are rolled back, so “free” here does not mean an earlier deadline can use time after its cutoff.</p>
          </div>
        </details>
      </section>
    </div>
  );
}
