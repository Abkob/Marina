import { useRef, useState, type FormEvent } from 'react';
import { BookOpen, Brain, Repeat2, X } from 'lucide-react';
import { ModalFrame } from '../../components/ModalFrame';
import { useCreateRoutine } from '../../api/routines';
import type { DBGoal } from '../../db/schema';
import type { DBRoutine, RoutineTargetUnit } from '../../types/routines';
import { isRoutineDate } from '../../utils/routines';

export interface RoutineComposerProps {
  goals: DBGoal[];
  date: string;
  onClose: () => void;
  onSaved: () => void;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const PRESETS = [
  { label: 'Catch-up', icon: Repeat2, title: 'Daily catch-up', note: 'Review today’s notes and pick up anything unfinished.', cadence: 'daily', target: 20, unit: 'minutes', minutes: 20 },
  { label: 'Revision', icon: BookOpen, title: 'Revision', note: 'Revisit a topic and recall the key ideas without looking.', cadence: 'weekly', target: 30, unit: 'minutes', minutes: 30 },
  { label: 'Practice', icon: Brain, title: 'Practice problems', note: 'Choose a small set of problems to practise.', cadence: 'weekly', target: 5, unit: 'problems', minutes: 25 },
] as const;
const INPUT = 'mt-1.5 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100';

export function RoutineComposer({ goals, date, onClose, onSaved }: RoutineComposerProps) {
  const create = useCreateRoutine();
  const titleRef = useRef<HTMLInputElement>(null);
  const [preset, setPreset] = useState('Catch-up');
  const [title, setTitle] = useState<string>(PRESETS[0].title);
  const [note, setNote] = useState<string>(PRESETS[0].note);
  const [goalId, setGoalId] = useState('');
  const [cadence, setCadence] = useState<DBRoutine['cadence']>('daily');
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5]);
  const [weeklyTarget, setWeeklyTarget] = useState('3');
  const [targetCount, setTargetCount] = useState('20');
  const [unit, setUnit] = useState<RoutineTargetUnit>('minutes');
  const [plannedMinutes, setPlannedMinutes] = useState('20');
  const [timing, setTiming] = useState<'anytime' | 'preferred'>('anytime');
  const [preferredTime, setPreferredTime] = useState('');
  const [startDate, setStartDate] = useState(date);
  const [error, setError] = useState('');

  function choosePreset(selected: typeof PRESETS[number]) {
    setPreset(selected.label);
    setTitle(selected.title);
    setNote(selected.note);
    setCadence(selected.cadence);
    setTargetCount(String(selected.target));
    setUnit(selected.unit);
    setPlannedMinutes(String(selected.minutes));
    setError('');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (create.isPending) return;
    const count = Number(targetCount);
    const minutes = unit === 'minutes' ? count : Number(plannedMinutes);
    const quota = Number(weeklyTarget);
    if (!title.trim()) { setError('Give your routine a name.'); return; }
    if (!weekdays.length) { setError('Choose at least one day.'); return; }
    if (!Number.isInteger(count) || count <= 0 || count > 1440) { setError('Choose a target from 1 to 1,440.'); return; }
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) { setError('Set a time budget between 1 and 1,440 minutes.'); return; }
    if (cadence === 'weekly' && (!Number.isInteger(quota) || quota < 1 || quota > weekdays.length)) {
      setError('Weekly sessions cannot exceed your selected days: one session target per day.'); return;
    }
    if (!isRoutineDate(startDate)) { setError('Choose a valid start date.'); return; }
    if (timing === 'preferred' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(preferredTime)) { setError('Choose a preferred time or use Anytime.'); return; }
    if (timing === 'preferred') {
      const [hours, minute] = preferredTime.split(':').map(Number);
      if (hours * 60 + minute + minutes > 1440) { setError('Choose an earlier time so the routine finishes before midnight.'); return; }
    }
    setError('');
    try {
      await create.mutateAsync({
        title: title.trim(), note: note.trim(), goal_id: goalId || null, cadence,
        weekdays: [...weekdays].sort((a, b) => a - b),
        weekly_target: cadence === 'daily' ? weekdays.length : quota,
        target_count: count, target_unit: unit, planned_minutes: minutes,
        preferred_time: timing === 'preferred' ? preferredTime : null,
        start_date: startDate,
      });
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the routine. Please try again.');
    }
  }

  return (
    <ModalFrame titleId="new-routine-title" onClose={onClose} initialFocusRef={titleRef} className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-5">
        <div>
          <h2 id="new-routine-title" className="text-xl font-bold text-gray-950">A little, regularly</h2>
          <p className="mt-1 text-sm text-gray-500">A routine to keep returning to—not a task to finish forever.</p>
        </div>
        <button type="button" aria-label="Close new routine" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-800"><X size={20} /></button>
      </div>
      <form onSubmit={submit} className="overflow-y-auto px-6 py-5">
        <fieldset>
          <legend className="text-sm font-semibold text-gray-700">Start with an idea</legend>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {PRESETS.map(option => <button key={option.label} type="button" aria-pressed={preset === option.label} onClick={() => choosePreset(option)} className={`flex items-center justify-center gap-2 rounded-xl border px-2 py-3 text-sm font-semibold transition-colors ${preset === option.label ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}><option.icon size={16} className="hidden sm:block" />{option.label}</button>)}
          </div>
        </fieldset>
        <label className="mt-5 block text-sm font-medium text-gray-700">Routine name
          <input ref={titleRef} value={title} maxLength={200} onChange={event => { setTitle(event.target.value); setPreset(''); }} className={INPUT} placeholder="e.g. Physics 210 revision" required />
        </label>
        <label className="mt-4 block text-sm font-medium text-gray-700">Linked goal
          <select value={goalId} onChange={event => setGoalId(event.target.value)} className={INPUT}><option value="">No goal · standalone routine</option>{goals.filter(goal => !goal.archived_at).map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select>
        </label>
        <fieldset className="mt-5">
          <legend className="text-sm font-semibold text-gray-700">How often?</legend>
          <div className="mt-2 flex rounded-xl bg-gray-100 p-1">
            {(['daily', 'weekly'] as const).map(value => <button key={value} type="button" aria-pressed={cadence === value} onClick={() => setCadence(value)} className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${cadence === value ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500'}`}>{value === 'daily' ? 'On selected days' : 'Flexible weekly target'}</button>)}
          </div>
          {cadence === 'weekly' && <label className="mt-3 flex flex-wrap items-center gap-2 text-sm text-gray-700"><input aria-label="Sessions per week" type="number" min="1" max={Math.max(1, weekdays.length)} value={weeklyTarget} onChange={event => setWeeklyTarget(event.target.value)} className="w-16 rounded-lg border border-gray-200 px-2 py-2" required />sessions per week, on any of these days</label>}
          <div className="mt-3 grid grid-cols-7 gap-1">
            {WEEKDAYS.map((day, index) => <button key={day} type="button" aria-label={day} aria-pressed={weekdays.includes(index + 1)} onClick={() => setWeekdays(current => current.includes(index + 1) ? current.filter(value => value !== index + 1) : [...current, index + 1])} className={`rounded-lg py-2.5 text-xs font-semibold ${weekdays.includes(index + 1) ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-500'}`}>{day.slice(0, 3)}</button>)}
          </div>
        </fieldset>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium text-gray-700">Target per session<input type="number" value={targetCount} min="1" max="1440" onChange={event => setTargetCount(event.target.value)} className={INPUT} required /></label>
          <label className="block text-sm font-medium text-gray-700">Measure<select value={unit} onChange={event => setUnit(event.target.value as RoutineTargetUnit)} className={INPUT}><option value="minutes">Minutes</option><option value="problems">Problems</option><option value="pages">Pages</option><option value="sessions">Sessions</option></select></label>
        </div>
        {unit !== 'minutes' && <label className="mt-4 block text-sm font-medium text-gray-700">Time budget (minutes)<input type="number" value={plannedMinutes} min="1" max="1440" onChange={event => setPlannedMinutes(event.target.value)} className={INPUT} required /><span className="mt-1 block text-xs font-normal leading-relaxed text-gray-500">A rough allowance for the planner; your actual work time is recorded separately.</span></label>}
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-gray-700">When<select value={timing} onChange={event => setTiming(event.target.value as 'anytime' | 'preferred')} className={INPUT}><option value="anytime">Anytime that day</option><option value="preferred">Preferred clock time</option></select></label>
          {timing === 'preferred' && <label className="block text-sm font-medium text-gray-700">Preferred time<input type="time" value={preferredTime} onChange={event => setPreferredTime(event.target.value)} className={INPUT} required /></label>}
          <label className="block text-sm font-medium text-gray-700">Starts on<input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} className={INPUT} required /></label>
        </div>
        {timing === 'preferred' && <p className="mt-2 text-xs leading-relaxed text-gray-500">A preferred calendar slot shown in Marina, not a synced Google Calendar event. Your time budget counts toward available study time.</p>}
        <label className="mt-4 block text-sm font-medium text-gray-700">What should I work on? <span className="font-normal text-gray-400">Optional</span><textarea rows={2} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} className={`${INPUT} resize-y`} placeholder="Topics, a problem set, or a reminder for future you" /></label>
        <p className="mt-5 rounded-xl bg-indigo-50 p-3 text-xs leading-relaxed text-indigo-700">Missed days don’t pile up. Done, skipped and worked-on days keep their history, ready for a day-by-day matrix later.</p>
        {error && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl px-4 py-2.5 text-sm font-medium text-gray-500 hover:bg-gray-100">Cancel</button>
          <button type="submit" disabled={create.isPending} className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">{create.isPending ? 'Saving…' : 'Create routine'}</button>
        </div>
      </form>
    </ModalFrame>
  );
}
