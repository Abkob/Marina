import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Clock, List, SlidersHorizontal, Repeat, Plus, RefreshCw, Share, X } from 'lucide-react';
import type { DayAssignment, ScheduleDay } from '../../api/hooks';
import type { DBEvent, DBEventTaskLink, DBGoal, DBTask } from '../../db/schema';
import { addDays, calendarDateTime, fmtTimeRange, fmtYMD, mondayOf, parseLocalDate } from '../../utils/calendar';
import { mobileScheduleItems, type MobileScheduleItem } from '../../utils/mobileSchedule';
import { MobileSheet } from '../../components/MobileSheet';
import { ModalFrame } from '../../components/ModalFrame';
import { useAppStore } from '../../store/useAppStore';
import type { CalendarMeeting, PlacedEvent } from './WeekTimeGrid';
import { MobileDayTimeline } from './MobileDayTimeline';
import { useCalendarSwipe } from '../../hooks/useCalendarSwipe';
import type { CalendarPlacement } from '../../utils/calendarGestures';
import { useMobileSchedulePreferences } from '../../hooks/useMobileSchedulePreferences';


const TONES = {
  event: 'border-indigo-400 bg-indigo-50 text-indigo-950',
  meeting: 'border-sky-400 bg-sky-50 text-sky-950',
  routine: 'border-teal-400 bg-teal-50 text-teal-950',
  task: 'border-violet-400 bg-violet-50 text-violet-950',
  deadline: 'border-rose-400 bg-rose-50 text-rose-950',
};
const dateLabel = (date: string) => parseLocalDate(date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const durationLabel = (minutes: number) => minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${Math.round(minutes % 60)}m` : ''}` : `${Math.round(minutes)} min`;

interface Props {
  date: string;
  today: string;
  now: Date;
  timezone?: string;
  days: string[];
  events: PlacedEvent[];
  meetings: CalendarMeeting[];
  tasks: DBTask[];
  goals?: DBGoal[];
  eventLinks?: DBEventTaskLink[];
  previewByDate: Map<string, ScheduleDay>;
  assignmentsByDate: Map<string, DayAssignment>;
  blockedTaskIds: Set<string>;
  loading: boolean;
  refreshing: boolean;
  error: boolean;
  onDate: (date: string) => void;
  onRefresh: () => Promise<void>;
  onCreate: (date: string, hour?: number, duration?: number) => void;
  onChangeEvent: (event: DBEvent, placement: CalendarPlacement) => Promise<void>;
  onEdit: (event: DBEvent) => void;
  onAddTask: (date: string) => void;
  onScheduleTask: (task: DBTask, date: string, hour: number) => void;
  onStartFocus: (task: DBTask) => void;
  onMoveTask: (taskId: string, date: string) => Promise<void>;
  renderRoutines: (date: string, closeDetails: () => void) => React.ReactNode;
}

function ItemCard({ item, onOpen }: { item: MobileScheduleItem; onOpen: (item: MobileScheduleItem) => void }) {
  return <button onClick={() => onOpen(item)} className={`flex min-h-16 w-full items-center gap-3 rounded-2xl border-l-[3px] px-3 py-3 text-left active:brightness-95 ${TONES[item.kind]}`}>
    <div className="min-w-0 flex-1">
      <p className="break-words text-sm font-semibold leading-5">{item.title}</p>
      {item.context && <p className="mt-0.5 truncate text-xs font-normal opacity-60" title={item.context}>{item.context}</p>}
      <p className="mt-1 text-xs opacity-70">{item.start === null ? item.detail : fmtTimeRange(item.start, item.minutes / 60)}</p>
    </div>
    {item.minutes > 0 && <span className="shrink-0 text-xs opacity-60">{durationLabel(item.minutes)}</span>}
    <ChevronRight size={15} className="shrink-0 opacity-50" />
  </button>;
}

export function MobileSchedule(props: Props) {
  const { date, today, now, days, onDate } = props;
  const { navigateToGoal, openCompletionReport } = useAppStore();
  const { view, setView, compact, setCompact } = useMobileSchedulePreferences();
  const [monthOpen, setMonthOpen] = useState(false);
  const [month, setMonth] = useState(date.slice(0, 7) + '-01');
  const [selected, setSelected] = useState<MobileScheduleItem | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [moveDate, setMoveDate] = useState(date);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  const itemsByDate = useMemo(() => new Map(days.map(day => [day, mobileScheduleItems({ date: day, events: props.events,
    meetings: props.meetings, tasks: props.tasks, goals: props.goals, eventLinks: props.eventLinks, day: props.previewByDate.get(day), assignment: props.assignmentsByDate.get(day), blockedTaskIds: props.blockedTaskIds })])),
  [days, props.events, props.meetings, props.tasks, props.goals, props.eventLinks, props.previewByDate, props.assignmentsByDate, props.blockedTaskIds]);
  const items = itemsByDate.get(date) ?? [];
  const nowHour = calendarDateTime(now, props.timezone).hour;
  const openItem = (item: MobileScheduleItem) => {
    if (item.event) { props.onEdit(item.event); return; }
    setMoveDate(item.date);
    setSaveError('');
    setSelected(item);
  };
  const changeDate = (next: string) => { onDate(next); setMonthOpen(false); };
  const weekSwipe = useCalendarSwipe(direction => changeDate(addDays(date, direction * 7)));
  const agendaSwipe = useCalendarSwipe(direction => changeDate(addDays(date, direction)));
  const monthDays = Array.from({ length: 42 }, (_, i) => addDays(mondayOf(month), i));
  const shiftMonth = (offset: number) => {
    const next = parseLocalDate(month);
    next.setMonth(next.getMonth() + offset);
    setMonth(fmtYMD(next));
  };
  const monthSwipe = useCalendarSwipe(shiftMonth);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;

  return <section className={`mobile-schedule mx-auto max-w-xl px-4 pb-4 ${compact ? 'mobile-schedule-compact' : ''}`} aria-label="Mobile schedule">
    <header className="sticky top-0 z-20 -mx-4 bg-white/95 px-4 py-2 backdrop-blur-xl">
      <div className="flex items-center gap-1">
        <button onClick={() => { setMonth(date.slice(0, 7) + '-01'); setMonthOpen(true); }} aria-haspopup="dialog" aria-label="Choose date" className="flex min-h-12 min-w-0 flex-1 items-center gap-2 text-left">
          <div><h1 className="text-xl font-semibold tracking-tight text-slate-950">{date === today ? 'Today' : parseLocalDate(date).toLocaleDateString('en-US', { weekday: 'long' })}</h1><p className="text-xs text-slate-500">{parseLocalDate(date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</p></div><ChevronDown size={15} className="text-slate-400" />
        </button>
        <button aria-label="Previous day" className="mobile-icon-button text-slate-500" onClick={() => changeDate(addDays(date, -1))}><ChevronLeft size={19} /></button>
        <button aria-label="Next day" className="mobile-icon-button text-slate-500" onClick={() => changeDate(addDays(date, 1))}><ChevronRight size={19} /></button>
        <button aria-label="Schedule options" aria-haspopup="dialog" onClick={() => setOptionsOpen(true)} className="mobile-icon-button text-slate-600"><SlidersHorizontal size={20} /></button>
      </div>
      {!compact && <div ref={weekSwipe} className="mobile-gesture-surface mt-2 grid grid-cols-7 gap-1" aria-label="Week dates">
        {days.map(day => <button key={day} aria-label={dateLabel(day)} aria-pressed={day === date} aria-current={day === today ? 'date' : undefined} onClick={() => changeDate(day)} className={`flex min-h-14 flex-col items-center justify-center rounded-xl ${day === date ? 'bg-indigo-600 text-white' : day === today ? 'bg-indigo-50 text-indigo-600' : 'text-slate-500'}`}>
          <span className="text-[10px]">{parseLocalDate(day).toLocaleDateString('en-US', { weekday: 'short' })}</span><span className="text-base font-semibold">{parseLocalDate(day).getDate()}</span>
          <span className={`h-1 w-1 rounded-full ${(itemsByDate.get(day)?.length ?? 0) > 0 ? day === date ? 'bg-white' : 'bg-indigo-400' : 'bg-transparent'}`} />
        </button>)}
      </div>}
    </header>
    {monthOpen && <MobileSheet title="Choose a date" onClose={() => setMonthOpen(false)}>
      <div ref={monthSwipe} aria-label="Month date picker" className="mobile-gesture-surface mt-2 rounded-2xl border border-slate-100 bg-slate-50 p-2">
        <div className="flex items-center justify-between"><button aria-label="Previous month" className="mobile-icon-button" onClick={() => shiftMonth(-1)}><ChevronLeft size={18} /></button>
          <span className="text-sm font-semibold">{parseLocalDate(month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
          <button aria-label="Next month" className="mobile-icon-button" onClick={() => shiftMonth(1)}><ChevronRight size={18} /></button></div>
        <div className="grid grid-cols-7 text-center">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, i) => <span key={i} className="py-2 text-xs text-slate-400">{day}</span>)}
          {monthDays.map(day => <button key={day} aria-label={dateLabel(day)} aria-pressed={day === date} onClick={() => changeDate(day)} className={`min-h-11 rounded-xl text-sm ${day === date ? 'bg-indigo-600 font-bold text-white' : day.slice(0, 7) !== month.slice(0, 7) ? 'text-slate-300' : day === today ? 'font-bold text-indigo-600' : 'text-slate-700'}`}>{parseLocalDate(day).getDate()}</button>)}
        </div>
        <label className="mt-2 flex items-center justify-between gap-2 border-t border-slate-200 px-2 pt-2 text-xs text-slate-500">Jump to date<input aria-label="Jump to date" type="date" value={date} onChange={e => { if (e.target.value) changeDate(e.target.value); }} className="min-h-11 min-w-0 rounded-lg bg-white px-2 text-slate-700" /></label>
      </div>
      <div className="mt-3 flex items-center justify-between"><button aria-label="Previous week" className="min-h-11 px-2 text-sm text-slate-600" onClick={() => changeDate(addDays(date, -7))}>← Previous week</button><button onClick={() => changeDate(today)} className="min-h-11 px-3 text-sm font-semibold text-indigo-600">Today</button><button aria-label="Next week" className="min-h-11 px-2 text-sm text-slate-600" onClick={() => changeDate(addDays(date, 7))}>Next week →</button></div>
    </MobileSheet>}
    {optionsOpen && <MobileSheet title="Schedule options" onClose={() => setOptionsOpen(false)}>
      <p className="mb-2 text-xs font-semibold text-slate-500">View</p>
      <div className="mb-5 flex gap-1 rounded-2xl bg-slate-100 p-1">{(['agenda', 'day'] as const).map(mode => <button key={mode} onClick={() => { setView(mode); setOptionsOpen(false); }} aria-pressed={view === mode} className={`flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl text-sm font-semibold ${view === mode ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>{mode === 'agenda' ? <List size={18} /> : <Clock size={18} />}{mode === 'agenda' ? 'Agenda' : 'Day'}</button>)}</div>
      <button onClick={() => setCompact(!compact)} aria-label={compact ? 'Expand calendar controls' : 'Minimize calendar controls'} aria-pressed={compact} className="flex min-h-16 w-full items-center justify-between gap-4 border-b border-slate-100 text-left"><span><span className="block text-sm font-medium">Compact calendar</span><span className="text-xs text-slate-500">Hide the week strip · saved on this device</span></span><span className={`rounded-full px-3 py-1 text-xs font-semibold ${compact ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-100 text-slate-500'}`}>{compact ? 'On' : 'Off'}</span></button>
      <button onClick={() => { setOptionsOpen(false); setRoutinesOpen(true); }} className="flex min-h-14 w-full items-center gap-3 text-sm font-medium"><Repeat size={18} className="text-teal-600" />Routines</button>
      <button onClick={() => { void props.onRefresh(); setOptionsOpen(false); }} disabled={props.refreshing || !online} aria-label="Refresh schedule" className="flex min-h-14 w-full items-center gap-3 text-sm text-slate-600 disabled:opacity-40"><RefreshCw size={18} className={props.refreshing ? 'animate-spin' : ''} />Refresh schedule</button>
      {!standalone && <button onClick={() => { setOptionsOpen(false); setInstallOpen(true); }} aria-label="Install on iPhone" className="flex min-h-14 w-full items-center gap-3 text-sm text-slate-600"><Share size={18} />Add to Home Screen</button>}
      {props.timezone && <p className="mt-3 text-xs text-slate-400">Times in {props.timezone.replaceAll('_', ' ')}</p>}
    </MobileSheet>}
    {routinesOpen && <MobileSheet title="Your routines" onClose={() => setRoutinesOpen(false)}>{props.renderRoutines(date, () => setRoutinesOpen(false))}</MobileSheet>}

    {!online && <p role="status" className="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">You’re offline. Reconnect to refresh your schedule or save changes.</p>}
    {props.error && <div role="alert" className="mb-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">Couldn’t load the latest schedule. <button onClick={() => void props.onRefresh()} className="min-h-11 font-semibold underline">Try again</button></div>}
    {props.loading ? <div role="status" className="space-y-3 py-4"><p className="text-sm text-slate-500">Loading your schedule…</p>{[1, 2, 3].map(n => <div key={n} className="h-20 animate-pulse rounded-2xl bg-slate-100" />)}</div> : props.error ? null : <>
      <p className="mb-3 mt-2 text-xs text-slate-400">{items.length ? items.length + ' items · ' + (view === 'day' ? 'Day timeline' : 'Agenda') : 'A little room to breathe'}</p>
      {view === 'day' ? <>
        {items.some(item => item.start === null) && <details className="mb-3 rounded-2xl border border-slate-100 p-3"><summary className="min-h-8 cursor-pointer text-sm font-semibold text-slate-600">Tasks & deadlines · {items.filter(item => item.start === null).length}</summary><div className="mt-2 space-y-2">{items.filter(item => item.start === null).map(item => <ItemCard key={item.id} item={item} onOpen={openItem} />)}</div></details>}
        <MobileDayTimeline key={date} date={date} today={today} nowHour={nowHour} items={items} online={online} compact={compact}
          onOpen={openItem} onCreate={props.onCreate} onChangeEvent={props.onChangeEvent}
          onSwipe={direction => changeDate(addDays(date, direction))} />
      </> : <div ref={agendaSwipe} className="mobile-gesture-surface space-y-6" aria-label="Schedule agenda">
        {days.filter(day => day >= date).map(day => {
          const dayItems = itemsByDate.get(day) ?? [];
          return <div key={day}>{day !== date && <button onClick={() => changeDate(day)} className="mb-2 min-h-11 text-sm font-semibold text-slate-600">{dateLabel(day)}</button>}
            {dayItems.length ? <div className="space-y-2">{dayItems.map(item => <ItemCard key={item.id} item={item} onOpen={openItem} />)}</div> : <button onClick={() => props.onCreate(day)} className="flex min-h-24 w-full items-center gap-3 rounded-2xl border border-dashed border-slate-200 px-4 text-left"><CalendarDays size={24} className="text-indigo-300" /><span><span className="block text-sm font-medium text-slate-600">Nothing scheduled</span><span className="mt-1 block text-xs text-slate-400">Tap to make a little time for something.</span></span></button>}
          </div>;
        })}
        <button onClick={() => changeDate(addDays(days[0], 7))} className="min-h-12 w-full rounded-xl bg-slate-50 text-sm font-semibold text-indigo-600">Next week <span aria-hidden="true">→</span></button>
      </div>}
    </>}
    <button onClick={() => setAddOpen(true)} aria-label="Add to schedule" className="mobile-schedule-add fixed right-5 z-30 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-300/60 active:scale-95"><Plus size={27} /></button>

    {addOpen && <ModalFrame titleId="mobile-add-title" onClose={() => setAddOpen(false)} className="mobile-sheet w-full max-w-md rounded-3xl bg-white p-5 shadow-xl"><div className="flex items-center justify-between"><h2 id="mobile-add-title" className="text-xl font-bold">Add to your day</h2><button aria-label="Close add menu" className="mobile-icon-button" onClick={() => setAddOpen(false)}><X size={20} /></button></div><p className="mb-4 text-sm text-slate-400">{dateLabel(date)}</p>
      <button className="mb-2 min-h-16 w-full rounded-2xl bg-indigo-50 px-4 text-left font-semibold text-indigo-700" onClick={() => { setAddOpen(false); props.onCreate(date); }}>Calendar block <span className="block text-xs font-normal">Set a time, duration and linked task</span></button>
      <button className="min-h-16 w-full rounded-2xl bg-violet-50 px-4 text-left font-semibold text-violet-700" onClick={() => { setAddOpen(false); props.onAddTask(date); }}>Task <span className="block text-xs font-normal">Add work to this day</span></button>
      <button className="mt-2 min-h-16 w-full rounded-2xl bg-teal-50 px-4 text-left font-semibold text-teal-700" onClick={() => { setAddOpen(false); setRoutinesOpen(true); }}>Routine <span className="block text-xs font-normal">A habit with its own cadence and target</span></button>
    </ModalFrame>}
    {installOpen && <ModalFrame titleId="mobile-install-title" onClose={() => setInstallOpen(false)} className="mobile-sheet w-full max-w-md rounded-3xl bg-white p-6 shadow-xl"><div className="flex items-center justify-between"><h2 id="mobile-install-title" className="text-xl font-bold">Marina on your Home Screen</h2><button aria-label="Close install instructions" className="mobile-icon-button shrink-0" onClick={() => setInstallOpen(false)}><X size={20} /></button></div><p className="mt-3 text-sm leading-6 text-slate-500">Open this website in Safari on your iPhone, then:</p><ol className="my-4 list-decimal space-y-3 pl-5 text-sm text-slate-700"><li>Tap Share (the square with an arrow).</li><li>Choose <strong>Add to Home Screen</strong>.</li><li>Keep <strong>Open as Web App</strong> on if shown, then tap <strong>Add</strong>.</li></ol><p className="text-xs leading-5 text-slate-400">Your shortcut opens straight to Schedule. Sign in with the same workspace password. An internet connection keeps your schedule up to date.</p></ModalFrame>}
    {selected && <ModalFrame titleId="mobile-item-title" onClose={() => setSelected(null)} className="mobile-sheet w-full max-w-md rounded-3xl bg-white p-5 shadow-xl"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wider text-indigo-500">{selected.detail}</p><h2 id="mobile-item-title" className="mt-2 break-words text-xl font-bold text-slate-900">{selected.title}</h2></div><button aria-label="Close schedule details" className="mobile-icon-button shrink-0" onClick={() => setSelected(null)}><X size={20} /></button></div>
      {selected.context && <p className="mt-2 text-sm text-slate-500">{selected.context}</p>}
      <p className="mt-3 text-sm text-slate-500">{dateLabel(selected.date)}{selected.start !== null ? ` · ${fmtTimeRange(selected.start, selected.minutes / 60)}` : ''}</p>
      {selected.minutes > 0 && <p className="mt-1 text-sm text-slate-500">{durationLabel(selected.minutes)} planned</p>}
      {selected.task && <div className="mt-5 space-y-3">
        <button disabled={!online} onClick={() => { props.onStartFocus(selected.task!); setSelected(null); }} className="min-h-12 w-full rounded-xl bg-indigo-600 text-sm font-semibold text-white disabled:opacity-40">Start focus</button>
        <button disabled={!online} onClick={() => { const task = selected.task!; setSelected(null); openCompletionReport(task.id); }} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-50 text-sm font-semibold text-emerald-700 disabled:opacity-40"><Check size={17} />Complete task</button>
        <button disabled={!online} onClick={() => { props.onScheduleTask(selected.task!, selected.date, 9); setSelected(null); }} className="min-h-12 w-full rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 disabled:opacity-40">Choose a time for this task</button>
        <label className="block text-xs font-semibold text-slate-500">Move task to<input aria-label="Move task to date" type="date" value={moveDate} onChange={e => setMoveDate(e.target.value)} className="mt-2 min-h-12 w-full rounded-xl border border-slate-200 px-3 text-slate-800" /></label>
        <button disabled={saving || !moveDate || !online} onClick={async () => { setSaving(true); setSaveError(''); try { await props.onMoveTask(selected.task!.id, moveDate); setSelected(null); } catch (error) { setSaveError(error instanceof Error ? error.message : 'Could not move task.'); } finally { setSaving(false); } }} className="min-h-12 w-full rounded-xl bg-slate-100 text-sm font-semibold text-slate-700 disabled:opacity-40">{saving ? 'Moving…' : 'Move task'}</button>
        {saveError && <p role="alert" className="text-sm text-red-600">{saveError}</p>}
      </div>}
      {selected.kind === 'routine' && <div className="mt-4">{props.renderRoutines(selected.date, () => setSelected(null))}</div>}
      {(selected.goalId || selected.task?.goal_id) && <button onClick={() => { navigateToGoal((selected.goalId || selected.task?.goal_id)!); setSelected(null); }} className="mt-3 min-h-12 w-full rounded-xl bg-slate-50 text-sm font-semibold text-indigo-600">Open goal</button>}
    </ModalFrame>}
  </section>;
}
