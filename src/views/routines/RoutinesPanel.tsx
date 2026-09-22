import { useState } from 'react';
import { Check, ChevronDown, Clock3, Play, Plus, Repeat2, RotateCcw, SkipForward } from 'lucide-react';
import { useArchiveRoutine, useRoutineCheckIn, useRoutineEntries, useRoutines } from '../../api/routines';
import type { DBGoal } from '../../db/schema';
import type { DBRoutine } from '../../types/routines';
import { addRoutineDays, routineProgress, routineWeekStart } from '../../utils/routines';
import { fmtYMD, parseLocalDate } from '../../utils/calendar';

export interface RoutinesPanelProps {
  date: string;
  today?: string;
  goals: DBGoal[];
  onCreate: () => void;
  onStartFocus: (routine: DBRoutine, date: string) => void;
}

function targetLabel(routine: DBRoutine) {
  const count = routine.target_count;
  const unit = routine.target_unit === 'minutes' ? 'min' : count === 1 ? routine.target_unit.slice(0, -1) : routine.target_unit;
  return `${count} ${unit}`;
}

export function RoutinesPanel({ date, today: todayProp, goals, onCreate, onStartFocus }: RoutinesPanelProps) {
  const routines = useRoutines();
  const from = routineWeekStart(date);
  const entries = useRoutineEntries(from, addRoutineDays(from, 6));
  const checkIn = useRoutineCheckIn();
  const archive = useArchiveRoutine();
  const [showAll, setShowAll] = useState(false);
  const [manage, setManage] = useState(false);
  const [error, setError] = useState('');
  const today = todayProp ?? fmtYMD(new Date());
  const isToday = date === today;
  const isFuture = date > today;
  const dateLabel = parseLocalDate(date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const all = routines.data ?? [];
  const rows = all.filter(routine => !routine.archived_at).map(routine => ({ routine, progress: routineProgress(routine, entries.data ?? [], date) }))
    .filter(row => row.progress.scheduled || row.progress.entry)
    .sort((a, b) => Number(['completed', 'skipped'].includes(a.progress.status)) - Number(['completed', 'skipped'].includes(b.progress.status)) || (a.routine.preferred_time ?? '99').localeCompare(b.routine.preferred_time ?? '99') || a.routine.title.localeCompare(b.routine.title));
  const visible = showAll ? rows : rows.slice(0, 3);
  const loading = routines.isPending || entries.isPending;
  const loadError = routines.isError || entries.isError;
  const busy = checkIn.isPending || archive.isPending;

  async function record(routineId: string, status: 'completed' | 'skipped' | 'pending') {
    setError('');
    try { await checkIn.mutateAsync({ routineId, date, status }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update the routine. Try again.'); }
  }
  async function setArchived(routineId: string, archived: true) {
    setError('');
    try { await archive.mutateAsync({ routineId, archived }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update the routine. Try again.'); }
  }

  return (
    <section aria-label="Routines" className="mb-4 overflow-hidden rounded-2xl border border-indigo-100 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><Repeat2 size={18} /></span>
          <div><h2 className="text-sm font-bold text-gray-900">{isToday ? 'Today’s routines' : 'Routines'}{!isToday && <span className="ml-2 font-normal text-gray-500">{dateLabel}</span>}</h2><p className="mt-0.5 text-xs text-gray-500">Small habits, fresh each day. No overdue pile-up.</p></div>
        </div>
        <button type="button" onClick={onCreate} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"><Plus size={14} />Add routine</button>
      </div>
      {loading ? <p role="status" className="border-t border-gray-100 px-5 py-5 text-sm text-gray-500">Loading routines…</p>
        : loadError ? <div role="alert" className="flex flex-wrap items-center gap-3 border-t border-gray-100 px-5 py-4 text-sm text-red-700"><span>Could not load your routines. Your history has not changed.</span><button type="button" onClick={() => { void routines.refetch(); void entries.refetch(); }} className="rounded-lg border border-red-200 px-3 py-1.5 font-semibold">Retry</button></div>
          : rows.length === 0 ? <div className="border-t border-gray-100 px-5 py-4 text-sm text-gray-500">{all.some(routine => !routine.archived_at) ? 'Nothing to do for this day. You may have met your weekly target, or this is a day off.' : 'Try 20 minutes of catch-up, revision, or a few practice problems.'}</div>
            : <div className="divide-y divide-gray-100 border-t border-gray-100">
              {visible.map(({ routine, progress }) => {
                const finished = progress.status === 'completed' || progress.status === 'skipped';
                const goal = goals.find(item => item.id === routine.goal_id);
                return <article key={routine.id} aria-label={routine.title} className={`flex flex-col gap-3 px-4 py-4 sm:px-5 xl:flex-row xl:items-center xl:justify-between ${finished ? 'bg-gray-50/60' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="break-words text-sm font-semibold text-gray-900">{routine.title}</h3><span className={`rounded-md px-2 py-0.5 text-xs font-medium ${progress.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : progress.status === 'skipped' ? 'bg-gray-100 text-gray-500' : 'bg-indigo-50 text-indigo-700'}`}>{finished ? progress.status === 'completed' ? 'Done' : 'Skipped' : targetLabel(routine)}</span></div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                      {goal && <span className="max-w-full truncate">{goal.title}</span>}
                      <span className="inline-flex items-center gap-1"><Clock3 size={12} />{routine.preferred_time ? `Around ${routine.preferred_time}` : 'Anytime'}{routine.target_unit !== 'minutes' && ` · ~${routine.planned_minutes} min`}</span>
                      <span>{progress.weekCompleted} of {progress.weekTarget} sessions this week</span>
                      {progress.minutes > 0 && <span className="font-medium text-emerald-700">{Math.round(progress.minutes)} min worked</span>}
                    </div>
                    {routine.note && !finished && <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-gray-500">{routine.note}</p>}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {finished ? <button type="button" disabled={busy} onClick={() => void record(routine.id, 'pending')} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"><RotateCcw size={13} />Undo</button> : <>
                      {isToday && <button type="button" disabled={busy} onClick={() => onStartFocus(routine, date)} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"><Play size={13} />Start focus</button>}
                      {!isFuture && <button type="button" disabled={busy} onClick={() => void record(routine.id, 'completed')} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50"><Check size={14} />{isToday ? 'Done today' : 'Mark done'}</button>}
                      {!isFuture && <button type="button" disabled={busy} onClick={() => void record(routine.id, 'skipped')} className="inline-flex items-center gap-1 rounded-lg px-2 py-2 text-xs font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"><SkipForward size={13} />{isToday ? 'Skip today' : 'Skip day'}</button>}
                      {isFuture && <span className="text-xs text-gray-400">Upcoming · check in on the day</span>}
                    </>}
                  </div>
                </article>;
              })}
            </div>}
      {!loading && !loadError && all.length > 0 && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-5 py-2">
        {rows.length > 3 ? <button type="button" onClick={() => setShowAll(value => !value)} aria-expanded={showAll} className="inline-flex items-center gap-1 py-1.5 text-xs font-medium text-indigo-600"><ChevronDown size={13} className={showAll ? 'rotate-180' : ''} />{showAll ? 'Show fewer' : `Show all ${rows.length} routines`}</button> : <span className="text-xs text-gray-400">History is saved day by day.</span>}
        <button type="button" onClick={() => setManage(value => !value)} aria-expanded={manage} className="py-1.5 text-xs text-gray-500 hover:text-gray-800">{manage ? 'Close management' : 'Manage routines'}</button>
      </div>}
      {manage && !loading && !loadError && <div className="border-t border-gray-100 bg-gray-50 px-5 py-3"><p className="mb-2 text-xs text-gray-500">Archiving stops future reminders without deleting history. Create a new routine to start again later.</p><ul className="space-y-2">{all.map(routine => <li key={routine.id} className="flex items-center justify-between gap-3 text-sm"><span className="min-w-0 break-words text-gray-700">{routine.title}{routine.archived_at && <span className="ml-2 text-xs text-gray-400">Archived</span>}</span>{!routine.archived_at && <button type="button" disabled={busy} onClick={() => void setArchived(routine.id, true)} className="shrink-0 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 disabled:opacity-50">Archive</button>}</li>)}</ul></div>}
      {error && <p role="alert" className="border-t border-red-100 bg-red-50 px-5 py-3 text-sm text-red-700">{error}</p>}
    </section>
  );
}
