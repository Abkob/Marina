import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle, CalendarClock, CheckCircle2, ChevronLeft, ChevronRight,
  CircleHelp, Pause, Play, RotateCcw, Sparkles,
} from 'lucide-react';
import type { SchedulerResult, ScheduleTaskInfo, ScheduleTimelineSource } from '../../api/hooks';
import type { DBTask } from '../../db/schema';
import { parseLocalDate } from '../../utils/calendar';
import { HierarchyWorkloadPanel } from './HierarchyWorkloadPanel';

type Diagnostic = SchedulerResult['task_diagnostics'][number];
type Filter = 'all' | 'attention' | 'fits' | 'unknown';

type Props = {
  diagnostics: Diagnostic[];
  taskLookup: Record<string, ScheduleTaskInfo>;
  goalTitles: Record<string, string>;
  allTasks: DBTask[];
  capacityDays: SchedulerResult['capacity_days'];
};

type TimelineStep = {
  key: string;
  kind: 'start' | 'work' | 'deadline';
  date: string;
  allocated: number;
  before: number;
  remaining: number;
  capacity: number;
  claimed: number;
};

function duration(minutes: number) {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function dateLabel(date: string, long = false) {
  return parseLocalDate(date).toLocaleDateString('en-US', long
    ? { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric' });
}

function sourceLabel(source: ScheduleTimelineSource | null | undefined) {
  if (!source) return null;
  const scope = { task: 'task', parent_task: 'parent task', milestone: 'milestone', goal: 'goal' }[source.scope];
  const field = {
    start_date: 'start', hard_deadline: 'hard deadline', target_date: 'target',
    due_date: 'due date', deadline: 'deadline',
  }[source.field];
  return `${scope} ${field}`;
}

function buildSteps(diagnostic: Diagnostic): TimelineStep[] {
  const startStep: TimelineStep = {
    key: `start-${diagnostic.task_id}`,
    kind: 'start',
    date: diagnostic.earliest_date,
    allocated: 0,
    before: diagnostic.required_minutes,
    remaining: diagnostic.required_minutes,
    capacity: 0,
    claimed: 0,
  };
  const deadlineStep = diagnostic.due_date ? {
    key: `deadline-${diagnostic.task_id}`,
    kind: 'deadline' as const,
    date: diagnostic.due_date,
    allocated: 0,
    before: diagnostic.outcome === 'overflow' ? diagnostic.shortfall_minutes : diagnostic.required_minutes,
    remaining: diagnostic.outcome === 'overflow' ? diagnostic.shortfall_minutes : diagnostic.required_minutes,
    capacity: 0,
    claimed: 0,
  } : null;

  // Overdue stories must read in calendar order: the cutoff passed first,
  // then today arrived with the work still unfinished.
  if (deadlineStep && deadlineStep.date < diagnostic.earliest_date) return [deadlineStep, startStep];

  const steps: TimelineStep[] = [startStep];
  let remaining = diagnostic.required_minutes;
  for (const [index, day] of diagnostic.days.entries()) {
    if (day.allocated_minutes <= 0) continue;
    const before = remaining;
    remaining = Math.max(0, remaining - day.allocated_minutes);
    steps.push({
      key: `work-${diagnostic.task_id}-${day.date}-${index}`,
      kind: 'work',
      date: day.date,
      allocated: day.allocated_minutes,
      before,
      remaining,
      capacity: day.capacity_minutes,
      claimed: day.committed_before_minutes,
    });
  }
  if (deadlineStep) {
    steps.push({
      ...deadlineStep,
      before: diagnostic.outcome === 'overflow' ? diagnostic.shortfall_minutes : remaining,
      remaining: diagnostic.outcome === 'overflow' ? diagnostic.shortfall_minutes : remaining,
    });
  }
  return steps;
}

export function InteractiveTaskTimeline({ diagnostics, taskLookup, goalTitles, allTasks, capacityDays }: Props) {
  const reduceMotion = useReducedMotion();
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const stepRefs = useRef(new Map<number, HTMLButtonElement>());

  const sortedDiagnostics = useMemo(() => [...diagnostics].sort((a, b) => {
    const rank = { overflow: 0, unestimated: 1, fit: 2 };
    const outcome = rank[a.outcome] - rank[b.outcome];
    if (outcome) return outcome;
    return String(a.due_date ?? '9999-12-31').localeCompare(String(b.due_date ?? '9999-12-31'));
  }), [diagnostics]);

  const visibleDiagnostics = useMemo(() => sortedDiagnostics.filter(item => {
    if (filter === 'attention') return item.outcome === 'overflow';
    if (filter === 'fits') return item.outcome === 'fit';
    if (filter === 'unknown') return item.outcome === 'unestimated';
    return true;
  }), [filter, sortedDiagnostics]);

  useEffect(() => {
    if (!visibleDiagnostics.some(item => item.task_id === selectedId)) {
      setSelectedId(visibleDiagnostics[0]?.task_id ?? null);
    }
  }, [selectedId, visibleDiagnostics]);

  const selectedDiagnostic = visibleDiagnostics.find(item => item.task_id === selectedId) ?? visibleDiagnostics[0] ?? null;
  const task = selectedDiagnostic ? taskLookup[selectedDiagnostic.task_id] : undefined;
  const steps = useMemo(() => selectedDiagnostic ? buildSteps(selectedDiagnostic) : [], [selectedDiagnostic]);
  const safeStepIndex = Math.min(stepIndex, Math.max(0, steps.length - 1));
  const step = steps[safeStepIndex];

  useEffect(() => {
    setStepIndex(0);
    setPlaying(false);
  }, [selectedDiagnostic?.task_id]);

  useEffect(() => {
    if (!playing || steps.length <= 1) return;
    if (safeStepIndex >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setStepIndex(index => Math.min(index + 1, steps.length - 1)), reduceMotion ? 1200 : 900);
    return () => window.clearTimeout(timer);
  }, [playing, reduceMotion, safeStepIndex, steps.length]);

  useEffect(() => {
    const rail = railRef.current;
    const node = stepRefs.current.get(safeStepIndex);
    if (!rail || !node) return;
    const left = Math.max(0, node.offsetLeft - rail.clientWidth / 2 + node.clientWidth / 2);
    if (typeof rail.scrollTo === 'function') rail.scrollTo({ left, behavior: reduceMotion ? 'auto' : 'smooth' });
    else rail.scrollLeft = left;
  }, [reduceMotion, safeStepIndex, selectedDiagnostic?.task_id]);

  if (!diagnostics.length) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500">No schedulable leaf tasks are available to explore.</div>;
  }

  const taskIndex = visibleDiagnostics.findIndex(item => item.task_id === selectedDiagnostic?.task_id);
  const estimate = Number(task?.estimated_minutes ?? selectedDiagnostic?.required_minutes ?? 0);
  const logged = Number(task?.logged_minutes ?? 0);
  const committed = Number(task?.committed_minutes ?? 0);
  const currentRemaining = Number(task?.remaining_minutes ?? selectedDiagnostic?.required_minutes ?? 0);
  const goalTitle = task?.goal_id ? goalTitles[task.goal_id] ?? task.goal_title : task?.goal_title;
  const isOverflow = selectedDiagnostic?.outcome === 'overflow';
  const isUnknown = selectedDiagnostic?.outcome === 'unestimated';
  const isOverdue = Boolean(selectedDiagnostic?.due_date && selectedDiagnostic.due_date < selectedDiagnostic.earliest_date);
  const progress = selectedDiagnostic && selectedDiagnostic.required_minutes > 0 && step
    ? Math.round((1 - step.remaining / selectedDiagnostic.required_minutes) * 100)
    : isUnknown ? 0 : 100;
  const counts = {
    all: sortedDiagnostics.length,
    attention: sortedDiagnostics.filter(item => item.outcome === 'overflow').length,
    fits: sortedDiagnostics.filter(item => item.outcome === 'fit').length,
    unknown: sortedDiagnostics.filter(item => item.outcome === 'unestimated').length,
  };

  const selectTaskAt = (index: number) => {
    const next = visibleDiagnostics[index];
    if (next) setSelectedId(next.task_id);
  };
  const selectStep = (index: number) => {
    setStepIndex(Math.max(0, Math.min(index, steps.length - 1)));
    setPlaying(false);
  };

  const explanation = !selectedDiagnostic || !step
    ? ''
    : isUnknown
      ? 'Marina knows the date, but not the size of the work. Add even a rough estimate to unlock the time calculation.'
      : step.kind === 'start'
        ? isOverdue
          ? `Today arrived with ${duration(step.remaining)} still unfinished. Because the deadline is already behind us, no future work can make that old cutoff feasible.`
          : `${duration(step.remaining)} is unscheduled at the starting line. Move forward to see exactly how each work slice reduces it.`
        : step.kind === 'work'
          ? `On ${dateLabel(step.date, true)}, Marina gives this task ${duration(step.allocated)}. The amount left falls from ${duration(step.before)} to ${duration(step.remaining)}.`
          : isOverflow
            ? `The cutoff arrives with ${duration(step.remaining)} unfinished. That remaining red amount is exactly why the whole schedule is marked impossible.`
            : step.remaining === 0
              ? 'The deadline arrives with nothing left. This task fits.'
              : `${duration(step.remaining)} remains at the planning cutoff.`;

  return (
    <section className="pt-9">
      <div className="mb-4 flex items-start gap-3">
        <Sparkles size={21} className="mt-1 shrink-0 text-indigo-600" />
        <div>
          <h2 className="font-headline text-2xl font-bold text-slate-950">2. Explore the time left, one day at a time</h2>
          <p className="mt-0.5 max-w-3xl text-sm leading-6 text-slate-500">Choose a task, then scroll, click, drag the scrubber, or press Play. The number answers one question only: after this day, how much work is still unfinished?</p>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter timeline tasks">
        {([
          ['all', 'All tasks'], ['attention', 'Will miss'], ['fits', 'Fits'], ['unknown', 'Needs estimate'],
        ] as Array<[Filter, string]>).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`rounded-full border px-3 py-1.5 text-xs font-bold transition ${filter === value ? 'border-indigo-600 bg-indigo-600 text-white shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-700'}`}
            aria-pressed={filter === value}
          >
            {label} ({counts[value]})
          </button>
        ))}
      </div>

      {visibleDiagnostics.length > 1 && (
        <label className="mb-3 block max-w-xl">
          <span className="mb-1 block text-xs font-bold text-slate-500">Jump directly to a task or subtask</span>
          <select value={selectedDiagnostic?.task_id ?? ''} onChange={event => setSelectedId(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-800 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100">
            {visibleDiagnostics.map(item => {
              const optionTask = taskLookup[item.task_id];
              return <option key={item.task_id} value={item.task_id}>{optionTask?.goal_title ? `${optionTask.goal_title} / ` : ''}{optionTask?.title ?? item.task_id}{item.outcome === 'overflow' ? ' (will miss)' : item.outcome === 'unestimated' ? ' (needs estimate)' : ''}</option>;
            })}
          </select>
        </label>
      )}

      {!selectedDiagnostic ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500">No tasks match this filter.</div>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.article
            key={selectedDiagnostic.task_id}
            initial={reduceMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
            className={`overflow-hidden rounded-3xl border-2 bg-white shadow-sm ${isOverflow ? 'border-red-200' : isUnknown ? 'border-amber-200' : 'border-indigo-200'}`}
          >
            <div className="grid gap-4 border-b border-slate-100 bg-slate-50/70 p-4 lg:grid-cols-[auto_1fr_auto] lg:items-center">
              <button type="button" onClick={() => selectTaskAt(taskIndex - 1)} disabled={taskIndex <= 0} className="hidden h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-30 lg:flex" aria-label="Previous task"><ChevronLeft size={19} /></button>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-400">Task {taskIndex + 1} of {visibleDiagnostics.length}</p>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${isOverflow ? 'bg-red-100 text-red-700' : isUnknown ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>{isOverflow ? 'Deadline conflict' : isUnknown ? 'Math incomplete' : 'Fits'}</span>
                </div>
                <h3 className="mt-1 truncate font-headline text-xl font-bold text-slate-950">{task?.title ?? selectedDiagnostic.task_id}</h3>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  {goalTitle ?? 'No goal'} / {isOverdue
                    ? `Deadline ${dateLabel(selectedDiagnostic.due_date!, true)} (${sourceLabel(task?.due_date_source) ?? 'cutoff'}) / Today ${dateLabel(selectedDiagnostic.earliest_date, true)}`
                    : `Start ${dateLabel(selectedDiagnostic.earliest_date, true)} (${sourceLabel(task?.start_date_source) ?? 'today'})${selectedDiagnostic.due_date ? ` / Due ${dateLabel(selectedDiagnostic.due_date, true)} (${sourceLabel(task?.due_date_source) ?? 'cutoff'})` : ''}`}
                </p>
              </div>
              <button type="button" onClick={() => selectTaskAt(taskIndex + 1)} disabled={taskIndex < 0 || taskIndex >= visibleDiagnostics.length - 1} className="hidden h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-30 lg:flex" aria-label="Next task"><ChevronRight size={19} /></button>
              <div className="flex gap-2 lg:hidden">
                <button type="button" onClick={() => selectTaskAt(taskIndex - 1)} disabled={taskIndex <= 0} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold disabled:opacity-30">Previous task</button>
                <button type="button" onClick={() => selectTaskAt(taskIndex + 1)} disabled={taskIndex >= visibleDiagnostics.length - 1} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold disabled:opacity-30">Next task</button>
              </div>
            </div>

            <div className="grid gap-3 p-4 sm:grid-cols-4">
              <div className="rounded-2xl bg-slate-50 p-3"><p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Estimate</p><p className="mt-1 text-lg font-bold text-slate-900">{estimate > 0 ? duration(estimate) : 'Missing'}</p></div>
              <div className="rounded-2xl bg-emerald-50 p-3"><p className="text-[11px] font-bold uppercase tracking-wide text-emerald-600">Already logged</p><p className="mt-1 text-lg font-bold text-emerald-800">{logged > 0 ? `- ${duration(logged)}` : '0m'}</p></div>
              <div className="rounded-2xl bg-blue-50 p-3"><p className="text-[11px] font-bold uppercase tracking-wide text-blue-600">On calendar</p><p className="mt-1 text-lg font-bold text-blue-800">{committed > 0 ? `- ${duration(committed)}` : '0m'}</p></div>
              <div className={`rounded-2xl p-3 ${isOverflow ? 'bg-red-50' : isUnknown ? 'bg-amber-50' : 'bg-indigo-50'}`}><p className={`text-[11px] font-bold uppercase tracking-wide ${isOverflow ? 'text-red-600' : isUnknown ? 'text-amber-600' : 'text-indigo-600'}`}>Unscheduled now</p><p className={`mt-1 text-lg font-bold ${isOverflow ? 'text-red-800' : isUnknown ? 'text-amber-800' : 'text-indigo-800'}`}>{isUnknown ? '?' : duration(currentRemaining)}</p></div>
            </div>

            <div className="px-4 pb-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-950 p-4 text-white">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.12em] text-indigo-300">At this point in the timeline</p>
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.p key={`${selectedDiagnostic.task_id}-${safeStepIndex}`} initial={reduceMotion ? false : { opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} exit={reduceMotion ? undefined : { opacity: 0, y: -5 }} className="mt-1 text-3xl font-bold tracking-tight" aria-live="polite">
                        {isUnknown ? 'Unknown time left' : `${duration(step?.remaining ?? 0)} left`}
                      </motion.p>
                    </AnimatePresence>
                    <p className="mt-1 text-xs text-slate-400">{step ? dateLabel(step.date, true) : ''}</p>
                  </div>
                  <p className="max-w-xl text-sm leading-6 text-slate-200">{explanation}</p>
                </div>
                <div className="mt-4 h-3 overflow-hidden rounded-full bg-white/10" aria-label={`${progress}% of remaining scheduled work removed by this point`}>
                  <motion.div className={`h-full rounded-full ${isOverflow && step?.kind === 'deadline' ? 'bg-red-400' : 'bg-indigo-400'}`} animate={{ width: `${Math.max(2, progress)}%` }} transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 130, damping: 22 }} />
                </div>
                <div className="mt-1 flex justify-between text-[11px] font-semibold text-slate-400"><span>Starting work</span><span>{progress}% worked through</span></div>
              </div>
            </div>

            <div className="border-y border-slate-100 bg-gradient-to-r from-indigo-50/40 via-white to-red-50/40 px-4 py-5">
              <div ref={railRef} className="relative flex snap-x snap-mandatory gap-3 overflow-x-auto pb-3 pt-2" aria-label="Scrollable task timeline" onKeyDown={event => {
                if (event.key === 'ArrowRight') selectStep(safeStepIndex + 1);
                if (event.key === 'ArrowLeft') selectStep(safeStepIndex - 1);
              }}>
                <div className="pointer-events-none absolute left-8 right-8 top-[45px] h-1 rounded-full bg-slate-200" />
                {steps.map((item, index) => {
                  const selected = index === safeStepIndex;
                  const deadline = item.kind === 'deadline';
                  const work = item.kind === 'work';
                  return (
                    <motion.button
                      key={item.key}
                      ref={node => { if (node) stepRefs.current.set(index, node); else stepRefs.current.delete(index); }}
                      type="button"
                      onClick={() => selectStep(index)}
                      animate={{ scale: selected && !reduceMotion ? 1.035 : 1 }}
                      className={`relative z-10 min-w-[190px] snap-center rounded-2xl border-2 p-4 text-left shadow-sm transition-colors ${selected ? deadline && isOverflow ? 'border-red-500 bg-red-50' : 'border-indigo-500 bg-indigo-50' : deadline ? 'border-red-200 bg-white' : 'border-slate-200 bg-white hover:border-indigo-300'}`}
                      aria-current={selected ? 'step' : undefined}
                    >
                      <span className={`mb-4 flex h-8 w-8 items-center justify-center rounded-full border-4 border-white shadow ${deadline ? 'bg-red-500 text-white' : work ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-white'}`}>
                        {deadline ? <CalendarClock size={15} /> : work ? <span className="text-[11px] font-black">{index}</span> : <RotateCcw size={14} />}
                      </span>
                      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{deadline ? isOverdue ? 'Deadline passed' : 'Deadline' : work ? 'Work slice' : isOverdue ? 'Today' : 'Starting point'}</p>
                      <p className="mt-1 font-bold text-slate-900">{dateLabel(item.date)}</p>
                      <p className={`mt-2 text-sm font-bold ${deadline && item.remaining > 0 ? 'text-red-700' : item.remaining === 0 ? 'text-emerald-700' : 'text-indigo-700'}`}>
                        {work ? `${duration(item.allocated)} work -> ` : ''}{isUnknown ? '? left' : item.remaining === 0 ? 'Done' : `${duration(item.remaining)} left`}
                      </p>
                    </motion.button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-4 p-4 lg:grid-cols-[auto_1fr_auto] lg:items-center">
              <div className="flex gap-2">
                <button type="button" onClick={() => selectStep(safeStepIndex - 1)} disabled={safeStepIndex <= 0} className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:border-indigo-300 disabled:opacity-30" aria-label="Previous timeline point"><ChevronLeft size={18} /></button>
                <button type="button" onClick={() => selectStep(safeStepIndex + 1)} disabled={safeStepIndex >= steps.length - 1} className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:border-indigo-300 disabled:opacity-30" aria-label="Next timeline point"><ChevronRight size={18} /></button>
                <button type="button" onClick={() => {
                  if (safeStepIndex >= steps.length - 1) setStepIndex(0);
                  setPlaying(value => !value);
                }} disabled={steps.length <= 1 || isUnknown} className="flex h-10 items-center gap-2 rounded-full bg-indigo-600 px-4 text-xs font-bold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-40">
                  {playing ? <><Pause size={15} /> Pause</> : <><Play size={15} /> Play</>}
                </button>
              </div>
              <label className="block min-w-0">
                <span className="sr-only">Scrub through the task timeline</span>
                <input type="range" min={0} max={Math.max(0, steps.length - 1)} value={safeStepIndex} onChange={event => selectStep(Number(event.target.value))} className="w-full accent-indigo-600" disabled={steps.length <= 1} />
                <span className="mt-1 flex justify-between text-[11px] font-semibold text-slate-400"><span>{isOverdue ? 'Deadline passed' : 'Start'}</span><span>Drag to understand each day</span><span>{isOverdue ? 'Today' : 'Deadline'}</span></span>
              </label>
              <div className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold ${isOverflow ? 'bg-red-50 text-red-700' : isUnknown ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>
                {isOverflow ? <AlertTriangle size={16} /> : isUnknown ? <CircleHelp size={16} /> : <CheckCircle2 size={16} />}
                {isOverflow ? `${duration(selectedDiagnostic.shortfall_minutes)} misses cutoff` : isUnknown ? 'Add estimate to unlock' : 'Fits before cutoff'}
              </div>
            </div>

            <HierarchyWorkloadPanel
              selectedTaskId={selectedDiagnostic.task_id}
              diagnostics={diagnostics}
              taskLookup={taskLookup}
              allTasks={allTasks}
              capacityDays={capacityDays}
            />
          </motion.article>
        </AnimatePresence>
      )}
    </section>
  );
}
