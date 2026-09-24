import { useMemo } from 'react';
import { AlertTriangle, CalendarDays, Clock, Layers } from 'lucide-react';
import { fmtHourLabel, fmtTimeRange, packOverlaps, parseLocalDate, type TimedBlock } from '../../utils/calendar';

export interface ChatScheduleDayView {
  kind: 'day_schedule';
  date: string;
  work_start: number;
  work_end: number;
  capacity: {
    raw_capacity_minutes: number;
    reserved_buffer_minutes: number;
    effective_capacity_minutes: number;
    fixed_commitment_minutes: number;
    available_after_fixed_minutes: number;
  };
  scheduled_minutes: number;
  free_after_scheduled_minutes: number;
  due_leaf_minutes: number;
  over_capacity_minutes: number;
  timeline_blocks: Array<{
    id: string;
    title: string;
    type: 'meeting' | 'linked_task_block' | 'calendar_block' | 'unavailable';
    indicator: 'FIXED' | 'SCHEDULED' | 'UNLINKED';
    start_hour: number;
    end_hour: number;
    duration_minutes: number;
    time_label: string;
    linked_tasks?: Array<{
      task_id: string;
      title: string;
      origin_title: string | null;
      goal_title: string | null;
    }>;
  }>;
  day_level_tasks: Array<{
    id: string;
    title: string;
    origin_title: string;
    goal_title: string | null;
    remaining_minutes: number | null;
    indicator: 'DAY-LEVEL';
  }>;
  due_groups: Array<{
    origin_id: string;
    origin_title: string;
    goal_title: string | null;
    kind: 'parent_task' | 'single_task';
    total_minutes: number;
    unestimated_count: number;
    tasks: Array<{
      id: string;
      title: string;
      remaining_minutes: number | null;
      deadline: string;
      deadline_kind: string;
      relation: 'origin_task' | 'subtask';
    }>;
  }>;
}

const HOUR_PX = 46;

