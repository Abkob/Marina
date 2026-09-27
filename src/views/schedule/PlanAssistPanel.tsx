import { useState } from 'react';
import { CalendarPlus, PanelRightClose, Sparkles } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { ScheduleTaskInfo } from '../../api/hooks';
import type { DBTask } from '../../db/schema';
import type { PlanSuggestion } from '../../utils/planAssist';
import { parseLocalDate } from '../../utils/calendar';

/**
 * The auto-planner's opinion, as explicit cards. Nothing lands on the
 * calendar until Place is clicked — the planner never paints on its own.
 */

function fmtMins(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${m ? ` ${m}m` : ''}`;
}

function fmtDay(dateStr: string): string {
  return parseLocalDate(dateStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function PlanAssistPanel({ suggestions, taskLookup, unestimated, rollupCount, onPlace, onPlaceAll, onCollapse }: {
  suggestions: PlanSuggestion[];
  taskLookup: Record<string, ScheduleTaskInfo>;
  unestimated: DBTask[];
  rollupCount: number;
  onPlace: (taskId: string, date: string) => Promise<void> | void;
  onPlaceAll: () => Promise<void>;
  onCollapse?: () => void;
}) {
  const { navigateToGoal } = useAppStore();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAll, setBusyAll] = useState(false);

  const place = async (s: PlanSuggestion) => {
    setBusyId(s.taskId);
    try { await onPlace(s.taskId, s.date); } finally { setBusyId(null); }
  };
  const placeAll = async () => {
    setBusyAll(true);
    try { await onPlaceAll(); } finally { setBusyAll(false); }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-gray-700">
          <Sparkles size={12} className="text-[#4648d4]" /> Plan assist
        </p>
        <div className="flex items-center gap-2">
          {suggestions.length > 1 && (
            <button
              onClick={placeAll}
              disabled={busyAll}
              className="font-mono text-[10px] uppercase text-[#4648d4] hover:underline disabled:opacity-40"
            >
              Place all {suggestions.length}
            </button>
          )}
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-600"
              title="Collapse Plan assist"
              aria-label="Collapse Plan assist"
            >
              <PanelRightClose size={13} />
            </button>
          )}
        </div>
      </div>
      <p className="mb-2 text-[10px] text-gray-400">
        Days the auto-planner suggests for your unplaced tasks. Nothing moves until you place it.
      </p>

      {suggestions.length === 0 && (
        <p className="font-mono text-[10px] text-gray-300">every ready task has a day</p>
      )}
      <div className="max-h-64 space-y-1.5 overflow-y-auto pr-0.5">
        {suggestions.map(s => {
          const info = taskLookup[s.taskId];
          return (
            <div key={s.taskId} data-testid="schedule-proposal" className="flex items-center gap-2 rounded-lg border border-gray-100 px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-medium text-gray-800" title={info?.title ?? s.taskId}>
                  {info?.title ?? s.taskId}
                </p>
                <p className="font-mono text-[9px] text-gray-400">
                  {fmtDay(s.date)}{info?.estimated_minutes ? ` · ${fmtMins(info.estimated_minutes)}` : ''}
                </p>
              </div>
              <button
                onClick={() => place(s)}
                disabled={busyId === s.taskId || busyAll}
                title="Apply"
                className="flex shrink-0 items-center gap-1 rounded bg-[#4648d4] px-2 py-1 text-[9px] font-bold uppercase text-white hover:opacity-90 disabled:opacity-40"
              >
                <CalendarPlus size={10} /> Place
              </button>
            </div>
          );
        })}
      </div>

      {unestimated.length > 0 && (
        <div className="mt-2 border-t border-dashed border-amber-200 pt-2">
          <p className="mb-1 font-mono text-[9px] text-amber-600">
            {unestimated.length} can't be planned without a time estimate:
          </p>
          <div className="max-h-28 overflow-y-auto pr-0.5">
            {unestimated.slice(0, 10).map(t => (
              <button
                key={t.id}
                onClick={() => t.goal_id && navigateToGoal(t.goal_id)}
                className="w-full truncate rounded px-1.5 py-0.5 text-left text-[10px] text-amber-700/80 hover:bg-amber-50"
                title="Open its goal to add an estimate"
              >
                {t.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {rollupCount > 0 && (
        <p className="mt-2 border-t border-gray-100 pt-2 text-[9px] text-gray-400">
          {rollupCount} parent / long-term task{rollupCount !== 1 ? 's' : ''} stay out of auto-planning — their subtasks are planned instead.
        </p>
      )}
    </div>
  );
}
