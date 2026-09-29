import { useRef, useState, type FormEvent } from 'react';
import { ChevronDown, Repeat2, X } from 'lucide-react';
import { ModalFrame } from '../../components/ModalFrame';
import { useCreateRoutine, useRescheduleRoutine } from '../../api/routines';
import type { DBGoal } from '../../db/schema';
import type { DBRoutine } from '../../types/routines';
import { addRoutineDays, isRoutineDate, parseRoutineDuration, routineTimeLabel, routineWeekStart } from '../../utils/routines';
import { clockInput, parseClockTime } from '../../utils/calendarTimeInput';
import { fmtYMD } from '../../utils/calendar';
import { useMediaQuery, MOBILE_LAYOUT_QUERY } from '../../hooks/useMediaQuery';

export interface RoutineComposerProps {
  goals: DBGoal[];
  date: string;
  today?: string;
  routine?: DBRoutine;
  onClose: () => void;
  onSaved: () => void;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const INPUT = 'mt-1.5 min-h-11 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-base text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100';
const CHIP = 'min-h-11 rounded-lg px-3 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-teal-600';

export function RoutineComposer({ goals, date, today = fmtYMD(new Date()), routine, onClose, onSaved }: RoutineComposerProps) {
  const create = useCreateRoutine();
  const reschedule = useRescheduleRoutine();
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(routine?.title ?? '');
  const [note, setNote] = useState(routine?.note ?? '');
  const [goalId, setGoalId] = useState(routine?.goal_id ?? '');
  const [cadence, setCadence] = useState<DBRoutine['cadence']>(routine?.cadence ?? 'weekly');
  const [weekdays, setWeekdays] = useState(routine?.weekdays ?? [1, 2, 3, 4, 5, 6, 7]);
  const [weeklyTarget, setWeeklyTarget] = useState(String(routine?.weekly_target ?? 3));
  const [duration, setDuration] = useState(routineTimeLabel(routine?.planned_minutes ?? 45));
  const [timing, setTiming] = useState<'anytime' | 'preferred'>(routine?.preferred_time ? 'preferred' : 'anytime');
  const [preferredTime, setPreferredTime] = useState(routine?.preferred_time ?? '09:00');
  const nextWeek = addRoutineDays(routineWeekStart(today), 7);
  const pendingBoundary = routine?.schedule_history?.map(item => item.before).sort().at(-1);
  const [startDate, setStartDate] = useState(routine ? pendingBoundary && pendingBoundary > nextWeek ? pendingBoundary : nextWeek : date);
  const [error, setError] = useState('');
  const minutes = parseRoutineDuration(duration);
  const frequency = cadence === 'daily' ? weekdays.length : Number(weeklyTarget);
  const weeklyMinutes = minutes && frequency > 0 && frequency <= 7 ? minutes * frequency : null;
  const hour = timing === 'preferred' ? parseClockTime(preferredTime) : null;
  const busy = create.isPending || reschedule.isPending;
  const close = () => { if (!busy) onClose(); };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim()) { setError('Give this repeating time a name.'); return; }
    if (!minutes) { setError('Enter a duration like 45 min, 1h 30m, or 1.5h (up to 24 hours).'); return; }
    if (!weekdays.length) { setError('Choose at least one day.'); return; }
    if (!Number.isInteger(frequency) || frequency < 1 || frequency > weekdays.length) { setError('Choose enough available days for your sessions: one session per day.'); return; }
    if (!isRoutineDate(startDate)) { setError('Choose a valid start date.'); return; }
    if (timing === 'preferred' && hour === null) { setError('Enter a time like 09:30 or 2:30pm.'); return; }
    if (hour !== null && hour * 60 + minutes > 1440) { setError('Choose an earlier time so the session finishes before midnight.'); return; }
    if (routine && (startDate < nextWeek || routineWeekStart(startDate) !== startDate)) { setError('Choose a Monday from next week onward.'); return; }
    const schedule = {
      cadence, weekdays: [...weekdays].sort((a, b) => a - b), weekly_target: frequency,
      target_count: minutes, target_unit: 'minutes' as const, planned_minutes: minutes,
      preferred_time: hour === null ? null : clockInput(hour),
    };
    setError('');
    try {
      if (routine) await reschedule.mutateAsync({ ...schedule, routineId: routine.id, effective_from: startDate, expected_updated_at: routine.updated_at });
      else await create.mutateAsync({ ...schedule, title: title.trim(), note: note.trim(), goal_id: goalId || null, start_date: startDate });
      onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save. Your changes are still here; try again.'); }
  }