function fmtMins(mins: number): string {
  const rounded = Math.round(mins);
  const abs = Math.abs(rounded);
  if (abs === 0) return '0h';
  if (abs < 60) return `${rounded}m`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${rounded < 0 ? '-' : ''}${h}h${m ? ` ${m}m` : ''}`;
}

function dayTitle(date: string): string {
  return parseLocalDate(date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function blockTone(block: ChatScheduleDayView['timeline_blocks'][number]): string {
  if (block.type === 'meeting') return 'border-purple-400 bg-purple-500/18 text-purple-700';
  if (block.type === 'unavailable') return 'border-red-400 bg-red-500/15 text-red-700';
  if (block.indicator === 'UNLINKED') return 'border-amber-400 bg-amber-500/15 text-amber-700';
  return 'border-indigo-400 bg-indigo-500/18 text-indigo-700';
}

function blockLabel(block: ChatScheduleDayView['timeline_blocks'][number]): string {
  const linked = block.linked_tasks?.[0];
  if (!linked) return block.title;
  const origin = linked.origin_title && linked.origin_title !== linked.title ? ` - ${linked.origin_title}` : '';
  return `${linked.title}${origin}`;
}

export function DayScheduleWidget({ view }: { view: ChatScheduleDayView }) {
  const displayBlocks = useMemo(() =>
    view.timeline_blocks.map((block, index) => ({
      ...block,
      key: `${block.id}-${index}`,
      start: block.start_hour,
      end: Math.max(block.start_hour + 0.25, block.end_hour),
    })),
    [view.timeline_blocks],
  );

  const [startHour, endHour] = useMemo(() => {
    const first = displayBlocks.length ? Math.min(...displayBlocks.map(b => b.start)) : view.work_start;
    const last = displayBlocks.length ? Math.max(...displayBlocks.map(b => b.end)) : view.work_end;
    const start = Math.max(0, Math.floor(Math.min(view.work_start, first)));
    const end = Math.min(24, Math.ceil(Math.max(view.work_end, last, start + 4)));
    return [start, end];
  }, [displayBlocks, view.work_start, view.work_end]);

  const packed = useMemo(() => {
    const timed: TimedBlock[] = displayBlocks.map(block => ({ id: block.key, start: block.start, end: block.end }));
    return packOverlaps(timed);
  }, [displayBlocks]);

  const hours = Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i);
  const height = Math.max(240, (endHour - startHour) * HOUR_PX);
  const y = (hour: number) => (hour - startHour) * HOUR_PX;
  const placedOverbooked = view.free_after_scheduled_minutes < 0;
  const dueOverCapacity = view.over_capacity_minutes > 0;
  const topDueGroups = view.due_groups.slice(0, 5);
  const showTimelineGrid = displayBlocks.length >= 2 || view.scheduled_minutes >= 60;

  return (
    <div className="mt-2 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-700">
            <CalendarDays size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold text-slate-900">{dayTitle(view.date)}</p>
            <p className="text-[10px] font-mono uppercase tracking-wide text-slate-500">
              {fmtMins(view.capacity.raw_capacity_minutes)} raw - {fmtMins(view.capacity.reserved_buffer_minutes)} buffer - {fmtMins(view.capacity.fixed_commitment_minutes)} fixed = {fmtMins(view.capacity.available_after_fixed_minutes)} focus
            </p>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className={`rounded-full border px-2 py-1 font-mono text-[9px] font-bold uppercase ${
            placedOverbooked ? 'border-red-400/30 bg-red-500/10 text-red-700' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-700'
          }`}>
            {placedOverbooked ? `Placed over ${fmtMins(Math.abs(view.free_after_scheduled_minutes))}` : `${fmtMins(view.free_after_scheduled_minutes)} free placed`}
          </span>
          <span className={`rounded-full border px-2 py-1 font-mono text-[9px] font-bold uppercase ${
            dueOverCapacity ? 'border-amber-400/30 bg-amber-500/10 text-amber-700' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-700'
          }`}>
            {dueOverCapacity ? `Due over ${fmtMins(view.over_capacity_minutes)}` : `${fmtMins(Math.max(0, view.capacity.available_after_fixed_minutes - view.due_leaf_minutes))} spare due`}
          </span>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[9px] font-bold uppercase text-slate-500">
            {fmtMins(view.scheduled_minutes)} placed
          </span>
        </div>
      </div>

      <div className="max-h-[560px] overflow-y-auto px-3 py-3">
        {showTimelineGrid ? (
        <div className="relative rounded-xl border border-slate-200 bg-white">
          <div className="relative" style={{ height }}>
            {hours.map(hour => (
              <div key={hour} className="absolute left-0 right-0 border-t border-slate-200" style={{ top: y(hour) }}>
                <span className="absolute -top-2 left-2 w-10 text-right font-mono text-[9px] uppercase text-slate-500">
                  {hour < endHour ? fmtHourLabel(hour) : ''}
                </span>
              </div>
            ))}

            {view.work_start > startHour && (
              <div className="pointer-events-none absolute left-14 right-0 top-0 bg-slate-50" style={{ height: y(Math.min(view.work_start, endHour)) }} />
            )}
            {view.work_end < endHour && (
              <div className="pointer-events-none absolute bottom-0 left-14 right-0 bg-slate-50" style={{ top: y(Math.max(view.work_end, startHour)) }} />
            )}

            <div className="absolute bottom-0 left-14 top-0 border-l border-slate-200" />

            {displayBlocks.length === 0 ? (
              <div className="absolute left-16 right-3 top-4 rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-[12px] text-slate-500">
                No timed blocks placed.
              </div>
            ) : (
              <div className="absolute bottom-0 left-14 right-2 top-0">
                {displayBlocks.map(block => {
                  const pos = packed.get(block.key) ?? { col: 0, cols: 1 };
                  const top = Math.max(0, y(block.start));
                  const blockHeight = Math.max(26, Math.min((block.end - block.start) * HOUR_PX, height - top) - 3);
                  const leftPct = (pos.col / pos.cols) * 100;
                  const widthPct = 100 / pos.cols;
                  const compact = blockHeight < 40;
                  return (
                    <div
                      key={block.key}
                      className={`absolute z-10 overflow-hidden rounded-lg border-l-[3px] px-2 py-1 shadow-sm ${blockTone(block)}`}
                      style={{
                        top,
                        height: blockHeight,
                        left: `${leftPct}%`,
                        width: `calc(${widthPct}% - 4px)`,
                      }}
                      title={`${block.time_label} - ${block.title}`}
                    >
                      <p className="truncate text-[11px] font-bold leading-tight">{blockLabel(block)}</p>
                      {!compact && (
                        <p className="mt-0.5 flex items-center gap-1 truncate font-mono text-[9px] opacity-75">
                          <Clock size={9} /> {fmtTimeRange(block.start_hour, block.duration_minutes / 60)} - {block.indicator}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
                <Clock size={12} className="text-indigo-700" /> Placed on timeline
              </p>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[9px] text-slate-500">{fmtMins(view.scheduled_minutes)}</span>
            </div>
            {displayBlocks.length ? displayBlocks.map(block => (
              <div key={block.key} className={`flex items-center gap-3 rounded-xl border-l-[3px] px-3 py-2.5 ${blockTone(block)}`}>
                <span className="w-24 shrink-0 font-mono text-[10px] opacity-75">{block.time_label}</span>
                <p className="min-w-0 flex-1 truncate text-[12px] font-semibold">{blockLabel(block)}</p>
                <span className="font-mono text-[9px] opacity-60">{block.indicator}</span>
              </div>
            )) : (
              <div className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-[11px] text-slate-500">Nothing has a start time yet.</div>
            )}
          </div>
        )}

        {view.day_level_tasks.length > 0 && view.due_groups.length === 0 && (
          <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
              <Layers size={12} className="text-indigo-700" /> Unscheduled tasks
            </p>
            <div className="flex flex-wrap gap-1.5">
              {view.day_level_tasks.map(task => (
                <span key={task.id} className="max-w-full rounded-lg border border-indigo-400/20 bg-indigo-500/10 px-2 py-1 text-[11px] text-indigo-700" title={task.goal_title ?? undefined}>
                  <span className="font-semibold">{task.title}</span>
                  {task.remaining_minutes !== null && <span className="ml-1 font-mono text-indigo-700">{fmtMins(task.remaining_minutes)}</span>}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="mt-3 rounded-xl border border-amber-400/15 bg-amber-500/[0.045] p-3">
          <div className="mb-2 flex items-center gap-2">
          <p className="flex flex-1 items-center gap-1.5 text-[11px] font-bold text-slate-800">
            {dueOverCapacity ? <AlertTriangle size={12} className="text-amber-700" /> : <Clock size={12} className="text-emerald-700" />}
            Unscheduled work - {fmtMins(view.due_leaf_minutes)}
          </p>
          {view.due_leaf_minutes > 0 && <span className="rounded-full border border-amber-400/20 bg-amber-500/10 px-2 py-0.5 font-mono text-[8px] font-bold uppercase text-amber-700">Not on timeline</span>}
          </div>
          {topDueGroups.length === 0 ? (
            <p className="text-[11px] text-slate-500">No due work on this day.</p>
          ) : (
            <div className="space-y-1.5">
              {topDueGroups.map(group => (
                <div key={group.origin_id} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-slate-900">{group.origin_title}</span>
                    <span className="shrink-0 font-mono text-[9px] text-slate-500">{fmtMins(group.total_minutes)}</span>
                  </div>
                  <p className="mt-0.5 truncate text-[9px] text-slate-500">
                    {group.tasks.slice(0, 3).map(task => task.title).join(', ')}
                    {group.tasks.length > 3 ? ` +${group.tasks.length - 3} more` : ''}
                  </p>
                </div>
              ))}
              {view.due_groups.length > topDueGroups.length && (
                <p className="font-mono text-[9px] uppercase text-slate-500">+{view.due_groups.length - topDueGroups.length} more due groups</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
