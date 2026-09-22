import { useEffect, useMemo, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { Check, Info, Link2, Lock, Repeat2, Users, X } from 'lucide-react';
import type { DBEvent } from '../../db/schema';
import type { DBEventTaskLinkFull } from '../../api/hooks';
import { clampHour, fmtHourLabel, fmtTimeRange, packOverlaps, parseLocalDate, snapHour, type TimedBlock } from '../../utils/calendar';
import { eventCompletion } from '../../utils/eventAutofill';
import { useAppStore } from '../../store/useAppStore';

/**
 * Google-Calendar-style week grid: an hour axis, seven day columns, timed
 * blocks (events + meetings) packed side-by-side when they overlap, a red
 * "now" line, and a sticky header row that carries the all-day cells the
 * parent renders (they stay drag-and-drop day targets).
 */

export const GRID_START_HOUR = 1;
export const GRID_END_HOUR = 24;
export const HOUR_PX = 48;
const MIN_HOUR_PX = 28;
const DENSITY_REFERENCE_WIDTH = 1440;
const COLS = 'grid grid-cols-[52px_repeat(7,minmax(0,1fr))]';

/**
 * Browser zoom-out increases the CSS viewport width. Use that extra room to
 * progressively condense the time axis, while keeping normal-sized windows at
 * the comfortable 48px/hour density.
 */
export function scheduleHourPxForViewport(viewportWidth: number): number {
  const safeWidth = Math.max(1, viewportWidth);
  return Math.round(Math.max(MIN_HOUR_PX, Math.min(HOUR_PX, HOUR_PX * DENSITY_REFERENCE_WIDTH / safeWidth)));
}

const hourToY = (h: number, hourPx: number) => (h - GRID_START_HOUR) * hourPx;

const TYPE_STYLES: Record<string, string> = {
  focus:       'bg-[#EEF2FF] border-[#4648d4] text-[#33359c]',
  buffer:      'bg-amber-50 border-amber-400 text-amber-800',
  review:      'bg-emerald-50 border-emerald-500 text-emerald-800',
  admin:       'bg-slate-100 border-slate-400 text-slate-700',
  unavailable: 'bg-gray-100 border-gray-400 text-gray-500',
};

export interface CalendarMeeting {
  id: string;
  title: string;
  date: string;       // ISO YYYY-MM-DD
  startHour: number;  // fractional
  durationHours: number;
}

export interface PlacedEvent {
  event: DBEvent;
  date: string; // resolved date within the displayed week
}

export interface DayBreakdownItem {
  label: string;
  minutes: number;
  detail?: string;
  tone?: 'capacity' | 'buffer' | 'meeting' | 'block' | 'task' | 'routine' | 'free' | 'overbooked';
}

export interface CalendarRoutine {
  routine_id: string;
  title: string;
  date: string;
  minutes: number;
  preferred_time: string | null;
}

function routineHour(routine: CalendarRoutine): number {
  if (!routine.preferred_time) return -1;
  const [hours, minutes] = routine.preferred_time.split(':').map(Number);
  return hours + minutes / 60;
}

export interface DayCapacityBreakdown {
  date: string;
  capacityMinutes: number;
  bookedMinutes: number;
  freeMinutes: number;
  items: DayBreakdownItem[];
}

interface WeekTimeGridProps {
  days: string[]; // 7 ISO dates, Monday-first
  events: PlacedEvent[];
  meetings: CalendarMeeting[];
  routines?: CalendarRoutine[];
  linksByEvent: Map<string, DBEventTaskLinkFull[]>;
  workStart: number;
  workEnd: number;
  workDays: number[]; // 1=Mon … 7=Sun
  selectedDate?: string;
  onDaySelect?: (date: string) => void;
  dayBreakdowns?: Map<string, DayCapacityBreakdown>;
  breakdownResetKey?: string;
  renderAllDayCell: (date: string) => React.ReactNode;
  onSlotClick: (date: string, startHour: number) => void;
  onEventClick: (ev: DBEvent) => void;
  onEventMove: (ev: DBEvent, next: { date: string; start_hour: number }) => void;
  onEventResize: (ev: DBEvent, durationHours: number) => void;
  /** hover ✕ on blocks — one click removes without opening the editor */
  onEventDelete?: (ev: DBEvent) => void;
}

function useNowTick(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function dayHeaderParts(dateStr: string, now: Date) {
  const d = parseLocalDate(dateStr);
  return {
    dow: d.toLocaleDateString('en-US', { weekday: 'short' }),
    dom: d.getDate(),
    isToday: d.toDateString() === now.toDateString(),
  };
}

function fmtMins(mins: number): string {
  if (Math.abs(mins) < 60) return `${mins}m`;
  const h = Math.floor(Math.abs(mins) / 60);
  const m = Math.abs(mins) % 60;
  return `${mins < 0 ? '-' : ''}${h}h${m ? ` ${m}m` : ''}`;
}

export function DayFreeBadge({ breakdown, align = 'center', resetKey }: { breakdown?: DayCapacityBreakdown; align?: 'left' | 'center' | 'right'; resetKey?: string }) {
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    setHovered(false);
  }, [resetKey]);
  if (!breakdown) return null;
  const open = hovered;

  const free = breakdown.freeMinutes;
  const tone = breakdown.capacityMinutes <= 0
    ? 'border-gray-200 bg-gray-50 text-gray-400'
    : free < 0
      ? 'border-red-200 bg-red-50 text-red-700'
      : free < 60
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-emerald-200 bg-emerald-50 text-emerald-700';
  const max = Math.max(1, ...breakdown.items.map(i => Math.abs(i.minutes)));
  const popoverAlign =
    align === 'left' ? 'left-0' :
    align === 'right' ? 'right-0' :
    'left-1/2 -translate-x-1/2';

  return (
    <div
      className="relative mt-1"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={e => { e.stopPropagation(); e.currentTarget.blur(); setHovered(false); }}
        className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wide ${tone}`}
        title="Show day capacity breakdown"
        aria-label={`Show day capacity breakdown for ${breakdown.date}`}
        aria-expanded={open}
      >
        <Info size={8} />
        {breakdown.capacityMinutes <= 0 ? 'off' : free >= 0 ? `${fmtMins(free)} free` : `${fmtMins(-free)} over`}
      </button>
      {open && (
        <div className={`absolute top-full z-50 mt-1 w-64 rounded-lg border border-gray-200 bg-white p-2 text-left shadow-xl ${popoverAlign}`}>
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-gray-500">Day hours</span>
            <span className={`font-mono text-[9px] font-bold ${free < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
              {breakdown.capacityMinutes <= 0 ? 'off day' : free >= 0 ? `${fmtMins(free)} free` : `${fmtMins(-free)} over`}
            </span>
          </div>
          <div className="max-h-80 space-y-1 overflow-y-auto pr-0.5">
            {breakdown.items.map(item => {
              const itemTone =
                item.tone === 'free' ? 'bg-emerald-400' :
                item.tone === 'overbooked' ? 'bg-red-400' :
                item.tone === 'meeting' ? 'bg-purple-400' :
                item.tone === 'routine' ? 'bg-teal-400' :
                item.tone === 'block' ? 'bg-indigo-400' :
                item.tone === 'task' ? 'bg-amber-400' :
                item.tone === 'buffer' ? 'bg-gray-300' :
                'bg-slate-400';
              return (
                <div key={`${item.label}-${item.detail ?? ''}`} className="rounded-md bg-gray-50 px-1.5 py-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`h-1.5 rounded-full ${itemTone}`} style={{ width: `${Math.max(8, Math.round((Math.abs(item.minutes) / max) * 52))}px` }} />
                    <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-gray-700" title={item.label}>{item.label}</span>
                    <span className="font-mono text-[9px] text-gray-500">{fmtMins(item.minutes)}</span>
                  </div>
                  {item.detail && <p className="mt-0.5 whitespace-normal break-words text-[9px] leading-snug text-gray-400">{item.detail}</p>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Interactive event block ───────────────────────────────────────────────────

interface DragState { dy: number; dDay: number; colW: number }

function EventBlock({ placed, dayIdx, days, pos, links, hourPx, gridHeight, onClick, onMove, onResize, onDelete }: {
  placed: PlacedEvent;
  dayIdx: number;
  days: string[];
  pos: { col: number; cols: number };
  links: DBEventTaskLinkFull[];
  hourPx: number;
  gridHeight: number;
  onClick: (ev: DBEvent) => void;
  onMove: (ev: DBEvent, next: { date: string; start_hour: number; dayIdx: number }) => void;
  onResize: (ev: DBEvent, durationHours: number) => void;
  onDelete?: (ev: DBEvent) => void;
}) {
  const ev = placed.event;
  const { navigateToGoal, setTaskSpotlight, triggerToast } = useAppStore();
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resizeDelta, setResizeDelta] = useState<number | null>(null);
  const gesture = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
  const cancelled = useRef(false);

  const duration = Math.max(0.5, ev.duration_hours);
  const start = clampHour(ev.start_hour, GRID_START_HOUR, GRID_END_HOUR - 0.5);
  const completion = eventCompletion(links);
  const style = TYPE_STYLES[(ev.type ?? 'focus').toLowerCase()] ?? TYPE_STYLES.focus;
  const draggable = !ev.locked;

  // Live values while dragging/resizing, snapped for feedback
  const previewStart = drag
    ? clampHour(snapHour(start + drag.dy / hourPx), GRID_START_HOUR, GRID_END_HOUR - duration)
    : start;
  const previewDuration = resizeDelta !== null
    ? Math.max(0.5, snapHour(duration + resizeDelta / hourPx))
    : duration;
  const previewDay = drag ? Math.min(6, Math.max(0, dayIdx + drag.dDay)) : dayIdx;

  // Escape drops the block back where it was — no accidental moves/resizes.
  useEffect(() => {
    if (!drag && resizeDelta === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelled.current = true;
        gesture.current = null;
        setDrag(null);
        setResizeDelta(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag, resizeDelta]);

  const commitPointer = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    cancelled.current = false;
    gesture.current = { startX: e.clientX, startY: e.clientY, moved: false };
  };

  const onBlockPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    commitPointer(e);
    if (draggable) {
      const colW = (e.currentTarget as HTMLElement).parentElement?.offsetWidth ?? 120;
      setDrag({ dy: 0, dDay: 0, colW });
    }
  };
  const onBlockPointerMove = (e: React.PointerEvent) => {
    if (!gesture.current) return;
    const dx = e.clientX - gesture.current.startX;
    const dy = e.clientY - gesture.current.startY;
    if (Math.abs(dx) + Math.abs(dy) > 5) gesture.current.moved = true;
    if (drag) setDrag(d => d && { ...d, dy, dDay: Math.round(dx / d.colW) });
  };
  const onBlockPointerUp = (e: React.PointerEvent) => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const moved = gesture.current?.moved;
    gesture.current = null;
    if (!moved) {
      setDrag(null);
      if (e.altKey) {
        const link = links.find(l => l.goal_id && l.task_id);
        if (link?.goal_id) {
          setTaskSpotlight(link.task_id);
          navigateToGoal(link.goal_id);
        } else {
          triggerToast('This calendar block is not linked to a goal task yet.', 'info');
        }
        return;
      }
      onClick(ev);
      return;
    }
    if (drag) {
      onMove(ev, { date: '', start_hour: previewStart, dayIdx: previewDay });
      setDrag(null);
    }
  };

  const onResizePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    commitPointer(e);
    setResizeDelta(0);
  };
  const onResizePointerMove = (e: React.PointerEvent) => {
    if (!gesture.current || resizeDelta === null) return;
    gesture.current.moved = true;
    setResizeDelta(e.clientY - gesture.current.startY);
  };
  const onResizePointerUp = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    gesture.current = null;
    if (resizeDelta !== null) {
      onResize(ev, previewDuration);
      setResizeDelta(null);
    }
  };

  const top = hourToY(previewStart, hourPx);
  const height = Math.max(Math.max(16, hourPx * 0.45), Math.min(previewDuration * hourPx, gridHeight - top) - 2);
  const linkedTitle = links[0]?.task_title;
  const active = drag !== null || resizeDelta !== null;
  const dragging = drag !== null && Boolean(gesture.current?.moved);
  const resizing = resizeDelta !== null && Boolean(gesture.current?.moved);
  const dropDayLabel = parseLocalDate(days[previewDay] ?? placed.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <div
      onPointerDown={onBlockPointerDown}
      onPointerMove={onBlockPointerMove}
      onPointerUp={onBlockPointerUp}
      onClick={e => e.stopPropagation()}
      className={`group absolute rounded-md border-l-[3px] text-left shadow-sm select-none touch-none
        ${style}
        ${completion === 'done' ? 'opacity-60' : ''}
        ${draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}
        ${active ? 'z-30 shadow-lg ring-2 ring-[#4648d4]/30' : 'z-10 hover:shadow-md'}`}
      style={{
        top,
        height,
        left: `calc(${(pos.col / pos.cols) * 100}% + 2px)`,
        width: `calc(${100 / pos.cols}% - 4px)`,
        transform: drag && drag.dDay !== 0 ? `translateX(calc(${(previewDay - dayIdx) * 100}% * ${pos.cols}))` : undefined,
      }}
      title={ev.title}
    >
      {/* Landing tooltip: exactly where the block will drop / how long it will be */}
      {(dragging || resizing) && (
        <div className={`pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 font-mono text-[10px] font-bold text-white shadow-lg ${top < 40 ? '-bottom-8' : '-top-8'}`}>
          {dropDayLabel} · {fmtTimeRange(previewStart, previewDuration)}
        </div>
      )}
      <div className="h-full w-full overflow-hidden px-1.5 py-1">
        <p className={`truncate text-xs font-semibold leading-tight ${completion === 'done' ? 'line-through' : ''}`}>
          {ev.locked && <Lock size={10} className="mr-0.5 inline -mt-0.5" />}
          {ev.title}
        </p>
        {height > 34 && (
          <p className="truncate font-mono text-[10px] opacity-70">{fmtTimeRange(previewStart, previewDuration)}</p>
        )}
        {height > 52 && linkedTitle && (
          <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] opacity-80">
            {completion === 'done'
              ? <Check size={10} className="shrink-0" />
              : <Link2 size={10} className="shrink-0" />}
            <span className="truncate">{completion === 'partial' ? `${linkedTitle} (partly done)` : linkedTitle}</span>
          </p>
        )}
      </div>
      {completion === 'done' && height <= 52 && (
        <Check size={10} className="pointer-events-none absolute right-5 top-1" />
      )}
      {onDelete && !ev.locked && !active && (
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onDelete(ev); }}
          className="absolute right-0.5 top-0.5 z-20 hidden rounded bg-white/90 p-0.5 text-gray-400 shadow-sm hover:text-red-500 group-hover:block"
          title="Remove this block from the calendar"
        >
          <X size={12} />
        </button>
      )}
      {draggable && (
        <div
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          className="absolute inset-x-0 bottom-0 h-2.5 cursor-ns-resize"
          title="Drag to change how long this block runs"
        >
          <div className="mx-auto mt-1 h-1 w-8 rounded-full bg-current opacity-0 transition-opacity group-hover:opacity-30" />
        </div>
      )}
    </div>
  );
}

// ── Day column ────────────────────────────────────────────────────────────────

function DayColumn({ date, dayIdx, events, meetings, routines, onRoutineDaySelect, linksByEvent, isWorkDay, workStart, workEnd, isToday, isSelected, now, hourPx, gridHeight, onSlotClick, onEventClick, onEventMove, onEventResize, onEventDelete, days }: {
  date: string;
  dayIdx: number;
  events: PlacedEvent[];
  meetings: CalendarMeeting[];
  routines: CalendarRoutine[];
  onRoutineDaySelect?: (date: string) => void;
  linksByEvent: Map<string, DBEventTaskLinkFull[]>;
  isWorkDay: boolean;
  workStart: number;
  workEnd: number;
  isToday: boolean;
  isSelected: boolean;
  now: Date;
  hourPx: number;
  gridHeight: number;
  onSlotClick: (date: string, startHour: number) => void;
  onEventClick: (ev: DBEvent) => void;
  onEventMove: (ev: DBEvent, next: { date: string; start_hour: number }) => void;
  onEventResize: (ev: DBEvent, durationHours: number) => void;
  onEventDelete?: (ev: DBEvent) => void;
  days: string[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `slot:${date}` });

  const packed = useMemo(() => {
    const blocks: TimedBlock[] = [
      ...events.map(p => ({
        id: `e:${p.event.id}`,
        start: p.event.start_hour,
        end: p.event.start_hour + Math.max(0.5, p.event.duration_hours),
      })),
      ...meetings.map(m => ({
        id: `m:${m.id}`,
        start: m.startHour,
        end: m.startHour + Math.max(0.25, m.durationHours),
      })),
      ...routines.map(routine => ({ id: `r:${routine.routine_id}`, start: routineHour(routine), end: routineHour(routine) + Math.max(routine.minutes / 60, 18 / hourPx) })),
    ];
    return packOverlaps(blocks);
  }, [events, meetings, routines, hourPx]);

  const handleBackgroundClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = GRID_START_HOUR + (e.clientY - rect.top) / hourPx;
    const hour = clampHour(snapHour(raw, 30), GRID_START_HOUR, GRID_END_HOUR - 0.5);
    onSlotClick(date, hour);
  };

  const nowY = hourToY(now.getHours() + now.getMinutes() / 60, hourPx);

  return (
    <div
      ref={setNodeRef}
      onClick={handleBackgroundClick}
      className={`relative cursor-pointer border-l border-gray-100
        ${!isWorkDay ? 'bg-gray-50/70' : ''}
        ${isSelected ? 'bg-indigo-50/40 ring-1 ring-inset ring-indigo-200' : ''}
        ${isOver ? 'bg-indigo-50/60 ring-1 ring-inset ring-indigo-300' : ''}`}
      style={{ height: gridHeight }}
    >
      {/* Off-hours shading inside working days */}
      {isWorkDay && workStart > GRID_START_HOUR && (
        <div className="pointer-events-none absolute inset-x-0 top-0 bg-gray-50/70" style={{ height: hourToY(Math.min(workStart, GRID_END_HOUR), hourPx) }} />
      )}
      {isWorkDay && workEnd < GRID_END_HOUR && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gray-50/70" style={{ top: hourToY(Math.max(workEnd, GRID_START_HOUR), hourPx) }} />
      )}

      {/* Hour lines */}
      {Array.from({ length: GRID_END_HOUR - GRID_START_HOUR - 1 }, (_, i) => (
        <div key={i} className="pointer-events-none absolute inset-x-0 border-t border-gray-100" style={{ top: (i + 1) * hourPx }} />
      ))}

      {/* Meetings (read-only) */}
      {meetings.map(m => {
        const pos = packed.get(`m:${m.id}`) ?? { col: 0, cols: 1 };
        const top = hourToY(clampHour(m.startHour, GRID_START_HOUR, GRID_END_HOUR - 0.25), hourPx);
        const height = Math.max(Math.max(14, hourPx * 0.4), Math.min(m.durationHours * hourPx, gridHeight - top) - 2);
        return (
          <div
            key={m.id}
            onClick={e => e.stopPropagation()}
            className="absolute z-10 overflow-hidden rounded-md border-l-[3px] border-purple-500 bg-purple-50 px-1.5 py-1 text-purple-800 shadow-sm"
            style={{ top, height, left: `calc(${(pos.col / pos.cols) * 100}% + 2px)`, width: `calc(${100 / pos.cols}% - 4px)` }}
            title={`${m.title} — meeting (edit it from its goal)`}
          >
            <p className="flex items-center gap-1 truncate text-[11px] font-semibold leading-tight">
              <Users size={10} className="shrink-0" />{m.title}
            </p>
            {height > 30 && <p className="font-mono text-[9px] opacity-70">{fmtTimeRange(m.startHour, m.durationHours)}</p>}
          </div>
        );
      })}

      {routines.map(routine => {
        const start = routineHour(routine);
        const pos = packed.get(`r:${routine.routine_id}`) ?? { col: 0, cols: 1 };
        const top = hourToY(start, hourPx);
        const height = Math.max(16, Math.min(routine.minutes / 60 * hourPx, gridHeight - top) - 2);
        return <button key={routine.routine_id} type="button" onClick={event => { event.stopPropagation(); onRoutineDaySelect?.(date); }}
          className="absolute z-10 overflow-hidden rounded-md border border-dashed border-teal-500 bg-teal-50 px-1.5 text-left text-teal-900"
          style={{ top, height, left: `calc(${pos.col / pos.cols * 100}% + 2px)`, width: `calc(${100 / pos.cols}% - 4px)` }}
          title={`Routine: ${routine.title} · ${routine.preferred_time} · ${routine.minutes}m reserved. Select the day to check in.`}
          aria-label={`Routine ${routine.title} at ${routine.preferred_time}`}>
          <span className="flex items-center gap-1 truncate text-[11px] font-semibold"><Repeat2 size={10} className="shrink-0" />{routine.title}</span>
          {height > 32 && <span className="text-[9px]">{routine.preferred_time} · {routine.minutes}m routine</span>}
        </button>;
      })}

      {/* Events */}
      {events.map(p => (
        <EventBlock
          key={p.event.id}
          placed={p}
          dayIdx={dayIdx}
          days={days}
          pos={packed.get(`e:${p.event.id}`) ?? { col: 0, cols: 1 }}
          links={linksByEvent.get(p.event.id) ?? []}
          hourPx={hourPx}
          gridHeight={gridHeight}
          onClick={onEventClick}
          onMove={(ev, next) => onEventMove(ev, { date: days[next.dayIdx], start_hour: next.start_hour })}
          onResize={onEventResize}
          onDelete={onEventDelete}
        />
      ))}

      {/* Now line */}
      {isToday && nowY >= 0 && nowY <= gridHeight && (
        <div className="pointer-events-none absolute inset-x-0 z-20" style={{ top: nowY }}>
          <div className="relative border-t-2 border-red-500">
            <span className="absolute -left-1 -top-[5px] h-2 w-2 rounded-full bg-red-500" />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Grid ──────────────────────────────────────────────────────────────────────

export function WeekTimeGrid({ days, events, meetings, routines = [], linksByEvent, workStart, workEnd, workDays, selectedDate, onDaySelect, dayBreakdowns, breakdownResetKey, renderAllDayCell, onSlotClick, onEventClick, onEventMove, onEventResize, onEventDelete }: WeekTimeGridProps) {
  const now = useNowTick();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hourPx, setHourPx] = useState(() => scheduleHourPxForViewport(typeof window === 'undefined' ? DENSITY_REFERENCE_WIDTH : window.innerWidth));
  const gridHeight = (GRID_END_HOUR - GRID_START_HOUR) * hourPx;

  useEffect(() => {
    const updateDensity = () => setHourPx(scheduleHourPxForViewport(window.innerWidth));
    updateDensity();
    window.addEventListener('resize', updateDensity);
    window.visualViewport?.addEventListener('resize', updateDensity);
    return () => {
      window.removeEventListener('resize', updateDensity);
      window.visualViewport?.removeEventListener('resize', updateDensity);
    };
  }, []);

  const eventsByDate = useMemo(() => {
    const m = new Map<string, PlacedEvent[]>();
    for (const p of events) {
      if (!m.has(p.date)) m.set(p.date, []);
      m.get(p.date)!.push(p);
    }
    return m;
  }, [events]);

  const meetingsByDate = useMemo(() => {
    const m = new Map<string, CalendarMeeting[]>();
    for (const mt of meetings) {
      if (!m.has(mt.date)) m.set(mt.date, []);
      m.get(mt.date)!.push(mt);
    }
    return m;
  }, [meetings]);

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div
        ref={scrollRef}
        className="relative overflow-y-auto overscroll-contain"
        style={{ maxHeight: 'clamp(520px, calc(100vh - 100px), 820px)' }}
      >
        {/* Sticky: day headers + all-day cells share the scrollbar gutter with the grid */}
        <div className="sticky top-0 z-40 border-b border-gray-200 bg-white">
          <div className={COLS}>
            <div />
            {days.map((d, index) => {
              const h = dayHeaderParts(d, now);
              const selected = selectedDate === d;
              const breakdownAlign = index <= 1 ? 'left' : index >= days.length - 2 ? 'right' : 'center';
              return (
                <div
                  key={d}
                  className={`flex flex-col items-center border-l border-gray-100 py-1.5 transition-colors hover:bg-gray-50 ${selected ? 'bg-indigo-50/70' : ''}`}
                >
                  <button type="button" onClick={() => onDaySelect?.(d)} className="flex flex-col items-center rounded-lg px-2 py-1 hover:bg-gray-50" title="Focus this day" aria-label={`Focus ${h.dow} ${h.dom}`}>
                    <span className={`font-mono text-[9px] font-bold uppercase tracking-widest ${h.isToday ? 'text-[#4648d4]' : 'text-gray-400'}`}>{h.dow}</span>
                    <span className={`mt-0.5 flex h-7 w-7 items-center justify-center rounded-full font-headline text-sm font-bold
                      ${h.isToday ? 'bg-[#4648d4] text-white' : selected ? 'bg-white text-[#4648d4] ring-1 ring-indigo-200' : 'text-gray-800'}`}>
                      {h.dom}
                    </span>
                  </button>
                  <DayFreeBadge breakdown={dayBreakdowns?.get(d)} align={breakdownAlign} resetKey={breakdownResetKey} />
                  {routines.some(routine => routine.date === d) && <button type="button" onClick={() => onDaySelect?.(d)} className="mt-1 flex items-center gap-1 text-[9px] font-semibold text-teal-700" title="Routine time is included in this day’s capacity"><Repeat2 size={10} />{fmtMins(routines.filter(routine => routine.date === d).reduce((sum, routine) => sum + routine.minutes, 0))} routines</button>}
                </div>
              );
            })}
          </div>
          <div className={`${COLS} h-[92px] border-t border-gray-100`}>
            <div className="py-1 pr-1.5 text-right font-mono text-[8px] uppercase tracking-wider text-gray-300">all day</div>
            {days.map(d => (
              <div key={d} className="h-full min-w-0 overflow-visible border-l border-gray-100">
                {renderAllDayCell(d)}
              </div>
            ))}
          </div>
        </div>

        {/* Time grid */}
        <div className={COLS}>
          <div className="relative" style={{ height: gridHeight }}>
            <span className="absolute right-1.5 top-1 font-mono text-[9px] text-gray-400">
              {fmtHourLabel(GRID_START_HOUR)}
            </span>
            {Array.from({ length: GRID_END_HOUR - GRID_START_HOUR - 1 }, (_, i) => (
              <span
                key={i}
                className="absolute right-1.5 -translate-y-1/2 font-mono text-[9px] text-gray-400"
                style={{ top: (i + 1) * hourPx }}
              >
                {fmtHourLabel(GRID_START_HOUR + i + 1)}
              </span>
            ))}
          </div>
          {days.map((d, i) => (
            <DayColumn
              key={d}
              date={d}
              dayIdx={i}
              days={days}
              events={eventsByDate.get(d) ?? []}
              meetings={meetingsByDate.get(d) ?? []}
              routines={routines.filter(routine => routine.date === d && routineHour(routine) >= GRID_START_HOUR && routineHour(routine) < GRID_END_HOUR)}
              onRoutineDaySelect={onDaySelect}
              linksByEvent={linksByEvent}
              isWorkDay={workDays.includes(i + 1)}
              workStart={workStart}
              workEnd={workEnd}
              isToday={dayHeaderParts(d, now).isToday}
              isSelected={selectedDate === d}
              now={now}
              hourPx={hourPx}
              gridHeight={gridHeight}
              onSlotClick={onSlotClick}
              onEventClick={onEventClick}
              onEventMove={onEventMove}
              onEventResize={onEventResize}
              onEventDelete={onEventDelete}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
