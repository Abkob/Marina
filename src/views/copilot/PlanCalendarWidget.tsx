import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Clock3, RefreshCw, Trash2, Users, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { apiPatch, apiPost } from '../../utils/apiFetch';
import {
  addDays, clampHour, fmtHourLabel, fmtTimeRange, mondayOf, packOverlaps,
  parseLocalDate, snapHour, type TimedBlock,
} from '../../utils/calendar';
import { planDayLoads, planFeedbackLine } from '../../utils/planFeedback';

/**
 * The interactive calendar a "plan" chat turn renders instead of prose:
 * meetings and existing blocks are fixed context, proposed blocks are dashed
 * and draggable (30-min snap, across days). Apply commits every block as a
 * real linked calendar event; Discard drops the plan. Drag positions and the
 * final status persist on the chat message, so reloads restore the widget.
 */

export interface ChatPlanBlock {
  /** absent on routine-series blocks that aren't tied to a task */
  task_id?: string;
  title: string;
  date: string;
  start_hour: number;
  duration_hours: number;
  planned_minutes?: number;
  /** Real task deadline. A block may be scheduled before this date. */
  due_date?: string | null;
  planning_role?: 'overdue' | 'due_on_block_day' | 'due_in_window' | 'before_deadline' | 'no_deadline';
}

export interface ChatPlan {
  /** 'series' = declared routine occurrences, no scheduler run */
  kind?: 'plan' | 'series';
  from: string;
  to: string;
  work_start: number;
  work_end: number;
  days: Array<{ date: string; available_minutes: number }>;
  busy: Array<{ date: string; start_hour: number; duration_hours: number; title: string; kind: 'meeting' | 'block' }>;
  blocks: ChatPlanBlock[];
  unplaced: Array<{ task_id: string; title: string; minutes: number }>;
  /** unestimated-but-otherwise-ready tasks with a history-based guess each */
  needs_estimate?: Array<{ task_id: string; title: string; suggested_minutes: number; basis: string; needs_date?: boolean }>;
  scheduler: { status: string; gap_minutes: number; unestimated_count: number; overflow_count: number };
  status?: 'pending' | 'applied' | 'discarded';
  adjustments?: Record<string, { date: string; start_hour: number; removed?: boolean }>;
  /** Optional source dates whose existing linked task blocks should be removed when this plan is applied. */
  clear_task_dates?: string[];
}

/** A plan block plus the widget's local user state. */
type LiveBlock = ChatPlanBlock & { removed?: boolean };

const HOUR_PX = 34;

