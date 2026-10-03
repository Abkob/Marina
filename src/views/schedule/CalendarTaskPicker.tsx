import { buildWorkHierarchy } from '../../../shared/workHierarchy';
import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { DBGoal, DBTask } from '../../db/schema';
function fmtMins(mins: number) { return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`; }

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
  const stack = roots.slice().reverse().map(task => ({ task, depth: 0, parents: [] as string[] }));
  const visited = new Set<string>();
  while (stack.length) {
    const { task, depth, parents } = stack.pop()!;
    if (visited.has(task.id)) continue;
    visited.add(task.id);
    rows.push({ task, depth: Math.min(depth, 3), context: [goalTitle.get(task.goal_id ?? ''), ...parents].filter(Boolean).join(' · ') });
    for (const child of (children.get(task.id) ?? []).slice().sort((a,b) => b.position-a.position)) {
      stack.push({ task: child, depth: depth + 1, parents: [...parents.slice(-1), task.title] });
    }
  }
  return rows;
}

export function TaskPicker({ tasks, goals, onPick }: { tasks: DBTask[]; goals: DBGoal[]; onPick: (t: DBTask) => void }) {
  const [q, setQ] = useState('');
  const hierarchy = useMemo(() => buildWorkHierarchy(tasks), [tasks]);
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
          aria-label="Search tasks" placeholder="Search tasks and subtasks…"
          className="w-full bg-transparent text-xs outline-none placeholder:text-gray-300"
        />
      </div>
      <div className="max-h-44 overflow-y-auto py-1">
        {filtered.length === 0 && (
          <p className="px-3 py-2 text-[11px] text-gray-400">No open task matches "{q}".</p>
        )}
        {filtered.slice(0, 60).map(({ task, depth, context }) => {
          const remaining = hierarchy.summaries.get(task.id)?.own.remaining_minutes ?? null;
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => onPick(task)}
              className="flex min-h-11 w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-indigo-50/60 focus-visible:outline focus-visible:outline-indigo-500"
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

