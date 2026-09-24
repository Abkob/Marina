import { useEffect, useMemo, useState } from 'react';
import { AlignLeft, Check, Clock, Link2, Search, Trash2, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { apiDelete, apiPatch, apiPost } from '../../utils/apiFetch';
import type { DBEvent, DBGoal, DBTask, EventType } from '../../db/schema';
import { dateToWeekPos, fmtTimeRange, parseLocalDate } from '../../utils/calendar';
import { autofillFromTask, remainingMinutes } from '../../utils/eventAutofill';
import { GRID_END_HOUR, GRID_START_HOUR } from './WeekTimeGrid';
import { ModalFrame } from '../../components/ModalFrame';

/**
 * Google-Calendar-style quick create/edit card for calendar blocks.
 * Linking a task autofills the block's name, duration, and planned minutes
 * from the task's remaining estimate — everything stays editable.
 */

export interface ComposerSeed {
  mode: 'create' | 'edit';
  event?: DBEvent;
  date: string;
  startHour: number;
  durationHours: number;
  /** Existing link (edit mode) or task to link on create (task dropped on a slot) */
  linkId?: string;
  linkedTaskId?: string;
  /** keep the linked task's start day in sync with where the block lands */
  syncStartDate?: boolean;
}

const TYPES: EventType[] = ['Focus', 'Buffer', 'Review', 'Admin'];
const TYPE_PILL: Record<string, string> = {
  focus:  'bg-[#EEF2FF] text-[#4648d4] border-[#4648d4]/40',
  buffer: 'bg-amber-50 text-amber-700 border-amber-300',
  review: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  admin:  'bg-slate-100 text-slate-600 border-slate-300',
};

const DURATIONS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6];

