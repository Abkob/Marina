import { useMemo, useState } from 'react';
import { ArrowUpRight, CalendarDays, ChevronRight, RefreshCw } from 'lucide-react';
import { useAllTasks, useGoals } from '../api/hooks';
import { useAppStore } from '../store/useAppStore';
import { parseLocalDate } from '../utils/calendar';

/** A readable project timeline for phones, using the same task dates as Gantt. */
export function MobileTimeline() {
  const tasksQuery = useAllTasks();
  const goalsQuery = useGoals();
  const { navigateToGoal, setFocusedTaskId, setWorkTaskId, setCurrentTab } = useAppStore();
  const [goalId, setGoalId] = useState('');
  const [showCompleted, setShowCompleted] = useState(false);
  const goals = goalsQuery.data ?? [];
  const groups = useMemo(() => {
    const grouped = new Map<string, NonNullable<typeof tasksQuery.data>>();
    for (const task of tasksQuery.data ?? []) {
      if (goalId && task.goal_id !== goalId) continue;
      if (!showCompleted && (task.completed || task.status === 'done')) continue;
      const date = task.due_date?.slice(0, 10) || task.start_date?.slice(0, 10) || '';
      grouped.set(date, [...(grouped.get(date) ?? []), task]);
    }
    return [...grouped.entries()].sort(([a], [b]) => !a ? 1 : !b ? -1 : a.localeCompare(b));
  }, [tasksQuery.data, goalId, showCompleted]);
  return <section className="mx-auto max-w-xl px-4 py-6" aria-label="Project timeline">
    <div className="mb-5 flex items-start justify-between gap-3"><div><h1 className="text-2xl font-bold tracking-tight text-slate-900">Timeline</h1><p className="mt-1 text-sm leading-6 text-slate-500">Dates and next steps across your goals.</p></div><button aria-label="Refresh timeline" onClick={() => { void tasksQuery.refetch(); void goalsQuery.refetch(); }} className="mobile-icon-button shrink-0 text-slate-500"><RefreshCw size={19} /></button></div>
    <label className="block text-xs font-semibold text-slate-500">Goal<select value={goalId} onChange={event => setGoalId(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-800"><option value="">All goals and standalone tasks</option>{goals.map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label>
    <label className="my-4 flex min-h-11 items-center gap-3 text-sm text-slate-600"><input type="checkbox" checked={showCompleted} onChange={event => setShowCompleted(event.target.checked)} className="h-5 w-5 accent-indigo-600" />Include completed tasks</label>
    {(tasksQuery.isLoading || goalsQuery.isLoading) && <p role="status" className="py-8 text-center text-sm text-slate-500">Loading your timeline…</p>}
    {(tasksQuery.error || goalsQuery.error) && <p role="alert" className="mb-4 rounded-xl bg-rose-50 p-4 text-sm text-rose-700">Couldn’t refresh your timeline. Check your connection and try again.</p>}
    {!tasksQuery.isLoading && groups.length === 0 && <p className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">No tasks to show for this selection.</p>}
    <div className="space-y-6">{groups.map(([date, tasks]) => <section key={date}>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800"><CalendarDays size={17} className="text-indigo-500" />{date ? parseLocalDate(date).toLocaleDateString('en-US', {weekday:'short',month:'short',day:'numeric',year:'numeric'}) : 'No date yet'}</h2>
      <div className="ml-2 space-y-2 border-l-2 border-indigo-100 pl-4">{tasks.map(task => <button key={task.id} onClick={() => { if (task.goal_id) { navigateToGoal(task.goal_id); setFocusedTaskId(task.id); } else { setWorkTaskId(task.id); setCurrentTab('Work'); } }} className="flex w-full items-center gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-4 text-left" aria-label={`Open task ${task.title}`}>
        <div className="min-w-0 flex-1"><p className={`text-sm font-semibold text-slate-900 ${task.completed ? 'line-through opacity-60' : ''}`}>{task.title}</p><p className="mt-1 text-xs text-slate-500">{goals.find(goal => goal.id === task.goal_id)?.title ?? 'Standalone task'}</p><p className="mt-2 text-xs font-medium text-indigo-600">{task.due_date ? 'Due date' : task.start_date ? 'Start date' : 'Unscheduled'}{task.estimated_minutes ? ` · ${task.estimated_minutes} min` : ''}</p></div><ChevronRight size={18} className="shrink-0 text-slate-400" />
      </button>)}</div>
    </section>)}</div>
    <button onClick={() => setCurrentTab('Schedule')} className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-50 px-4 py-3 text-sm font-semibold text-indigo-700">Open daily schedule<ArrowUpRight size={17} /></button>
  </section>;
}