function fmtMins(mins: number): string {
  const rounded = Math.round(mins);
  const abs = Math.abs(rounded);
  if (abs === 0) return '0h';
  if (abs < 60) return `${rounded}m`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${rounded < 0 ? '-' : ''}${h}h${m ? ` ${m}m` : ''}`;
}

function fmtShortDate(date: string): string {
  return parseLocalDate(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function SingleDayPlanAgenda({ plan, blocks, status, busy, onApply, onDiscard, onMove, onRemove, onRestore }: {
  plan: ChatPlan;
  blocks: LiveBlock[];
  status: 'pending' | 'applied' | 'discarded';
  busy: boolean;
  onApply: () => void;
  onDiscard: () => void;
  onMove: (index: number, date: string, startHour: number) => void;
  onRemove: (index: number) => void;
  onRestore: () => void;
}) {
  const active = blocks.map((block, index) => ({ ...block, index })).filter(block => !block.removed).sort((a, b) => a.start_hour - b.start_hour);
  const removed = blocks.length - active.length;
  const total = active.reduce((sum, block) => sum + (block.planned_minutes ?? Math.round(block.duration_hours * 60)), 0);
  const interactive = status === 'pending';
  return (
    <div className="mt-2 overflow-hidden rounded-2xl border border-indigo-400/20 bg-white text-left shadow-sm">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-indigo-500/[0.07] px-4 py-3.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-700"><Clock3 size={16} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-slate-900">{parseLocalDate(plan.from).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p>
          <p className="mt-0.5 text-[11px] text-slate-500">{active.length} block{active.length !== 1 ? 's' : ''} · {fmtMins(total)} planned</p>
        </div>
        <span className={`rounded-full border px-2 py-1 font-mono text-[9px] font-bold uppercase ${plan.scheduler.status === 'feasible' ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-700' : 'border-amber-400/20 bg-amber-500/10 text-amber-700'}`}>{plan.scheduler.status}</span>
      </div>
      <div className="space-y-2 p-3">
        {active.map(block => (
          <div key={`${block.index}-${block.task_id ?? block.title}`} className="copilot-plan-block flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="w-24 shrink-0">
              <p className="font-mono text-[11px] font-bold text-indigo-700">{fmtTimeRange(block.start_hour, block.duration_hours)}</p>
              <p className="mt-0.5 font-mono text-[9px] text-slate-500">{fmtMins(block.planned_minutes ?? Math.round(block.duration_hours * 60))}</p>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-slate-900">{block.title}</p>
              {block.due_date && <p className="mt-0.5 text-[10px] text-slate-500">Due {fmtShortDate(block.due_date)}</p>}
            </div>
            {interactive && <div className="flex items-center gap-1">
              <button onClick={() => onMove(block.index, block.date, snapHour(Math.max(0, block.start_hour - 0.5)))} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] text-slate-500 hover:text-slate-900">−30m</button>
              <button onClick={() => onMove(block.index, block.date, snapHour(Math.min(23.5, block.start_hour + 0.5)))} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] text-slate-500 hover:text-slate-900">+30m</button>
              <button onClick={() => onRemove(block.index)} aria-label={`Remove ${block.title} from plan`} className="rounded-lg p-1.5 text-slate-500 hover:bg-red-500/10 hover:text-red-700"><X size={13} /></button>
            </div>}
          </div>
        ))}
        {!active.length && <div className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-xs text-slate-500">No work fits in this window.</div>}
        {plan.unplaced.length > 0 && <div className="rounded-xl border border-amber-400/15 bg-amber-500/[0.06] p-3">
          <p className="text-[11px] font-semibold text-amber-700">Still unplaced</p>
          {plan.unplaced.slice(0, 5).map(item => <div key={item.task_id} className="mt-1.5 flex gap-2 text-[11px] text-slate-500"><span className="min-w-0 flex-1 truncate">{item.title}</span><span className="font-mono">{fmtMins(item.minutes)}</span></div>)}
        </div>}
      </div>
      <div className="flex items-center gap-2 border-t border-slate-200 px-4 py-3">
        {interactive ? <>
          <button onClick={onApply} disabled={busy || !active.length} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-[11px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-40"><Check size={13} /> Apply {active.length} block{active.length !== 1 ? 's' : ''}</button>
          <button onClick={onDiscard} disabled={busy} className="rounded-lg px-3 py-2 text-[11px] font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-900">Discard</button>
          {removed > 0 && <button onClick={onRestore} className="ml-auto text-[10px] text-indigo-700">Restore {removed}</button>}
        </> : <p className="text-[11px] text-slate-500">{status === 'applied' ? 'Added to your schedule' : 'Proposal discarded'}</p>}
      </div>
    </div>
  );
}

