import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Clock3, Layers3 } from 'lucide-react';

export interface OverdueTaskItem {
  id: string;
  title: string;
  goal_id: string | null;
  goal_title: string | null;
  deadline: string;
  deadline_kind: string | null;
  days_overdue: number;
  status: string;
  remaining_minutes: number | null;
  is_parent_rollup: boolean;
}

export interface OverdueTasksView { tasks: OverdueTaskItem[] }

const duration = (minutes: number | null) => {
  if (!minutes) return 'Needs estimate';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h${rest ? ` ${rest}m` : ''}`;
};

export function OverdueTasksWidget({ view }: { view: OverdueTasksView }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? view.tasks : view.tasks.slice(0, 8);
  const grouped = useMemo(() => {
    const map = new Map<string, OverdueTaskItem[]>();
    for (const task of visible) {
      const key = task.goal_title || 'Unassigned';
      map.set(key, [...(map.get(key) ?? []), task]);
    }
    return [...map.entries()];
  }, [visible]);
  const leaves = view.tasks.filter(task => !task.is_parent_rollup);
  const estimated = leaves.reduce((sum, task) => sum + (task.remaining_minutes ?? 0), 0);
  const unestimated = leaves.filter(task => !task.remaining_minutes).length;

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-red-400/20 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-gradient-to-r from-red-500/10 to-amber-500/5 px-5 py-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-red-400/20 bg-red-500/15">
          <AlertTriangle size={18} className="text-red-700" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-slate-900">Overdue work</p>
          <p className="mt-0.5 text-xs text-slate-500">Ordered by oldest effective deadline</p>
        </div>
        <div className="flex gap-2">
          <span className="rounded-lg border border-red-400/15 bg-red-500/10 px-2.5 py-1.5 text-xs font-semibold text-red-700">{view.tasks.length} tasks</span>
          <span className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">{duration(estimated)}</span>
          {unestimated > 0 && <span className="rounded-lg border border-amber-400/15 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700">{unestimated} unestimated</span>}
        </div>
      </div>

      <div className="divide-y divide-slate-100">
        {grouped.map(([goal, tasks]) => (
          <section key={goal} className="px-5 py-3.5">
            <div className="mb-2.5 flex items-center gap-2 text-xs font-medium text-slate-500">
              <Layers3 size={12} className="text-indigo-700" />
              <span className="truncate">{goal}</span>
              <span className="text-slate-500">{tasks.length}</span>
            </div>
            <div className="space-y-1.5">
              {tasks.map(task => (
                <div key={task.id} className="group flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 hover:border-slate-200 hover:bg-slate-50">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${task.days_overdue >= 14 ? 'bg-red-400' : task.days_overdue >= 7 ? 'bg-orange-400' : 'bg-amber-300'}`} />
                  <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-900">{task.title}</p>
                  {task.is_parent_rollup && <span className="rounded-md bg-purple-500/10 px-2 py-1 text-[10px] text-purple-700">Group</span>}
                  <span className="hidden items-center gap-1 text-[11px] text-slate-500 sm:flex"><Clock3 size={11} />{duration(task.remaining_minutes)}</span>
                  <span className={`w-20 text-right text-[11px] font-semibold ${task.days_overdue >= 14 ? 'text-red-700' : 'text-amber-700'}`}>{task.days_overdue}d late</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      {view.tasks.length > 8 && (
        <button onClick={() => setExpanded(value => !value)} className="flex w-full items-center justify-center gap-1.5 border-t border-slate-200 px-4 py-3 text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-900">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {expanded ? 'Show fewer tasks' : `Show all ${view.tasks.length} tasks`}
        </button>
      )}
    </div>
  );
}
