import { useRef } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { addDays, mondayOf, parseLocalDate } from '../../utils/calendar';
import { navigateCalendar, type CalendarView } from '../../utils/calendarView';

interface Props {
  date: string;
  today: string;
  view: CalendarView;
  planning: boolean;
  onDate: (date: string) => void;
  onView: (view: CalendarView) => void;
  onPlan: () => void;
  onCreate: () => void;
}

export function ScheduleToolbar({ date, today, view, planning, onDate, onView, onPlan, onCreate }: Props) {
  const picker = useRef<HTMLDetailsElement>(null);
  const label = parseLocalDate(date).toLocaleDateString('en-US', view === 'day'
    ? { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' }
    : { month: 'long', year: 'numeric' });
  const showingToday = view === 'day' ? date === today : view === 'month'
    ? date.slice(0, 7) === today.slice(0, 7) : mondayOf(date) === mondayOf(today);
  const weekLabel = view === 'week' ? `${parseLocalDate(mondayOf(date)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${parseLocalDate(addDays(mondayOf(date), 6)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : undefined;

  return <header className="schedule-toolbar" aria-label="Schedule navigation">
    <details ref={picker} className="schedule-date-picker" onKeyDown={e => { if (e.key === 'Escape' && picker.current) { picker.current.open = false; picker.current.querySelector('summary')?.focus(); } }}>
      <summary aria-label="Choose calendar date" className="schedule-date-heading"><span>{label}</span><ChevronDown size={14} /></summary>
      <div className="schedule-date-popover"><label className="text-xs text-slate-500">Go to date<input aria-label="Jump to calendar date" type="date" value={date} onChange={e => { if (e.target.value) { onDate(e.target.value); if (picker.current) picker.current.open = false; } }} className="mt-2 block min-h-11 w-full rounded-lg border border-slate-200 p-2 text-sm text-slate-800" /></label></div>
    </details>
    <div className="flex items-center" title={weekLabel}>
      <button className="schedule-toolbar-icon" aria-label={`Previous ${view}`} onClick={() => onDate(navigateCalendar(date, view, -1))}><ChevronLeft size={18} /></button>
      <button className="schedule-toolbar-icon" aria-label={`Next ${view}`} onClick={() => onDate(navigateCalendar(date, view, 1))}><ChevronRight size={18} /></button>
    </div>
    {!showingToday && <button onClick={() => onDate(today)} className="schedule-toolbar-text">Today</button>}
    <div className="ml-auto flex items-center gap-2">
      <select aria-label="Calendar view" value={view} onChange={e => onView(e.target.value as CalendarView)} className="schedule-view-select"><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select>
      <button aria-expanded={planning} aria-controls="schedule-planning" onClick={onPlan} className={`schedule-toolbar-text ${planning ? 'bg-slate-100 text-slate-900' : ''}`}>Plan</button>
      <button onClick={onCreate} aria-label="Create calendar block" className="schedule-toolbar-icon border border-slate-200"><Plus size={18} /></button>
    </div>
  </header>;
}
