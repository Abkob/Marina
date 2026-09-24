import { useState } from 'react';
import { Target, Calendar, Archive, RotateCcw, CheckSquare, Square, Plus, AlertCircle, Clock, Trash2, MoreHorizontal, ChevronRight, Milestone } from 'lucide-react';
import { motion } from 'motion/react';
import { useAppStore } from '../store/useAppStore';
import { MobileSheet } from '../components/MobileSheet';
import { taskContextMap } from '../utils/taskContext';
import { ProgressRing } from '../components/ProgressRing';
import { useGoals, useAllGoals, useAllTasks, useInvalidate } from '../api/hooks';
import { archiveGoal, restoreGoal, deleteGoal } from '../db/queries/goals';
import { toggleTask } from '../db/queries/tasks';
import { getGoalFinishEstimate, type GoalFinishEstimate } from '../utils/goalFinishEstimate';
import { calculateGoalTaskMetrics, computeGoalStatus, getClosestDueTask, type GoalTaskMetrics, type ClosestDue } from '../utils/goalTaskMetrics';
import { computeGoalTimeStats, projectedFinishDate, formatProjectedDate } from '../utils/goalTimeAnalytics';
import type { DBGoal, DBTask } from '../db/schema';
import { DatabaseAtlas } from '../components/DatabaseAtlas';
import { useMediaQuery, MOBILE_LAYOUT_QUERY } from '../hooks/useMediaQuery';

const STATUS_BG   = { Safe: 'bg-[#10B981]', Watch: 'bg-[#F59E0B]', Risky: 'bg-[#EF4444]' };
const STATUS_TEXT = { Safe: 'text-[#10B981]', Watch: 'text-[#F59E0B]', Risky: 'text-[#EF4444]' };

