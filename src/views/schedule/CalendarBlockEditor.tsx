import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Link2, Lock, Plus, Trash2, X } from 'lucide-react';
import { apiDelete, apiPatch, apiPost } from '../../utils/apiFetch';
import { useAppStore } from '../../store/useAppStore';
import type { DBEvent, DBGoal, DBTask } from '../../db/schema';
import { dateToWeekPos, eventDate, fmtTimeRange } from '../../utils/calendar';
import { clockInput, parseClockTime, timeRangeError } from '../../utils/calendarTimeInput';
import type { CalendarPlacement } from '../../utils/calendarGestures';
import { TaskPicker } from './CalendarTaskPicker';

type TaskLink = { id?: string; task_id: string; task_title?: string; planned_minutes?: number | null };
export interface ComposerSeed {
  mode: 'create' | 'edit'; event?: DBEvent; date: string; startHour: number; durationHours: number;
  linkId?: string; linkedTaskId?: string; syncStartDate?: boolean;
  links?: TaskLink[];
}

export function CalendarBlockEditor({ seed, tasks, goals, onClose, onPreview }: {
  seed: ComposerSeed; days: string[]; tasks: DBTask[]; goals: DBGoal[]; onClose: () => void; onPreview?: (draft: (CalendarPlacement & { title: string }) | null) => void;
}) {
  const { triggerToast } = useAppStore();
  const isEdit = seed.mode === 'edit';
  const event = seed.event;
  const initialLinks = seed.links ?? (seed.linkedTaskId ? [{ id: seed.linkId, task_id: seed.linkedTaskId }] : []);
  const [title, setTitle] = useState(event?.title ?? tasks.find(t => t.id === seed.linkedTaskId)?.title ?? '');
  const [date, setDate] = useState(seed.date);
  const [start, setStart] = useState(clockInput(seed.startHour));
  const [end, setEnd] = useState(clockInput(seed.startHour + seed.durationHours));
  const [type, setType] = useState(event?.type ?? 'Focus');
  const [description, setDescription] = useState(event?.description ?? '');
  const [locked, setLocked] = useState(Boolean(event?.locked));
  const [links, setLinks] = useState<TaskLink[]>(initialLinks);
  const [picker, setPicker] = useState(false);
  const [details, setDetails] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const durationRef = useRef(seed.durationHours);
  const storedPlacement = useRef(JSON.stringify([event?.start_hour, event?.duration_hours, event?.week_start, event?.day_index]));
  const startHour = parseClockTime(start);
  const endHour = parseClockTime(end, true);
  const rangeError = endHour === null && /^\d{2}:\d{2}$/.test(end) && Number(end.slice(0, 2)) >= 24
    ? 'This block must end by midnight.' : timeRangeError(startHour, endHour);
  const durationMinutes = startHour !== null && endHour !== null ? Math.round((endHour - startHour) * 60) : 0;
  const durationLabel = durationMinutes > 0 ? `${Math.floor(durationMinutes / 60) ? `${Math.floor(durationMinutes / 60)}h ` : ''}${durationMinutes % 60 ? `${durationMinutes % 60}m` : ''}`.trim() : 'Set a time';
  const rangeLabel = !rangeError && startHour !== null ? fmtTimeRange(startHour, durationMinutes / 60) : 'Choose start and end';

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Editing time should not summon the phone keyboard until a field is tapped.
    panel.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [busy, onClose]);
  useEffect(() => {
    if (!event) return;
    const nextPlacement = JSON.stringify([event.start_hour, event.duration_hours, event.week_start, event.day_index]);
    if (nextPlacement === storedPlacement.current) return;
    storedPlacement.current = nextPlacement;
    setStart(clockInput(event.start_hour));
    setEnd(clockInput(event.start_hour + event.duration_hours));
    durationRef.current = event.duration_hours;
    const updatedDate = eventDate(event);
    if (updatedDate) setDate(updatedDate);
    // A direct calendar gesture or a cloud refresh updates placement without
    // throwing away a title, description or link draft in this open editor.
  }, [event?.start_hour, event?.duration_hours, event?.week_start, event?.day_index]);

  useEffect(() => {
    onPreview?.(!rangeError && date ? { date, startHour: startHour!, durationHours: durationMinutes / 60, title: title || 'New block' } : null);
  }, [date, startHour, durationMinutes, title, rangeError, onPreview]);

  const updateStart = (value: string) => {
    const next = parseClockTime(value);
    if (next !== null) setEnd(clockInput(next + durationRef.current));
    setStart(value);
  };
  const updateEnd = (value: string) => {
    setEnd(value);
    const next = parseClockTime(value, true);
    if (next !== null && startHour !== null && next > startHour) durationRef.current = next - startHour;
  };
  const save = async () => {
    const problem = rangeError || (!date ? 'Choose a date for this block.' : '');
    if (problem) { setError(problem); triggerToast(problem, 'error'); return; }
    if (busy) return;
    setBusy(true); setError('');
    const placement = dateToWeekPos(date);
    const initialIds = new Set(initialLinks.map(link => link.task_id));
    const body = {
      title: title.trim() || 'Untitled block', type, description, locked,
      start_hour: startHour!, duration_hours: durationMinutes / 60, day_index: placement.day_index,
      time_str: rangeLabel,
      ...(isEdit && !event?.week_start ? {} : { week_start: placement.week_start }),
      task_link_changes: {
        add: links.filter(link => !isEdit || !initialIds.has(link.task_id)).map(link => ({ task_id: link.task_id, planned_minutes: link.planned_minutes ?? null })),
        remove: initialLinks.filter(link => link.id && !links.some(next => next.task_id === link.task_id)).map(link => link.id!),
      },
    };
    try {
      if (isEdit && event) await apiPatch(`/api/events/${event.id}`, body);
      else await apiPost('/api/events', { ...body, source: 'manual', connected_resource_json: null });
      triggerToast(isEdit ? 'Block saved.' : 'Added to calendar.', 'success');
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save. Your draft is still here.'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!event || busy) return;
    setBusy(true); setError('');
    try { await apiDelete(`/api/events/${event.id}`); triggerToast('Removed from calendar. Linked tasks are kept.', 'success'); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not remove this block.'); }
    finally { setBusy(false); }
  };
  const pick = (task: DBTask) => {
    setLinks(current => current.some(link => link.task_id === task.id) ? current : [...current, { task_id: task.id, task_title: task.title }]);
    if (!title.trim()) setTitle(task.title);
    // The selected range belongs to the user. Linking never changes it.
    setPicker(false);
  };

  return <aside ref={panel} tabIndex={-1} role="dialog" aria-modal="false" aria-labelledby="calendar-editor-title" className={`calendar-editor ${collapsed ? 'is-collapsed' : ''}`}>
    <header className="flex items-center gap-2 border-b border-slate-100 px-4 py-2">
      <button type="button" disabled={busy} aria-label={collapsed ? 'Expand calendar editor' : 'Minimize calendar editor'} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)} className="calendar-editor-icon">
        {collapsed ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
      </button>
      <button type="button" onClick={() => setCollapsed(false)} className="min-w-0 flex-1 text-left">
        <h2 id="calendar-editor-title" className="truncate text-sm font-semibold text-slate-800">{collapsed ? title || 'New block' : isEdit ? 'Calendar block' : 'Make time'}</h2>
        <p className="text-[11px] text-slate-400">{rangeLabel}{!rangeError ? ` · ${durationLabel}` : ''}</p>
      </button>
      <button type="button" disabled={busy} onClick={onClose} className="calendar-editor-icon" aria-label="Close calendar block editor"><X size={17} /></button>
    </header>
    <form hidden={collapsed} onSubmit={e => { e.preventDefault(); void save(); }} className="calendar-editor-body">
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <label className="block"><span className="sr-only">Block title</span><input value={title} onChange={e => setTitle(e.target.value)} placeholder="What is this time for?" className="calendar-title" /></label>
        <div className="calendar-time-card">
          <label className="block text-xs text-slate-500">Date<input aria-label="Block date" type="date" value={date} onChange={e => setDate(e.target.value)} className="calendar-date" /></label>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="text-xs text-slate-500">Start<input aria-label="Block start time" aria-describedby={rangeError ? 'calendar-time-error' : undefined} aria-invalid={!!rangeError} value={start} onChange={e => updateStart(e.target.value)} onBlur={() => { if (startHour !== null) setStart(clockInput(startHour)); }} placeholder="09:00" className="calendar-clock" /></label>
            <label className="text-xs text-slate-500">End<input aria-label="Block end time" aria-describedby={rangeError ? 'calendar-time-error' : undefined} aria-invalid={!!rangeError} value={end} onChange={e => updateEnd(e.target.value)} onBlur={() => { if (endHour !== null) setEnd(clockInput(endHour)); }} placeholder="10:00" className="calendar-clock" /></label>
          </div>
          {rangeError ? <p id="calendar-time-error" className="mt-2 text-xs text-rose-600">{rangeError}</p> : <p className="mt-2 text-xs text-slate-400">{durationLabel} scheduled</p>}
          <div className="mt-2 flex gap-1" aria-label="Quick duration">{[30, 60, 90].map(minutes => <button key={minutes} type="button" disabled={startHour === null || startHour + minutes / 60 > 24} onClick={() => updateEnd(clockInput(startHour! + minutes / 60))} className="calendar-duration">{minutes === 60 ? '1h' : `${minutes}m`}</button>)}</div>
        </div>
        <div className="space-y-2">
          {links.map(link => {
            const task = tasks.find(item => item.id === link.task_id);
            const goal = goals.find(item => item.id === task?.goal_id);
            return <div key={link.task_id} className="flex items-center gap-2 rounded-xl bg-indigo-50/60 px-3 py-1">
              <Link2 size={13} className="shrink-0 text-indigo-400" /><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-slate-700">{task?.title ?? link.task_title ?? 'Linked task'}</p>{goal && <p className="truncate text-[10px] text-slate-400">{goal.title}</p>}</div>
              <button type="button" aria-label={`Unlink ${task?.title ?? link.task_title ?? 'task'}`} onClick={() => setLinks(current => current.filter(item => item.task_id !== link.task_id))} className="calendar-editor-icon"><X size={13} /></button>
            </div>;
          })}
          {picker ? <TaskPicker tasks={tasks.filter(task => !links.some(link => link.task_id === task.id))} goals={goals} onPick={pick} /> : <button type="button" onClick={() => setPicker(true)} className="flex min-h-11 items-center gap-2 text-xs text-slate-500 hover:text-indigo-600"><Plus size={14} />{links.length ? 'Link another task' : 'Link a task'}</button>}
          {!links.length && !picker && <p className="text-[11px] text-slate-400">Unlinked time counts as Miscellaneous.</p>}
        </div>
        <button type="button" onClick={() => setDetails(value => !value)} aria-expanded={details} className="flex min-h-11 w-full items-center justify-between border-t border-slate-100 text-xs text-slate-500">Details<ChevronDown size={14} className={details ? 'rotate-180' : ''} /></button>
        {details && <div className="space-y-3">
          <div className="flex flex-wrap gap-1">{['Focus', 'Buffer', 'Review', 'Admin'].map(value => <button key={value} type="button" onClick={() => setType(value as DBEvent['type'])} aria-pressed={type.toLowerCase() === value.toLowerCase()} className={`calendar-duration ${type.toLowerCase() === value.toLowerCase() ? 'bg-indigo-50 text-indigo-600' : ''}`}>{value}</button>)}</div>
          <label className="block text-xs text-slate-500">Notes<textarea aria-label="Block description" value={description} onChange={e => setDescription(e.target.value)} className="mt-1 min-h-20 w-full rounded-xl border border-slate-200 p-3 text-sm" /></label>
          <label className="flex min-h-11 items-center gap-2 text-xs text-slate-500"><input type="checkbox" checked={locked} onChange={e => setLocked(e.target.checked)} /><Lock size={13} />Lock against dragging</label>
          {isEdit && !event?.week_start && <p className="text-xs text-slate-400">Repeats every week</p>}
          {isEdit && <button type="button" onClick={() => setConfirmRemove(true)} className="flex min-h-11 items-center gap-2 text-xs text-slate-400 hover:text-rose-600"><Trash2 size={13} />Remove from calendar</button>}
          {confirmRemove && <div className="rounded-xl bg-rose-50 p-3 text-xs text-rose-700"><p>Remove this block? Its linked tasks will stay.</p><div className="mt-1 flex gap-3"><button type="button" className="min-h-11 font-semibold" onClick={() => void remove()}>Remove block</button><button type="button" className="min-h-11" onClick={() => setConfirmRemove(false)}>Keep it</button></div></div>}
        </div>}
      </fieldset>
      {error && <p role="alert" className="mt-3 rounded-xl bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
      <footer className="sticky bottom-0 mt-4 flex justify-end border-t border-slate-100 bg-white pt-3"><button type="submit" disabled={busy} className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-5 text-sm font-medium text-white disabled:opacity-40"><Check size={15} />{busy ? 'Saving…' : isEdit ? 'Save' : 'Add to calendar'}</button></footer>
    </form>
  </aside>;
}