function fmtMins(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${m ? ` ${m}m` : ''}`;
}

function fmtDayOption(dateStr: string): string {
  return parseLocalDate(dateStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtStartOption(hour: number): string {
  const hh = Math.floor(hour);
  const mm = Math.round((hour - hh) * 60);
  const disp = hh % 12 || 12;
  return `${disp}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

const START_OPTIONS: number[] = [];
for (let h = GRID_START_HOUR; h < GRID_END_HOUR; h += 0.25) START_OPTIONS.push(h);

// ── Task picker ───────────────────────────────────────────────────────────────

interface PickerRow {
  task: DBTask;
  depth: number;
  context: string; // "Goal · Parent task"
}

function buildPickerRows(tasks: DBTask[], goals: DBGoal[]): PickerRow[] {
  const open = tasks.filter(t => !t.completed && t.status !== 'done');
  const byId = new Map(open.map(t => [t.id, t]));
  const goalTitle = new Map(goals.map(g => [g.id, g.title]));
  const children = new Map<string, DBTask[]>();
  const roots: DBTask[] = [];
  for (const t of open) {
    if (t.parent_task_id && byId.has(t.parent_task_id)) {
      if (!children.has(t.parent_task_id)) children.set(t.parent_task_id, []);
      children.get(t.parent_task_id)!.push(t);
    } else {
      roots.push(t);
    }
  }
  const byGoal = (a: DBTask, b: DBTask) =>
    (goalTitle.get(a.goal_id ?? '') ?? '').localeCompare(goalTitle.get(b.goal_id ?? '') ?? '') || a.title.localeCompare(b.title);
  roots.sort(byGoal);

  const rows: PickerRow[] = [];
  const walk = (t: DBTask, depth: number, parents: string[]) => {
    const ctx = [goalTitle.get(t.goal_id ?? ''), ...parents].filter(Boolean).join(' · ');
    rows.push({ task: t, depth, context: ctx });
    for (const c of (children.get(t.id) ?? []).sort((a, b) => a.position - b.position)) {
      walk(c, depth + 1, [...parents, t.title]);
    }
  };
  for (const r of roots) walk(r, 0, []);
  return rows;
}

function TaskPicker({ tasks, goals, onPick }: { tasks: DBTask[]; goals: DBGoal[]; onPick: (t: DBTask) => void }) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => buildPickerRows(tasks, goals), [tasks, goals]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(r => r.task.title.toLowerCase().includes(needle) || r.context.toLowerCase().includes(needle));
  }, [rows, q]);

  return (
    <div className="rounded-lg border border-gray-200">
      <div className="flex items-center gap-1.5 border-b border-gray-100 px-2.5 py-1.5">
        <Search size={11} className="shrink-0 text-gray-300" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search tasks and subtasks…"
          className="w-full bg-transparent text-xs outline-none placeholder:text-gray-300"
        />
      </div>
      <div className="max-h-44 overflow-y-auto py-1">
        {filtered.length === 0 && (
          <p className="px-3 py-2 text-[11px] text-gray-400">No open task matches "{q}".</p>
        )}
        {filtered.slice(0, 60).map(({ task, depth, context }) => {
          const remaining = remainingMinutes(task.estimated_minutes, task.actual_minutes ?? 0);
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => onPick(task)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-indigo-50/60"
              style={{ paddingLeft: 12 + depth * 14 }}
            >
              {depth > 0 && <span className="text-[10px] text-gray-300">↳</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-gray-800">{task.title}</span>
                {context && <span className="block truncate text-[10px] text-gray-400">{context}</span>}
              </span>
              {remaining !== null && (
                <span className="shrink-0 font-mono text-[9px] text-gray-400">{fmtMins(remaining)} left</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Composer ──────────────────────────────────────────────────────────────────

export function EventComposer({ seed, days, tasks, goals, onClose }: {
  seed: ComposerSeed;
  days: string[];
  tasks: DBTask[];
  goals: DBGoal[];
  onClose: () => void;
}) {
  const { triggerToast } = useAppStore();
  const isEdit = seed.mode === 'edit';
  const ev = seed.event;

  // A task dropped on a slot arrives pre-linked: name and planned minutes
  // fill in, and the hours select is the question the card asks.
  const initialLinked = tasks.find(t => t.id === seed.linkedTaskId) ?? null;
  const initialFill = !isEdit && initialLinked
    ? autofillFromTask({ title: initialLinked.title, estimated_minutes: initialLinked.estimated_minutes }, initialLinked.actual_minutes ?? 0)
    : null;

  const [title, setTitle] = useState(ev?.title ?? initialFill?.title ?? '');
  const [titleTouched, setTitleTouched] = useState(Boolean(ev?.title));
  const [date, setDate] = useState(seed.date);
  const [startHour, setStartHour] = useState(seed.startHour);
  const [duration, setDuration] = useState(seed.durationHours);
  const [type, setType] = useState<string>(ev?.type ?? 'Focus');
  const [desc, setDesc] = useState(ev?.description ?? '');
  const [showDesc, setShowDesc] = useState(Boolean(ev?.description));
  const [linked, setLinked] = useState<DBTask | null>(initialLinked);
  const [plannedMinutes, setPlannedMinutes] = useState<number | null>(initialFill?.planned_minutes ?? null);
  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pickTask = (task: DBTask) => {
    const fill = autofillFromTask(
      { title: task.title, estimated_minutes: task.estimated_minutes },
      task.actual_minutes ?? 0,
    );
    setLinked(task);
    setShowPicker(false);
    setPlannedMinutes(fill.planned_minutes);
    if (!titleTouched || !title.trim()) setTitle(fill.title);
    if (!isEdit) setDuration(Math.min(fill.duration_hours, GRID_END_HOUR - startHour));
  };

  const unlink = () => {
    setLinked(null);
    setPlannedMinutes(null);
  };

  const save = async () => {
    if (!date) { triggerToast('Choose a date for this block.', 'error'); return; }
    if (startHour + duration > 24) { triggerToast('This block must end by midnight. Shorten it or choose an earlier start.', 'error'); return; }
    const finalTitle = title.trim() || linked?.title || 'Untitled block';
    const { week_start, day_index } = dateToWeekPos(date);
    setBusy(true);
    try {
      const body = {
        title: finalTitle,
        type,
        day_index,
        start_hour: startHour,
        duration_hours: duration,
        time_str: fmtTimeRange(startHour, duration),
        description: desc,
        // Weekly repeaters (no week_start) stay weekly when edited.
        ...(isEdit && !ev?.week_start ? {} : { week_start }),
      };
      let eventId = ev?.id;
      if (isEdit && eventId) {
        await apiPatch(`/api/events/${eventId}`, body);
      } else {
        const created = await apiPost<{ id: string }>('/api/events', {
          ...body,
          week_start,
          connected_resource_json: null,
          locked: false,
          source: 'manual',
        });
        eventId = created.id;
      }
      // Reconcile the task link against what's PERSISTED: in create mode
      // nothing is persisted yet (seed.linkedTaskId is only a prefill), so a
      // linked task always writes a link row.
      const persistedTaskId = isEdit ? (seed.linkedTaskId ?? null) : null;
      const linkChanged = (linked?.id ?? null) !== persistedTaskId;
      if (linkChanged && seed.linkId) await apiDelete(`/api/event-task-links/${seed.linkId}`);
      if (linkChanged && linked && eventId) {
        await apiPost('/api/event-task-links', {
          event_id: eventId,
          task_id: linked.id,
          planned_minutes: plannedMinutes ?? undefined,
        });
      }
      if (seed.syncStartDate && linked && linked.start_date !== date) {
        await apiPatch(`/api/tasks/${linked.id}`, { start_date: date });
      }
      triggerToast(isEdit ? 'Block saved.' : `"${finalTitle}" added to your calendar.`, 'success');
      onClose();
    } catch (e) {
      triggerToast((e as Error).message || 'Could not save the block.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!ev) return;
    setBusy(true);
    try {
      await apiDelete(`/api/events/${ev.id}`);
      triggerToast('Removed from calendar.', 'success');
      onClose();
    } catch (e) {
      triggerToast((e as Error).message || 'Could not remove the block.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const linkedRemaining = linked ? remainingMinutes(linked.estimated_minutes, linked.actual_minutes ?? 0) : null;

  return (
    <ModalFrame
      onClose={onClose}
      titleId="event-composer-title"
      overlayClassName="bg-black/40"
      className="mobile-sheet w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-2xl"
    >
        <h2 id="event-composer-title" className="sr-only">
          {isEdit ? 'Edit calendar block' : 'Add calendar block'}
        </h2>
        <div className="mb-3 flex items-start justify-between gap-3">
          <label htmlFor="event-composer-title-input" className="sr-only">Block title</label>
          <input
            id="event-composer-title-input"
            autoFocus
            value={title}
            onChange={e => { setTitle(e.target.value); setTitleTouched(true); }}
            placeholder="Add a title"
            className="w-full border-b-2 border-gray-200 pb-1 font-headline text-lg font-bold text-gray-900 outline-none placeholder:font-normal placeholder:text-gray-300 focus:border-[#4648d4]"
          />
          <button
            onClick={onClose}
            aria-label="Close calendar block editor"
            className="mt-1 flex h-11 w-11 md:h-8 md:w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-black"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          {/* When */}
          <div className="flex flex-wrap items-center gap-2">
            <Clock size={14} className="shrink-0 text-gray-400" />
            <input aria-label="Block date" type="date" value={date} onChange={e => setDate(e.target.value)}
              className="min-w-0 max-w-full rounded-lg border border-gray-200 bg-white p-1.5 outline-none focus:ring-1 focus:ring-[#4648d4] md:hidden" />
            <select aria-label="Block day" value={date} onChange={e => setDate(e.target.value)}
              className="hidden rounded-lg border border-gray-200 bg-white p-1.5 text-xs outline-none focus:ring-1 focus:ring-[#4648d4] md:block">
              {(days.includes(date) ? days : [date, ...days]).map(d => <option key={d} value={d}>{fmtDayOption(d)}</option>)}
            </select>
            <select aria-label="Block start time" value={startHour} onChange={e => setStartHour(Number(e.target.value))}
              className="rounded-lg border border-gray-200 bg-white p-1.5 text-xs outline-none focus:ring-1 focus:ring-[#4648d4]">
              {(START_OPTIONS.includes(startHour) ? START_OPTIONS : [startHour, ...START_OPTIONS]).map(h => (
                <option key={h} value={h}>{fmtStartOption(h)}</option>
              ))}
            </select>
            <select aria-label="Block duration" value={duration} onChange={e => setDuration(Number(e.target.value))}
              className="rounded-lg border border-gray-200 bg-white p-1.5 text-xs outline-none focus:ring-1 focus:ring-[#4648d4]">
              {(DURATIONS.includes(duration) ? DURATIONS : [duration, ...DURATIONS]).map(d => (
                <option key={d} value={d}>{d < 1 ? `${d * 60} min` : `${d} hr`}</option>
              ))}
            </select>
          </div>
          {isEdit && !ev?.week_start && (
            <p className="pl-6 font-mono text-[9px] uppercase tracking-wider text-gray-400">Repeats every week</p>
          )}

          {/* Type */}
          <div className="flex flex-wrap items-center gap-1.5 pl-6">
            {TYPES.map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                aria-pressed={type === t}
                className={`rounded-full border px-2.5 py-1 text-[10px] font-bold transition-colors
                  ${type.toLowerCase() === t.toLowerCase() ? TYPE_PILL[t.toLowerCase()] : 'border-gray-200 bg-white text-gray-400 hover:text-gray-600'}`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Task link */}
          <div className="flex items-start gap-2">
            <Link2 size={14} className="mt-1.5 shrink-0 text-gray-400" />
            <div className="min-w-0 flex-1">
              {linked ? (
                <div className="flex items-center gap-2 rounded-lg border border-indigo-100 bg-indigo-50/50 px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-gray-800">{linked.title}</p>
                    <p className="font-mono text-[9px] text-gray-400">
                      {plannedMinutes != null
                        ? `Plans ${fmtMins(plannedMinutes)} of this task`
                        : linkedRemaining != null ? `${fmtMins(linkedRemaining)} left on this task` : 'No time estimate on this task'}
                    </p>
                  </div>
                  <button type="button" onClick={unlink} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-300 hover:bg-red-50 hover:text-red-400" title="Unlink task" aria-label="Unlink task from block">
                    <X size={12} />
                  </button>
                </div>
              ) : showPicker ? (
                <TaskPicker tasks={tasks} goals={goals} onPick={pickTask} />
              ) : (
                <button
                  type="button"
                  onClick={() => setShowPicker(true)}
                  className="w-full rounded-lg border border-dashed border-gray-200 px-2.5 py-2 text-left text-xs text-gray-400 hover:border-[#4648d4]/50 hover:text-[#4648d4]"
                >
                  Link a task — its name and time fill in for you
                </button>
              )}
            </div>
          </div>

          {/* Description */}
          <div className="flex items-start gap-2">
            <AlignLeft size={14} className="mt-1.5 shrink-0 text-gray-400" />
            {showDesc ? (
              <textarea
                aria-label="Block description"
                value={desc}
                onChange={e => setDesc(e.target.value)}
                placeholder="Add details…"
                className="h-14 w-full resize-none rounded-lg border border-gray-200 p-2 text-xs outline-none focus:ring-1 focus:ring-[#4648d4]"
              />
            ) : (
              <button type="button" onClick={() => setShowDesc(true)} className="py-1.5 text-xs text-gray-400 hover:text-gray-600">
                Add a description
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3">
          {isEdit ? (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-bold text-red-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
            >
              <Trash2 size={12} /> Delete
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg bg-[#f8f9fa] px-3.5 py-2 font-mono text-[10px] font-semibold uppercase text-gray-500 hover:bg-gray-100">
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-[#4648d4] px-3.5 py-2 font-mono text-[10px] font-bold uppercase text-white hover:opacity-90 disabled:opacity-40"
            >
              <Check size={12} /> {isEdit ? 'Save' : 'Add to calendar'}
            </button>
          </div>
        </div>
    </ModalFrame>
  );
}