// ─── Due warning strip ────────────────────────────────────────────────────────
function DueWarning({ due }: { due: ClosestDue }) {
  const cfg = {
    overdue:  { bg: 'bg-red-50 border-red-200',     text: 'text-red-600',    Icon: AlertCircle, label: 'Overdue'   },
    today:    { bg: 'bg-orange-50 border-orange-200', text: 'text-orange-600', Icon: AlertCircle, label: 'Due today'  },
    tomorrow: { bg: 'bg-amber-50 border-amber-200',  text: 'text-amber-600',  Icon: Clock,       label: 'Tomorrow'  },
    soon:     { bg: 'bg-yellow-50 border-yellow-100', text: 'text-yellow-700', Icon: Clock,       label: `In ${due.daysUntil}d` },
  } as const;

  const { bg, text, Icon, label } = cfg[due.urgency!];
  const title = due.task.title.length > 32 ? due.task.title.slice(0, 31) + '…' : due.task.title;

  return (
    <div className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 mb-3 border ${bg}`}>
      <Icon size={10} className={`${text} shrink-0`} />
      <span className={`font-mono text-[9px] font-bold uppercase tracking-wide ${text} shrink-0`}>{label}:</span>
      <span className={`font-mono text-[9px] ${text} truncate`}>{title}</span>
    </div>
  );
}

// ─── Goal Card ────────────────────────────────────────────────────────────────
function GoalCard({
  goal,
  tasks,
  nextAction,
  finishEstimate,
  metrics,
  closestDue,
  tab,
}: {
  goal: DBGoal;
  tasks: DBTask[];
  nextAction?: DBTask;
  finishEstimate: GoalFinishEstimate;
  metrics: GoalTaskMetrics;
  closestDue: ClosestDue | null;
  tab: 'Active' | 'Completed' | 'Archived';
}) {
  const { setSelectedGoalId, triggerToast, showConfirm } = useAppStore();
  const invalidate = useInvalidate();
  const isArchived = Boolean(goal.archived_at);
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const [actionsOpen, setActionsOpen] = useState(false);
  const status = computeGoalStatus(goal, tasks);
  const timeStats = computeGoalTimeStats(tasks);
  const finishProjection = projectedFinishDate(timeStats);

  // Every mutation invalidates immediately — without this the 10s stale window
  // made archive/restore/delete look like they "need a refresh" to take effect.
  const handleArchiveToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isArchived) {
      showConfirm(`Restore goal "${goal.title}"?`, async () => {
        await restoreGoal(goal.id);
        invalidate.goals();
        triggerToast('Goal restored with progress intact.', 'success');
      });
      return;
    }

    showConfirm(`Archive goal "${goal.title}"? Your tasks, resources, and progress will be saved.`, async () => {
      await archiveGoal(goal.id);
      invalidate.goals();
      triggerToast('Goal archived. Progress saved.', 'info');
    });
  };

  const handleToggleNextAction = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!nextAction) return;
    await toggleTask(nextAction.id);
    invalidate.allTasks();
    invalidate.goals();
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    showConfirm(
      `Permanently delete "${goal.title}"? This removes all tasks, notes, and resources linked to it. This cannot be undone.`,
      async () => {
        await deleteGoal(goal.id);
        invalidate.goals();
        invalidate.allTasks();
        triggerToast('Goal permanently deleted.', 'info');
      }
    );
  };

  const openGoal = () => setSelectedGoalId(goal.id);

  if (isMobile) return <article className="border-b border-slate-100 py-4">
    <div className="flex items-start gap-2"><button onClick={openGoal} aria-label={'Open goal ' + goal.title} className="min-w-0 flex-1 text-left">
      <div className="flex items-center gap-2"><h3 className="min-w-0 flex-1 text-base font-semibold leading-6 text-slate-900">{goal.title}</h3><ChevronRight size={16} className="shrink-0 text-slate-300" /></div>
      <p className="mt-1 text-xs text-slate-500">{metrics.progress}% complete · {finishEstimate.caption} {finishEstimate.label}</p>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-slate-100"><div className={'h-full rounded-full ' + STATUS_BG[status]} style={{width: Math.min(100, Math.max(0, metrics.progress)) + '%'}} /></div>
      {closestDue && <p className="mt-2 truncate text-xs text-amber-700">{closestDue.daysUntil < 0 ? 'Overdue' : closestDue.daysUntil === 0 ? 'Due today' : 'Coming up'} · {closestDue.task.title}{taskContextMap(tasks).get(closestDue.task.id) ? ' · ' + taskContextMap(tasks).get(closestDue.task.id) : ''}</p>}
      {nextAction && !closestDue && <p className="mt-2 truncate text-xs text-slate-500">Next · {nextAction.title}</p>}
    </button><button onClick={() => setActionsOpen(true)} aria-label={'Options for goal ' + goal.title} aria-haspopup="dialog" className="mobile-icon-button -mr-2 -mt-1 text-slate-400"><MoreHorizontal size={20} /></button></div>
    {actionsOpen && <MobileSheet title={goal.title} onClose={() => setActionsOpen(false)}>
      <button onClick={openGoal} className="min-h-14 w-full text-left text-sm font-medium">Open goal</button>
      {nextAction && <button onClick={handleToggleNextAction} className="min-h-14 w-full text-left text-sm text-emerald-700">{nextAction.completed ? 'Reopen' : 'Complete'}: {nextAction.title}</button>}
      <button onClick={event => { handleArchiveToggle(event); setActionsOpen(false); }} className="min-h-14 w-full text-left text-sm text-slate-600">{isArchived ? 'Restore goal' : 'Archive goal'}</button>
      {isArchived && <button onClick={event => { handleDelete(event); setActionsOpen(false); }} className="min-h-14 w-full text-left text-sm text-red-600">Delete permanently</button>}
    </MobileSheet>}
  </article>;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      whileHover={{ y: -3 }}
      transition={{ duration: 0.2 }}
      role="button"
      tabIndex={0}
      aria-label={`Open goal ${goal.title}`}
      onClick={openGoal}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openGoal();
        }
      }}
      className={`bg-white rounded-xl p-5 border border-gray-100 hover:border-gray-200 shadow-card hover:shadow-card-hover relative overflow-hidden group cursor-pointer flex flex-col h-full focus:outline-none focus:ring-2 focus:ring-[#4648d4]/30 ${isArchived ? 'opacity-75' : ''}`}
    >
      <div className={`absolute top-0 left-0 w-full h-1 ${STATUS_BG[status]}`} />

      <div className="flex justify-between items-start mb-4">
        <div className="flex flex-col gap-1">
          <div className="bg-[#f8f9fa] border border-gray-100 px-2 py-0.5 rounded text-[10px] font-mono font-bold text-gray-600 flex items-center gap-1.5 uppercase tracking-wide">
            <span className={`w-1.5 h-1.5 rounded-full ${STATUS_BG[status]}`} />
            {status}
          </div>
          {finishProjection && timeStats.velocityConfidence !== 'none' && (
            <p className="font-mono text-[9px] text-gray-400">
              pace → <span className="font-bold text-gray-600">{formatProjectedDate(finishProjection)}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-all">
          {isArchived && (
            <button
              onClick={handleDelete}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-300 transition-colors hover:bg-red-50 hover:text-red-400"
              title="Delete goal permanently"
              aria-label={`Delete goal ${goal.title} permanently`}
            >
              <Trash2 size={13} />
            </button>
          )}
          <button
            onClick={handleArchiveToggle}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-300 transition-colors hover:bg-indigo-50 hover:text-[#4648d4]"
            title={isArchived ? 'Restore goal' : 'Archive goal'}
            aria-label={isArchived ? `Restore goal ${goal.title}` : `Archive goal ${goal.title}`}
          >
            {isArchived ? <RotateCcw size={13} /> : <Archive size={13} />}
          </button>
        </div>
      </div>

      <h3 className="font-headline text-base font-bold text-gray-900 group-hover:text-[#4648d4] transition-colors mb-1 leading-snug">
        {goal.title}
      </h3>
      <p className="font-mono text-[10px] text-gray-400 mb-3 flex items-center gap-1">
        <Calendar size={11} className="text-gray-400" />
        <span className="uppercase tracking-wider">{finishEstimate.caption}</span>
        <span title={finishEstimate.title}>{finishEstimate.label}</span>
        {goal.overdue && (
          <span className="text-[#EF4444] font-bold ml-1 uppercase text-[9px]">(Overdue)</span>
        )}
      </p>

      {closestDue && <DueWarning due={closestDue} />}

      <div className="flex items-center justify-between mt-auto mb-6">
        <ProgressRing progress={metrics.progress} activityLevel={metrics.activityLevel} status={status} />
        <div className="text-right pl-4">
          <p className="font-mono text-[9px] text-gray-400 uppercase tracking-widest mb-1.5 font-bold">Activity Level</p>
          <div className="flex gap-1 justify-end items-end h-4">
            {[1, 2, 3, 4, 5].map((lvl) => (
              <div
                key={lvl}
                className={`w-1 rounded-full transition-all ${
                  lvl <= metrics.activityLevel
                    ? status === 'Safe' ? 'bg-[#4648d4] h-4' : status === 'Watch' ? 'bg-[#F59E0B] h-3.5' : 'bg-[#EF4444] h-3'
                    : 'bg-gray-200 h-1.5'
                }`}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-gray-100 pt-4" onClick={(e) => e.stopPropagation()}>
        <p className="font-mono text-[9px] text-gray-400 uppercase tracking-widest mb-2 font-bold">Next Action</p>
        {nextAction ? (
          <button
            type="button"
            onClick={handleToggleNextAction}
            className="flex w-full items-start gap-2.5 rounded-lg bg-[#f8f9fa] p-2 text-left transition-colors hover:bg-gray-100"
            aria-pressed={nextAction.completed}
            aria-label={`${nextAction.completed ? 'Mark incomplete' : 'Mark complete'}: ${nextAction.title}`}
          >
            <span className="shrink-0 mt-0.5 text-gray-400 transition-colors">
              {nextAction.completed
                ? <CheckSquare size={14} className="text-[#4648d4]" />
                : <Square size={14} />}
            </span>
            <p className={`text-xs text-gray-700 leading-normal ${nextAction.completed ? 'line-through text-gray-400' : ''}`}>
              {nextAction.title}
            </p>
          </button>
        ) : (
          <p className="text-xs text-gray-400 italic">No next action set.</p>
        )}
      </div>

      {tab === 'Active' && (
        <div className="border-t border-gray-100 pt-3 mt-3" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={(e) => { e.stopPropagation(); setSelectedGoalId(goal.id); }}
            className="flex items-center gap-1.5 text-[11px] font-mono text-gray-400 hover:text-[#4648d4] transition-colors group/ms"
            aria-label={`Add milestone to ${goal.title}`}
          >
            <span className="w-5 h-5 rounded-md bg-gray-100 group-hover/ms:bg-[#EEF2FF] flex items-center justify-center transition-colors">
              <Milestone size={11} className="group-hover/ms:text-[#4648d4]" />
            </span>
            Add milestone
          </button>
        </div>
      )}
    </motion.div>
  );
}

// ─── Goals Dashboard ──────────────────────────────────────────────────────────
export function GoalsDashboard() {
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const { goalsFilter, setGoalsFilter, searchQuery, setSearchQuery, openNewGoalModal } = useAppStore();

  // useGoals() returns ACTIVE goals only (server-side filter). The Archived
  // tab needs the full set — without useAllGoals it was permanently empty.
  const { data: activeGoals = [] } = useGoals();
  const { data: allGoals = [] } = useAllGoals();
  const goals = goalsFilter === 'Archived' ? allGoals : activeGoals;
  const { data: allTasks = [] } = useAllTasks();

  const nextActions = allTasks.filter(t => t.kind === 'next_action');

  const nextActionMap = new Map(nextActions.map(t => [t.goal_id!, t]));
  const tasksByGoal = allTasks.reduce<Record<string, DBTask[]>>((acc, task) => {
    if (!task.goal_id) return acc;
    acc[task.goal_id] = [...(acc[task.goal_id] ?? []), task];
    return acc;
  }, {});

  const visibleGoals = goals.filter((g) => !g.archived_at);
  const archivedGoals = allGoals.filter((g) => Boolean(g.archived_at));

  const filtered = goals.filter((g) => {
    const q = searchQuery.toLowerCase();
    const matchesSearch = !q || g.title.toLowerCase().includes(q) || g.category.toLowerCase().includes(q);
    const isArchived = Boolean(g.archived_at);
    const metrics = calculateGoalTaskMetrics(tasksByGoal[g.id] ?? []);
    const matchesFilter =
      goalsFilter === 'Archived'
        ? isArchived
        : !isArchived && (goalsFilter === 'Active' ? metrics.progress < 100 : metrics.progress === 100);
    return matchesSearch && matchesFilter;
  });

  const total    = visibleGoals.length;
  const onTrack  = visibleGoals.filter((g) => computeGoalStatus(g, tasksByGoal[g.id] ?? []) === 'Safe').length;
  const needsAttn= visibleGoals.filter((g) => computeGoalStatus(g, tasksByGoal[g.id] ?? []) === 'Watch').length;
  const atRisk   = visibleGoals.filter((g) => computeGoalStatus(g, tasksByGoal[g.id] ?? []) === 'Risky').length;

  return (
    <div className="max-w-[1480px] mx-auto px-4 md:px-10 py-6 animate-fade-in">
      {isMobile ? <div className="mb-4 flex items-center justify-between gap-3">
        <select aria-label="Goal status" value={goalsFilter} onChange={event => setGoalsFilter(event.target.value as typeof goalsFilter)} className="min-h-11 rounded-xl bg-slate-50 px-3 text-sm font-semibold text-slate-700">
          <option value="Active">Active goals</option><option value="Completed">Completed goals</option><option value="Archived">Archived goals</option>
        </select>
        <button onClick={() => openNewGoalModal()} aria-label="Create new goal" className="flex min-h-11 items-center gap-1 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white"><Plus size={18} />New</button>
      </div> : <div className="mobile-goals-header flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
        <div>
          <h2 className="font-headline text-2xl font-bold text-black mb-1">Goals</h2>
          <p className="text-sm text-gray-500 max-w-xl">
            Your projects and next steps.
          </p>
        </div>
        <div className="mobile-goal-filters flex items-center gap-3">
          <div className="flex items-center gap-1.5 bg-[#f3f4f5] rounded-full p-1 border border-gray-200">
            {(['Active', 'Completed', 'Archived'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setGoalsFilter(f)}
                aria-pressed={goalsFilter === f}
                className={`px-3 py-1 font-mono text-xs uppercase tracking-wider rounded-full transition-all ${
                  goalsFilter === f ? 'bg-white text-black font-bold shadow-sm' : 'text-gray-400 hover:text-black'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            onClick={() => openNewGoalModal()}
            aria-label="Create new goal"
            className="mobile-goal-create bg-black text-white w-10 h-10 rounded-full flex items-center justify-center shadow-md hover:scale-[1.03] transition-all active:scale-[0.98]"
          >
            <Plus size={18} /><span className="md:hidden">New</span>
          </button>
        </div>
      </div>}

      <p className="mb-4 text-xs text-slate-500 md:hidden">{goalsFilter === 'Archived' ? `${archivedGoals.length} archived goals` : `${total} goals · ${needsAttn + atRisk} need attention`}</p>
      <div className="mobile-goal-stats hidden grid-cols-2 md:grid md:grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Total Goals',     value: total,     color: 'text-black' },
          { label: 'On Track',        value: onTrack,   color: STATUS_TEXT.Safe },
          { label: 'Needs Attention', value: needsAttn, color: STATUS_TEXT.Watch },
          { label: goalsFilter === 'Archived' ? 'Archived' : 'At Risk', value: goalsFilter === 'Archived' ? archivedGoals.length : atRisk, color: goalsFilter === 'Archived' ? 'text-gray-500' : STATUS_TEXT.Risky },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-[#f8f9fa] rounded-xl p-4 border border-gray-200 shadow-card">
            <p className="font-mono text-[9px] text-gray-400 uppercase tracking-widest mb-1.5 font-bold">{label}</p>
            <p className={`font-headline text-2xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      <label className="mb-4 block md:hidden"><span className="sr-only">Find a goal</span><input type="search" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Find a goal…" className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800" /></label>
      {filtered.length === 0 ? (
        <div className="text-center py-16 bg-[#f8f9fa] rounded-xl border border-dashed border-gray-200">
          <Target size={36} className="text-gray-300 mx-auto mb-3 animate-pulse" />
          <p className="text-gray-800 font-semibold mb-1">No goals match selection filter</p>
          <p className="text-xs text-gray-400 max-w-xs mx-auto mb-4">
            Try a different filter or create a goal.
          </p>
          <button onClick={() => openNewGoalModal()} className="bg-black text-white text-xs font-mono py-2 px-4 rounded-xl font-bold shadow-sm" aria-label="Create new goal">
            Create a goal
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 md:gap-6">
          {filtered.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              tasks={tasksByGoal[g.id] ?? []}
              nextAction={nextActionMap.get(g.id)}
              finishEstimate={getGoalFinishEstimate(g, tasksByGoal[g.id] ?? [])}
              metrics={calculateGoalTaskMetrics(tasksByGoal[g.id] ?? [])}
              closestDue={getClosestDueTask(tasksByGoal[g.id] ?? [])}
              tab={goalsFilter}
            />
          ))}
        </div>
      )}

      {!isMobile && <DatabaseAtlas />}
    </div>
  );
}