export function PlanCalendarWidget({ plan: initialPlan, sessionId, messageId }: {
  plan: ChatPlan;
  sessionId: string | null;
  messageId?: string;
}) {
  const { triggerToast } = useAppStore();

  // The plan can be rebuilt in place (estimate triage → refresh), so it lives
  // in state; the prop is only the starting point.
  const [plan, setPlan] = useState<ChatPlan>(initialPlan);
  // Proposed blocks with the user's drag/remove adjustments folded in.
  // The array stays 1:1 with plan.blocks (adjustments are index-keyed);
  // removed blocks are flagged, never spliced.
  const [blocks, setBlocks] = useState<LiveBlock[]>(() =>
    initialPlan.blocks.map((b, i) => {
      const adj = initialPlan.adjustments?.[String(i)];
      return adj ? { ...b, date: adj.date, start_hour: adj.start_hour, removed: adj.removed } : b;
    }),
  );
  const [status, setStatus] = useState<'pending' | 'applied' | 'discarded'>(initialPlan.status ?? 'pending');
  const [busyState, setBusyState] = useState(false);
  const adjustments = useRef<Record<string, { date: string; start_hour: number; removed?: boolean }>>({ ...(initialPlan.adjustments ?? {}) });
  const isSeries = plan.kind === 'series';
  const activeBlocks = useMemo(() => blocks.filter(b => !b.removed), [blocks]);
  const removedCount = blocks.length - activeBlocks.length;

  // Estimate triage: one tap per unestimated task, then rebuild the plan
  const [triage, setTriage] = useState<Record<string, 'pending' | 'set' | 'skipped'>>({});
  const [refreshing, setRefreshing] = useState(false);
  const triageSetCount = Object.values(triage).filter(v => v === 'set').length;

  const setEstimate = async (item: NonNullable<ChatPlan['needs_estimate']>[number], minutes: number) => {
    try {
      await apiPatch(`/api/tasks/${item.task_id}`, {
        estimated_minutes: minutes,
        estimated_duration: fmtMins(minutes),
        // Including a dateless task in this plan gives it the window's end as
        // its target — that's what "plan it this week" means.
        ...(item.needs_date ? { target_date: plan.to } : {}),
      });
      setTriage(t => ({ ...t, [item.task_id]: 'set' }));
    } catch (e) {
      triggerToast((e as Error).message || 'Could not save the estimate.', 'error');
    }
  };

  /** Server rebuilds the plan for the same window (now including the newly
   *  estimated tasks) and stores it on the message — no model round-trip. */
  const refreshPlan = async () => {
    if (!sessionId || !messageId) return;
    setRefreshing(true);
    try {
      const r = await apiPatch<{ ok: boolean; plan?: ChatPlan }>(
        `/api/ai/sessions/${sessionId}/messages/${messageId}/plan`,
        { refresh_window: { from_date: plan.from, to_date: plan.to, start_hour: plan.work_start, end_hour: plan.work_end } },
      );
      if (r.plan) {
        setPlan(r.plan);
        setBlocks(r.plan.blocks);
        adjustments.current = {};
        setTriage({});
      }
    } catch (e) {
      triggerToast((e as Error).message || 'Could not update the plan.', 'error');
    } finally {
      setRefreshing(false);
    }
  };

  // Weeks covered by the horizon (Monday-based), pager between them
  const weekStarts = useMemo(() => {
    const out: string[] = [];
    let w = mondayOf(plan.from);
    while (w <= plan.to) {
      out.push(w);
      w = addDays(w, 7);
    }
    return out;
  }, [plan.from, plan.to]);
  const [weekIdx, setWeekIdx] = useState(0);
  const weekStart = weekStarts[weekIdx] ?? mondayOf(plan.from);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  // Vertical range: work window stretched to cover everything placed
  const [startHourGrid, endHourGrid] = useMemo(() => {
    let lo = plan.work_start;
    let hi = plan.work_end;
    for (const b of [...blocks, ...plan.busy]) {
      lo = Math.min(lo, b.start_hour);
      hi = Math.max(hi, b.start_hour + b.duration_hours);
    }
    return [Math.max(0, Math.floor(lo)), Math.min(24, Math.ceil(hi))];
  }, [blocks, plan.busy, plan.work_start, plan.work_end]);
  const gridHeight = (endHourGrid - startHourGrid) * HOUR_PX;
  const hourToY = (h: number) => (h - startHourGrid) * HOUR_PX;

  const interactive = status === 'pending';

  const persist = (patch: { status?: 'pending' | 'applied' | 'discarded'; adjustments?: Record<string, { date: string; start_hour: number; removed?: boolean }> }) => {
    if (!sessionId || !messageId) return; // nothing durable to patch yet
    apiPatch(`/api/ai/sessions/${sessionId}/messages/${messageId}/plan`, patch).catch(() => {});
  };

  const moveBlock = (index: number, date: string, start_hour: number) => {
    setBlocks(prev => prev.map((b, i) => (i === index ? { ...b, date, start_hour } : b)));
    adjustments.current[String(index)] = { date, start_hour };
    persist({ adjustments: { [String(index)]: { date, start_hour } } });
  };

  const removeBlock = (index: number) => {
    const b = blocks[index];
    if (!b) return;
    setBlocks(prev => prev.map((x, i) => (i === index ? { ...x, removed: true } : x)));
    const adj = { date: b.date, start_hour: b.start_hour, removed: true };
    adjustments.current[String(index)] = adj;
    persist({ adjustments: { [String(index)]: adj } });
  };

  const restoreRemoved = () => {
    const patch: Record<string, { date: string; start_hour: number; removed?: boolean }> = {};
    blocks.forEach((b, i) => {
      if (b.removed) {
        patch[String(i)] = { date: b.date, start_hour: b.start_hour, removed: false };
        adjustments.current[String(i)] = patch[String(i)];
      }
    });
    setBlocks(prev => prev.map(b => (b.removed ? { ...b, removed: false } : b)));
    persist({ adjustments: patch });
  };

  const apply = async () => {
    setBusyState(true);
    try {
      const applyBlocks = activeBlocks.map(({ task_id, title, date, start_hour, duration_hours, planned_minutes }) => ({
        ...(task_id ? { task_id } : {}),
        title,
        date,
        start_hour,
        duration_hours,
        ...(planned_minutes ? { planned_minutes } : {}),
      }));
      await apiPost('/api/ai/schedule/plan/apply', {
        blocks: applyBlocks,
        ...(plan.clear_task_dates?.length ? { clear_task_dates: plan.clear_task_dates } : {}),
      });
      setStatus('applied');
      persist({ status: 'applied' });
      triggerToast(`Plan applied — ${activeBlocks.length} block${activeBlocks.length !== 1 ? 's' : ''} on your calendar.`, 'success');
    } catch (e) {
      triggerToast((e as Error).message || 'Could not apply the plan.', 'error');
    } finally {
      setBusyState(false);
    }
  };

  const discard = () => {
    setStatus('discarded');
    persist({ status: 'discarded' });
  };

  // Live feedback on the current arrangement
  const feedback = useMemo(
    () => planFeedbackLine(planDayLoads(
      activeBlocks.map(b => ({ date: b.date, planned_minutes: b.planned_minutes ?? Math.round(b.duration_hours * 60) })),
      plan.days,
    )),
    [activeBlocks, plan.days],
  );

  const schedTone =
    plan.scheduler.status === 'feasible' ? 'text-emerald-600' :
    plan.scheduler.status === 'impossible' ? 'text-red-600' : 'text-amber-600';

  const horizonLabel = `${parseLocalDate(plan.from).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${parseLocalDate(plan.to).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  if (plan.from === plan.to && !isSeries) {
    return <SingleDayPlanAgenda plan={plan} blocks={blocks} status={status} busy={busyState} onApply={apply} onDiscard={discard} onMove={moveBlock} onRemove={removeBlock} onRestore={restoreRemoved} />;
  }

  return (
    <div className={`mt-2 overflow-hidden rounded-xl border bg-white text-left ${status === 'discarded' ? 'border-gray-200 opacity-60' : 'border-[#4648d4]/25'}`}>
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3 py-2">
        <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-[#4648d4]">
          {isSeries ? 'Routine' : 'Plan'} · {horizonLabel}
        </span>
        {isSeries ? (
          <span className="font-mono text-[9px] font-bold uppercase text-gray-500">×{activeBlocks.length} sessions</span>
        ) : (
          <span className={`font-mono text-[9px] font-bold uppercase ${schedTone}`}>
            {plan.scheduler.status}
            {plan.scheduler.gap_minutes !== 0 && ` · ${plan.scheduler.gap_minutes > 0 ? '+' : ''}${fmtMins(plan.scheduler.gap_minutes)}`}
          </span>
        )}
        {status !== 'pending' && (
          <span className={`rounded-full px-2 py-0.5 font-mono text-[8px] font-bold uppercase ${status === 'applied' ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
            {status}
          </span>
        )}
        {weekStarts.length > 1 && (
          <span className="ml-auto flex items-center gap-1">
            <button onClick={() => setWeekIdx(i => Math.max(0, i - 1))} disabled={weekIdx === 0} className="rounded p-0.5 text-gray-400 hover:bg-gray-100 disabled:opacity-30">
              <ChevronLeft size={12} />
            </button>
            <span className="font-mono text-[9px] text-gray-500">week {weekIdx + 1}/{weekStarts.length}</span>
            <button onClick={() => setWeekIdx(i => Math.min(weekStarts.length - 1, i + 1))} disabled={weekIdx === weekStarts.length - 1} className="rounded p-0.5 text-gray-400 hover:bg-gray-100 disabled:opacity-30">
              <ChevronRight size={12} />
            </button>
          </span>
        )}
      </div>

      {/* Estimate triage — one tap per unestimated task, then rebuild */}
      {interactive && !isSeries && (plan.needs_estimate?.length ?? 0) > 0 && (
        <div className="space-y-1 border-b border-amber-100 bg-amber-50/60 px-3 py-2">
          <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-amber-700">
            {plan.needs_estimate!.length} task{plan.needs_estimate!.length !== 1 ? 's' : ''} missing an estimate — tap one to include it
          </p>
          {plan.needs_estimate!.map(t => {
            const state = triage[t.task_id] ?? 'pending';
            const chips = [...new Set([15, 30, 60, 120, 240, t.suggested_minutes])].sort((a, b) => a - b);
            return (
              <div key={t.task_id} className="flex flex-wrap items-center gap-1">
                <span
                  className={`min-w-0 flex-1 truncate text-[10px] font-medium ${state === 'pending' ? 'text-gray-700' : 'text-gray-400'}`}
                  title={`Suggested ${fmtMins(t.suggested_minutes)} — ${t.basis}`}
                >
                  {state === 'set' ? '✓ ' : state === 'skipped' ? '– ' : ''}{t.title}
                </span>
                {state === 'pending' && (
                  <>
                    {chips.map(m => (
                      <button
                        key={m}
                        onClick={() => setEstimate(t, m)}
                        className={`rounded border px-1.5 py-0.5 font-mono text-[8px] font-bold transition-colors ${
                          m === t.suggested_minutes
                            ? 'border-[#4648d4] bg-[#EEF2FF] text-[#4648d4]'
                            : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                        }`}
                        title={m === t.suggested_minutes ? `Suggested: ${t.basis}` : undefined}
                      >
                        {fmtMins(m)}
                      </button>
                    ))}
                    <button
                      onClick={() => setTriage(s => ({ ...s, [t.task_id]: 'skipped' }))}
                      className="rounded px-1 py-0.5 font-mono text-[8px] text-gray-400 hover:text-gray-600"
                    >
                      skip
                    </button>
                  </>
                )}
              </div>
            );
          })}
          {triageSetCount > 0 && (
            <button
              onClick={refreshPlan}
              disabled={refreshing || !messageId}
              className="mt-0.5 flex items-center gap-1 rounded bg-[#4648d4] px-2 py-1 font-mono text-[8px] font-bold uppercase text-white hover:opacity-90 disabled:opacity-40"
            >
              <RefreshCw size={9} className={refreshing ? 'animate-spin' : ''} /> Update plan with new estimates
            </button>
          )}
        </div>
      )}

      {/* Day headers */}
      <div className="grid grid-cols-[42px_repeat(7,minmax(0,1fr))] border-b border-gray-100">
        <div />
        {days.map(d => {
          const dt = parseLocalDate(d);
          const inHorizon = d >= plan.from && d <= plan.to;
          return (
            <div key={d} className={`border-l border-gray-50 py-1 text-center ${inHorizon ? '' : 'opacity-30'}`}>
              <span className="font-mono text-[9px] font-bold uppercase text-gray-400">{dt.toLocaleDateString('en-US', { weekday: 'short' })}</span>
              <span className="ml-1 font-headline text-xs font-bold text-gray-700">{dt.getDate()}</span>
            </div>
          );
        })}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-[42px_repeat(7,minmax(0,1fr))]">
        <div className="relative" style={{ height: gridHeight }}>
          {Array.from({ length: endHourGrid - startHourGrid - 1 }, (_, i) => (
            <span key={i} className="absolute right-1.5 -translate-y-1/2 font-mono text-[9px] text-gray-400" style={{ top: (i + 1) * HOUR_PX }}>
              {fmtHourLabel(startHourGrid + i + 1)}
            </span>
          ))}
        </div>
        {days.map((d, dayIdx) => (
          <PlanDayColumn
            key={d}
            date={d}
            dayIdx={dayIdx}
            days={days}
            inHorizon={d >= plan.from && d <= plan.to}
            busy={plan.busy.filter(b => b.date === d)}
            blocks={blocks}
            startHourGrid={startHourGrid}
            endHourGrid={endHourGrid}
            hourToY={hourToY}
            gridHeight={gridHeight}
            interactive={interactive}
            onMove={moveBlock}
            onRemove={removeBlock}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="space-y-1.5 border-t border-gray-100 px-3 py-2">
        {feedback && <p className="text-[10px] font-medium text-amber-600">⚠ {feedback}</p>}
        {plan.unplaced.length > 0 && (
          <p className="text-[10px] text-gray-400" title={plan.unplaced.map(u => `${u.title} (${fmtMins(u.minutes)})`).join('\n')}>
            {plan.unplaced.length} task{plan.unplaced.length !== 1 ? 's' : ''} didn't fit in these work hours.
          </p>
        )}
        {plan.scheduler.unestimated_count > 0 && !(plan.needs_estimate?.length) && (
          <p className="text-[10px] text-gray-400">{plan.scheduler.unestimated_count} task{plan.scheduler.unestimated_count !== 1 ? 's' : ''} left out — no time estimate yet.</p>
        )}
        {removedCount > 0 && interactive && (
          <p className="text-[10px] text-gray-400">
            {removedCount} block{removedCount !== 1 ? 's' : ''} removed from this plan ·{' '}
            <button onClick={restoreRemoved} className="font-bold text-[#4648d4] hover:underline">restore</button>
          </p>
        )}
        {interactive ? (
          <div className="flex items-center gap-2 pt-0.5">
            <button
              onClick={apply}
              disabled={busyState || activeBlocks.length === 0}
              className="flex items-center gap-1.5 rounded-lg bg-[#4648d4] px-3 py-1.5 font-mono text-[9px] font-bold uppercase text-white hover:opacity-90 disabled:opacity-40"
            >
              <Check size={11} /> {isSeries ? `Apply all ${activeBlocks.length}` : 'Apply plan'}
            </button>
            <button
              onClick={discard}
              disabled={busyState}
              className="flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-1.5 font-mono text-[9px] font-bold uppercase text-gray-500 hover:bg-gray-200 disabled:opacity-40"
            >
              <Trash2 size={11} /> Discard
            </button>
            <span className="font-mono text-[8px] uppercase tracking-wider text-gray-300">drag to move · Esc cancels · ✕ removes</span>
          </div>
        ) : (
          <p className="font-mono text-[9px] uppercase tracking-wider text-gray-400">
            {status === 'applied' ? 'These blocks are on your Schedule.' : 'Plan discarded — ask for a new one anytime.'}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Day column ────────────────────────────────────────────────────────────────

function PlanDayColumn({ date, dayIdx, days, inHorizon, busy, blocks, startHourGrid, endHourGrid, hourToY, gridHeight, interactive, onMove, onRemove }: {
  date: string;
  dayIdx: number;
  days: string[];
  inHorizon: boolean;
  busy: ChatPlan['busy'];
  blocks: LiveBlock[];
  startHourGrid: number;
  endHourGrid: number;
  hourToY: (h: number) => number;
  gridHeight: number;
  interactive: boolean;
  onMove: (index: number, date: string, start_hour: number) => void;
  onRemove: (index: number) => void;
}) {
  const dayBlocks = blocks
    .map((b, index) => ({ ...b, index }))
    .filter(b => b.date === date && !b.removed);

  const packed = useMemo(() => {
    const timed: TimedBlock[] = [
      ...busy.map((b, i) => ({ id: `busy:${i}`, start: b.start_hour, end: b.start_hour + b.duration_hours })),
      ...dayBlocks.map(b => ({ id: `plan:${b.index}`, start: b.start_hour, end: b.start_hour + b.duration_hours })),
    ];
    return packOverlaps(timed);
  }, [busy, dayBlocks]);

  return (
    <div className={`relative border-l border-gray-50 ${inHorizon ? '' : 'bg-gray-50/60'}`} style={{ height: gridHeight }}>
      {Array.from({ length: endHourGrid - startHourGrid - 1 }, (_, i) => (
        <div key={i} className="pointer-events-none absolute inset-x-0 border-t border-gray-50" style={{ top: (i + 1) * HOUR_PX }} />
      ))}

      {busy.map((b, i) => {
        const pos = packed.get(`busy:${i}`) ?? { col: 0, cols: 1 };
        const top = hourToY(clampHour(b.start_hour, startHourGrid, endHourGrid));
        const height = Math.max(10, Math.min(b.duration_hours * HOUR_PX, gridHeight - top) - 1);
        return (
          <div
            key={`busy-${i}`}
            className={`absolute overflow-hidden rounded px-1 ${b.kind === 'meeting' ? 'bg-purple-100 text-purple-700' : 'bg-gray-200/80 text-gray-600'}`}
            style={{ top, height, left: `calc(${(pos.col / pos.cols) * 100}% + 1px)`, width: `calc(${100 / pos.cols}% - 2px)` }}
            title={`${b.title} — already on your calendar (${fmtTimeRange(b.start_hour, b.duration_hours)})`}
          >
            <p className="truncate text-[9px] font-semibold leading-tight">
              {b.kind === 'meeting' && <Users size={8} className="mr-0.5 inline -mt-px" />}
              {b.title}
            </p>
          </div>
        );
      })}

      {dayBlocks.map(b => (
        <ProposedBlock
          key={b.index}
          block={b}
          pos={packed.get(`plan:${b.index}`) ?? { col: 0, cols: 1 }}
          dayIdx={dayIdx}
          days={days}
          startHourGrid={startHourGrid}
          endHourGrid={endHourGrid}
          hourToY={hourToY}
          gridHeight={gridHeight}
          interactive={interactive}
          onMove={onMove}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

// ── Draggable proposed block ──────────────────────────────────────────────────

function ProposedBlock({ block, pos, dayIdx, days, startHourGrid, endHourGrid, hourToY, gridHeight, interactive, onMove, onRemove }: {
  block: LiveBlock & { index: number };
  pos: { col: number; cols: number };
  dayIdx: number;
  days: string[];
  startHourGrid: number;
  endHourGrid: number;
  hourToY: (h: number) => number;
  gridHeight: number;
  interactive: boolean;
  onMove: (index: number, date: string, start_hour: number) => void;
  onRemove: (index: number) => void;
}) {
  const [drag, setDrag] = useState<{ dy: number; dDay: number; colW: number } | null>(null);
  const gesture = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
  const cancelled = useRef(false);

  const previewStart = drag
    ? clampHour(snapHour(block.start_hour + drag.dy / HOUR_PX, 30), startHourGrid, endHourGrid - block.duration_hours)
    : block.start_hour;
  const previewDay = drag ? Math.min(6, Math.max(0, dayIdx + drag.dDay)) : dayIdx;

  // Escape drops the block back where it was — no accidental moves.
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelled.current = true;
        gesture.current = null;
        setDrag(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive || e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    cancelled.current = false;
    gesture.current = { startX: e.clientX, startY: e.clientY, moved: false };
    const colW = (e.currentTarget as HTMLElement).parentElement?.offsetWidth ?? 100;
    setDrag({ dy: 0, dDay: 0, colW });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!gesture.current || !drag) return;
    const dx = e.clientX - gesture.current.startX;
    const dy = e.clientY - gesture.current.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) gesture.current.moved = true;
    setDrag(d => d && { ...d, dy, dDay: Math.round(dx / d.colW) });
  };
  const onPointerUp = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const moved = gesture.current?.moved;
    gesture.current = null;
    if (drag && moved) onMove(block.index, days[previewDay], previewStart);
    setDrag(null);
  };

  const top = hourToY(clampHour(previewStart, startHourGrid, endHourGrid));
  const height = Math.max(18, Math.min(block.duration_hours * HOUR_PX, gridHeight - top) - 1);
  const dragging = drag !== null && Boolean(gesture.current?.moved);
  const dueLabel = block.due_date
    ? block.planning_role === 'overdue'
      ? `overdue ${fmtShortDate(block.due_date)}`
      : block.planning_role === 'due_on_block_day'
        ? 'due this day'
        : `due ${fmtShortDate(block.due_date)}`
    : null;
  const tone =
    block.planning_role === 'overdue' || block.planning_role === 'due_on_block_day'
      ? 'border-red-400/70 bg-red-50/95 text-red-700'
      : block.planning_role === 'due_in_window'
        ? 'border-amber-400/70 bg-amber-50/95 text-amber-800'
        : 'border-[#4648d4]/60 bg-[#EEF2FF]/90 text-[#33359c]';

  const dropDayLabel = parseLocalDate(days[previewDay]).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={`group absolute rounded border border-dashed select-none touch-none ${tone}
        ${interactive ? 'cursor-grab active:cursor-grabbing' : ''}
        ${drag ? 'z-30 shadow-lg ring-2 ring-[#4648d4]/30' : 'z-10'}`}
      style={{
        top,
        height,
        left: `calc(${(pos.col / pos.cols) * 100}% + 1px)`,
        width: `calc(${100 / pos.cols}% - 2px)`,
        transform: drag && drag.dDay !== 0 ? `translateX(calc(${(previewDay - dayIdx) * 100}% * ${pos.cols}))` : undefined,
      }}
      title={`${block.title} - proposed ${fmtTimeRange(previewStart, block.duration_hours)}${dueLabel ? ` - ${dueLabel}` : ''}`}
    >
      {/* Landing tooltip: exactly where the block will drop */}
      {dragging && (
        <div className={`pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 font-mono text-[10px] font-bold text-white shadow-lg ${top < 34 ? '-bottom-8' : '-top-8'}`}>
          {dropDayLabel} · {fmtTimeRange(previewStart, block.duration_hours)}
        </div>
      )}
      <div className="h-full w-full overflow-hidden px-1 py-0.5">
        <p className="truncate text-[10px] font-bold leading-tight">{block.title}</p>
        {height > 26 && <p className="truncate font-mono text-[9px] opacity-70">{fmtTimeRange(previewStart, block.duration_hours)}</p>}
        {height > 44 && dueLabel && <p className="truncate font-mono text-[8px] font-bold uppercase opacity-75">{dueLabel}</p>}
      </div>
      {interactive && !drag && (
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onRemove(block.index); }}
          className="absolute right-0.5 top-0.5 z-20 hidden rounded bg-white/90 p-0.5 text-gray-400 shadow-sm hover:text-red-500 group-hover:block"
          title="Remove this block from the plan (restore from the footer)"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}