  return <ModalFrame titleId="repeat-time-title" onClose={close} initialFocusRef={mobile || routine ? undefined : titleRef} overlayClassName="bg-slate-950/20" className="routine-editor flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-3xl bg-white shadow-xl">
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
      <div className="flex items-center gap-2.5"><Repeat2 size={17} className="text-teal-600" /><h2 id="repeat-time-title" className="text-sm font-semibold text-slate-900">{routine ? 'Edit repeat schedule' : 'Repeat time'}</h2></div>
      <button type="button" aria-label="Close repeat editor" disabled={busy} onClick={close} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-teal-600"><X size={18} /></button>
    </header>
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <fieldset disabled={busy} className="min-h-0 min-w-0 space-y-4 overflow-y-auto border-0 px-5 py-4">
        {routine ? <p className="break-words text-lg font-medium text-slate-900">{routine.title}</p> : <label className="block text-xs font-medium text-slate-500">Name<input ref={titleRef} value={title} maxLength={200} onChange={event => setTitle(event.target.value)} className={INPUT} placeholder="e.g. Biology revision" autoComplete="off" /></label>}
        <div className="grid grid-cols-2 gap-3">
          <label className="min-w-0 text-xs font-medium text-slate-500">Each session<input value={duration} onChange={event => setDuration(event.target.value)} onBlur={() => { if (minutes) setDuration(routineTimeLabel(minutes)); }} className={INPUT} placeholder="45 min or 1.5h" autoComplete="off" /></label>
          <label className="min-w-0 text-xs font-medium text-slate-500">Times per week<input type="number" inputMode="numeric" min={1} max={7} value={cadence === 'daily' ? weekdays.length : weeklyTarget} readOnly={cadence === 'daily'} onChange={event => setWeeklyTarget(event.target.value)} className={INPUT} /></label>
        </div>
        <div className="-mt-3 flex flex-wrap gap-1" aria-label="Session duration presets">{[30, 45, 60, 90].map(value => <button type="button" key={value} aria-pressed={minutes === value} onClick={() => setDuration(routineTimeLabel(value))} className={`${CHIP} ${minutes === value ? 'bg-teal-50 text-teal-800' : 'text-slate-500 hover:bg-slate-50'}`}>{routineTimeLabel(value)}</button>)}</div>
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-slate-500">Repeat on</legend>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100/80 p-1">{([{ value: 'weekly', label: 'Flexible days' }, { value: 'daily', label: 'Choose days' }] as const).map(option => <button type="button" key={option.value} aria-pressed={cadence === option.value} onClick={() => setCadence(option.value)} className={`${CHIP} ${cadence === option.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>{option.label}</button>)}</div>
          <div className="routine-days mt-3 grid grid-cols-7 gap-1">{WEEKDAYS.map((day, index) => <button type="button" key={day} aria-label={day} aria-pressed={weekdays.includes(index + 1)} onClick={() => setWeekdays(current => current.includes(index + 1) ? current.filter(value => value !== index + 1) : [...current, index + 1])} className={`h-11 min-w-0 rounded-xl text-xs focus-visible:outline-2 focus-visible:outline-teal-600 ${weekdays.includes(index + 1) ? 'bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-200/60' : 'text-slate-400 hover:bg-slate-50'}`}>{day.slice(0, 2)}</button>)}</div>
          <p className="mt-2 text-xs leading-5 text-slate-400">{cadence === 'weekly' ? `${weeklyTarget || '…'} sessions across the available days above. One per day.` : 'One session on each selected day, every week.'}</p>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-slate-500">Time</legend>
          <div className="flex flex-wrap items-center gap-1">{(['anytime', 'preferred'] as const).map(value => <button type="button" key={value} aria-pressed={timing === value} onClick={() => setTiming(value)} className={`${CHIP} ${timing === value ? 'bg-slate-100 text-slate-800' : 'text-slate-500'}`}>{value === 'anytime' ? 'Anytime' : 'At a time'}</button>)}</div>
          {timing === 'preferred' && <div className="mt-2 flex items-center gap-3"><label className="min-w-0 flex-1 text-xs text-slate-500">Start time<input aria-label="Start time" value={preferredTime} onChange={event => setPreferredTime(event.target.value)} onBlur={() => { if (hour !== null) setPreferredTime(clockInput(hour)); }} className={INPUT} placeholder="09:00 or 2pm" autoComplete="off" /></label><p className="flex-1 pt-5 text-xs text-slate-400">{hour !== null && minutes && hour * 60 + minutes <= 1440 ? `Ends ${clockInput(hour + minutes / 60)}` : 'Use a clock time'}</p></div>}
        </fieldset>
        {routine ? <div><label className="block text-xs font-medium text-slate-500">Apply from Monday<input type="date" value={startDate} min={nextWeek} step={7} onChange={event => setStartDate(event.target.value)} className={INPUT} /></label><p className="mt-2 text-xs leading-5 text-slate-400">This week and your logged history keep their original settings. {routine.target_unit !== 'minutes' && 'Following weeks will use time instead of count targets.'}</p></div> : <details className="group"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs text-slate-400"><ChevronDown size={14} className="group-open:rotate-180" />Goal, start date & notes</summary><div className="space-y-3 pb-1 pt-1"><label className="block text-xs font-medium text-slate-500">Linked goal<select value={goalId} onChange={event => setGoalId(event.target.value)} className={INPUT}><option value="">No linked goal</option>{goals.filter(goal => !goal.archived_at).map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label><label className="block text-xs font-medium text-slate-500">Starts<input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} className={INPUT} /></label><label className="block text-xs font-medium text-slate-500">Notes<textarea value={note} maxLength={10000} onChange={event => setNote(event.target.value)} className={`${INPUT} min-h-20 py-3`} rows={2} /></label></div></details>}
        {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
      </fieldset>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-100 px-5 py-3 pb-[max(.75rem,env(safe-area-inset-bottom))]"><div role="status" className="min-w-0"><p className="text-sm font-medium text-slate-800">{weeklyMinutes ? routineTimeLabel(weeklyMinutes) : '—'} <span className="text-[11px] font-normal text-slate-400">/ week</span></p><p className="mt-1 text-[11px] text-slate-400">{minutes ? routineTimeLabel(minutes) : '…'} × {frequency || '…'} sessions</p></div><button type="submit" disabled={busy} className="min-h-11 shrink-0 rounded-xl bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:opacity-50">{busy ? 'Saving…' : routine ? 'Save schedule' : 'Create routine'}</button></footer>
    </form>
  </ModalFrame>;
}
