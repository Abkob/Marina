import { useEffect, useState } from 'react';
import { Check, ChevronDown, MoreHorizontal, Pencil, Play, Plus, Repeat2, RotateCcw, SkipForward } from 'lucide-react';
import { useArchiveRoutine, useRoutineCheckIn, useRoutineEntries, useRoutines } from '../../api/routines';
import type { DBGoal } from '../../db/schema';
import type { DBRoutine } from '../../types/routines';
import { addRoutineDays, routineEligibleOn, routineForDate, routineProgress, routineTimeLabel, routineWeekStart } from '../../utils/routines';
import { fmtYMD, parseLocalDate } from '../../utils/calendar';

export interface RoutinesPanelProps {
  date: string;
  today?: string;
  goals: DBGoal[];
  onCreate: () => void;
  onEdit?: (routine: DBRoutine) => void;
  onStartFocus: (routine: DBRoutine, date: string) => void;
}

const ICON = 'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-50 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-teal-600 disabled:opacity-40';
const ACTION = 'flex min-h-11 items-center gap-2 rounded-lg px-3 text-xs text-slate-600 hover:bg-white focus-visible:outline-2 focus-visible:outline-teal-600 disabled:opacity-40';
const shortDate = (date: string) => parseLocalDate(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function RoutinesPanel({ date, today: todayProp, goals, onCreate, onEdit, onStartFocus }: RoutinesPanelProps) {
  const routines = useRoutines();
  const from = routineWeekStart(date);
  const to = addRoutineDays(from, 6);
  const entries = useRoutineEntries(from, to);
  const checkIn = useRoutineCheckIn();
  const archive = useArchiveRoutine();
  const [selectedDate, setSelectedDate] = useState(date);
  const [showAll, setShowAll] = useState(false);
  const [showStopped, setShowStopped] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { setSelectedDate(date); setExpanded(null); }, [date]);
  const today = todayProp ?? fmtYMD(new Date());
  const all = routines.data ?? [];
  const history = entries.data ?? [];
  const rows = all.filter(routine => !routine.archived_at || showStopped || history.some(entry => entry.routine_id === routine.id))
    .map(original => ({ original, routine: routineForDate(original, selectedDate), progress: routineProgress(original, history, selectedDate) }));
  const visible = showAll ? rows : rows.slice(0, 3);
  const loading = routines.isPending || entries.isPending;
  const loadError = routines.isError || entries.isError;
  const busy = checkIn.isPending || archive.isPending;

  async function record(routineId: string, status: 'completed' | 'skipped' | 'pending') {
    setError('');
    try { await checkIn.mutateAsync({ routineId, date: selectedDate, status }); setExpanded(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save. Please try again.'); }
  }
  async function stop(routineId: string) {
    setError('');
    try { await archive.mutateAsync({ routineId, archived: true }); setExpanded(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not stop repeating. Please try again.'); }
  }

  return <section aria-label="Routines" className="mb-3 min-w-0 overflow-hidden rounded-2xl border border-slate-100 bg-white">
    <header className="flex items-center justify-between gap-2 px-4 py-2">
      <div className="min-w-0"><h2 className="flex items-center gap-2 text-sm font-medium text-slate-800"><Repeat2 size={15} className="text-teal-600" />Repeating time</h2><p className="mt-1 text-xs text-slate-400">{from === routineWeekStart(today) ? 'This week' : `${shortDate(from)} – ${shortDate(to)}`} · hours & sessions</p></div>
      <button type="button" aria-label="Add routine" title="Add repeating time" onClick={onCreate} className={ICON}><Plus size={18} /></button>
    </header>
    <div className="routine-days grid grid-cols-7 gap-1 border-t border-slate-100 px-3 py-2" aria-label="Routine days">{Array.from({ length: 7 }, (_, index) => {
      const day = addRoutineDays(from, index);
      return <button key={day} type="button" aria-label={parseLocalDate(day).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} aria-pressed={day === selectedDate} onClick={() => { setSelectedDate(day); setExpanded(null); }} className={`flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-xl text-xs focus-visible:outline-2 focus-visible:outline-teal-600 ${day === selectedDate ? 'bg-slate-100 text-slate-900' : 'text-slate-400 hover:bg-slate-50'}`}><span className="text-[10px]">{['M', 'T', 'W', 'T', 'F', 'S', 'S'][index]}</span><span className={day === today ? 'font-semibold text-teal-700' : ''}>{Number(day.slice(-2))}</span></button>;
    })}</div>
    {loading ? <p role="status" className="px-4 py-5 text-sm text-slate-500">Loading routines…</p> : loadError ? <div role="alert" className="px-4 py-4 text-sm text-rose-700">Could not load your routines.<button type="button" onClick={() => { void routines.refetch(); void entries.refetch(); }} className="ml-2 min-h-11 px-3 underline">Retry</button></div> : rows.length === 0 ? <div className="border-t border-slate-100 px-4 py-5"><p className="text-sm text-slate-600">Make room for what you return to.</p><p className="mt-1 text-xs leading-5 text-slate-400">45 minutes of revision, 3 times a week. Pick days or keep them flexible.</p><button type="button" onClick={onCreate} className="mt-2 min-h-11 text-xs text-teal-700">Add repeating time</button></div> : <div className="divide-y divide-slate-100 border-t border-slate-100">
      {visible.map(({ original, routine, progress }) => {
        const finished = progress.status === 'completed' || progress.status === 'skipped';
        const eligible = routineEligibleOn(original, selectedDate);
        const canAct = eligible && !routine.archived_at;
        const goal = goals.find(item => item.id === routine.goal_id);
        const nextChange = (original.schedule_history ?? []).find(item => item.before > today);
        return <article key={routine.id} aria-label={routine.title} className="px-4 py-3">
          <div className="flex items-start gap-1"><div className="min-w-0 flex-1 pt-1"><h3 className="break-words text-sm font-medium text-slate-800">{routine.title}</h3><p className="mt-1 flex flex-wrap gap-x-1.5 text-xs text-slate-500"><span>{routineTimeLabel(routine.planned_minutes)} × {routine.cadence === 'weekly' ? routine.weekly_target : routine.weekdays.length} / week</span><span>· {routine.preferred_time ?? 'Anytime'}</span></p>{goal && <p className="mt-1 truncate text-[11px] text-slate-400">{goal.title}</p>}</div>
            {canAct && selectedDate === today && !finished && <button type="button" disabled={busy} aria-label={`Start focus for ${routine.title}`} title="Start timer" onClick={() => onStartFocus(routine, selectedDate)} className={`${ICON} text-teal-600`}><Play size={16} /></button>}
            <button type="button" aria-label={`Options for ${routine.title}`} aria-expanded={expanded === routine.id} onClick={() => setExpanded(expanded === routine.id ? null : routine.id)} className={ICON}><MoreHorizontal size={17} /></button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 text-[11px]"><span className="text-slate-500">{routineTimeLabel(progress.weekMinutes)} <span className="text-slate-400">logged / {routineTimeLabel(progress.weekPlannedMinutes)} planned</span></span><span className="shrink-0 text-slate-400">{progress.weekCompleted}/{progress.weekTarget} sessions</span></div>
          <div role="meter" aria-label={`Weekly hours for ${routine.title}`} aria-valuemin={0} aria-valuemax={Math.max(1, progress.weekPlannedMinutes)} aria-valuenow={Math.min(progress.weekMinutes, Math.max(1, progress.weekPlannedMinutes))} aria-valuetext={`${routineTimeLabel(progress.weekMinutes)} logged of ${routineTimeLabel(progress.weekPlannedMinutes)} planned`} className="mt-2 h-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-teal-500/65" style={{ width: `${Math.min(100, progress.weekMinutes / Math.max(1, progress.weekPlannedMinutes) * 100)}%` }} /></div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-[11px] text-slate-400"><span>{selectedDate === today ? 'Today' : shortDate(selectedDate)} · {progress.status === 'completed' ? 'Session finished' : progress.status === 'skipped' ? 'Skipped' : !eligible ? 'No session' : progress.weekTarget > 0 && progress.remainingThisWeek === 0 ? 'Weekly sessions complete' : progress.minutes ? `${routineTimeLabel(progress.minutes)} logged` : selectedDate < today ? 'No time logged' : `${routineTimeLabel(routine.planned_minutes)} planned`}</span>{routine.archived_at && <span>Stopped</span>}</div>
          {nextChange && <p className="mt-1 text-[11px] text-teal-600">New schedule from {shortDate(nextChange.before)}</p>}
          {expanded === routine.id && <div className="mt-3 rounded-xl bg-slate-50 p-1.5">
            <div className="flex flex-wrap items-center">
              {onEdit && !routine.archived_at && <button type="button" className={ACTION} onClick={() => onEdit(original)}><Pencil size={13} />Edit repeat schedule</button>}
              {canAct && finished && <button type="button" disabled={busy} onClick={() => void record(routine.id, 'pending')} className={ACTION}><RotateCcw size={13} />Undo {progress.status === 'skipped' ? 'skip' : 'finish'}</button>}
              {canAct && !finished && <>
                {selectedDate <= today && <button type="button" disabled={busy} onClick={() => void record(routine.id, 'completed')} className={ACTION}><Check size={13} />Finish session</button>}
                <button type="button" disabled={busy} onClick={() => void record(routine.id, 'skipped')} className={ACTION}><SkipForward size={13} />Skip this session</button>
              </>}
            </div>
            {canAct && !finished && selectedDate <= today && <p className="px-3 pb-2 text-[11px] leading-5 text-slate-400">The timer logs your hours. Finishing only closes the session.</p>}
            {routine.note && <p className="break-words px-3 py-2 text-xs leading-5 text-slate-500">{routine.note}</p>}
            {routine.target_unit !== 'minutes' && <p className="px-3 py-2 text-xs text-slate-400">Previous target: {routine.target_count} {routine.target_unit}. Edit the repeat schedule to use time from next week.</p>}
            {!routine.archived_at && <details className="border-t border-slate-200/60 px-3"><summary className="flex min-h-11 cursor-pointer items-center text-[11px] text-slate-400">Stop repeating…</summary><p className="text-xs leading-5 text-slate-500">Future sessions stop. Logged time and history stay saved.</p><button type="button" disabled={busy} onClick={() => void stop(routine.id)} className="min-h-11 text-xs text-rose-600">Stop repeating</button></details>}
          </div>}
        </article>;
      })}
    </div>}
    {!loading && !loadError && all.length > 0 && <footer className="flex min-h-11 flex-wrap items-center justify-between gap-1 border-t border-slate-100 px-4">{rows.length > 3 ? <button type="button" onClick={() => setShowAll(value => !value)} aria-expanded={showAll} className="flex min-h-11 items-center gap-1 text-[11px] text-slate-400"><ChevronDown size={12} />{showAll ? 'Show fewer' : `Show all ${rows.length} routines`}</button> : <span className="text-[11px] text-slate-400">Logged time stays in history</span>}{all.some(routine => routine.archived_at) && <button type="button" onClick={() => setShowStopped(value => !value)} aria-pressed={showStopped} className="min-h-11 text-[11px] text-slate-400">{showStopped ? 'Hide stopped' : 'Show stopped'}</button>}</footer>}
    {error && <p role="alert" className="border-t border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>}
  </section>;
}
