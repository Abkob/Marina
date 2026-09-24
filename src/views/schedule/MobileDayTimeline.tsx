import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GripHorizontal, Lock, Undo2 } from 'lucide-react';
import type { DBEvent } from '../../db/schema';
import type { MobileScheduleItem } from '../../utils/mobileSchedule';
import { clampHour, fmtHourLabel, fmtTimeRange, packOverlaps, snapHour } from '../../utils/calendar';
import { CALENDAR_HOLD_MS, CALENDAR_MOVE_TOLERANCE, gesturePlacement, swipeDirection, type CalendarGestureMode, type CalendarPlacement } from '../../utils/calendarGestures';

const HOUR_HEIGHT = 72;
const TONES = { event: 'border-indigo-400 bg-indigo-50 text-indigo-950', meeting: 'border-sky-400 bg-sky-50 text-sky-950', routine: 'border-teal-400 bg-teal-50 text-teal-950', task: 'border-violet-400 bg-violet-50 text-violet-950', deadline: 'border-rose-400 bg-rose-50 text-rose-950' };
interface Draft { item?: MobileScheduleItem; mode: CalendarGestureMode; placement: CalendarPlacement }
interface Gesture {
  id: number; source: 'touch' | 'pointer'; x: number; y: number; lastY: number; scrollTop: number;
  item?: MobileScheduleItem; mode: CalendarGestureMode | null; original: CalendarPlacement;
  active: boolean; cancelled: boolean; moved: boolean; last: CalendarPlacement;
}
interface Props {
  compact?: boolean;
  date: string; today: string; nowHour: number; items: MobileScheduleItem[]; online: boolean;
  onOpen: (item: MobileScheduleItem) => void;
  onCreate: (date: string, hour: number, duration?: number) => void;
  onChangeEvent: (event: DBEvent, placement: CalendarPlacement) => Promise<void>;
  onSwipe: (direction: -1 | 1) => void;
}

export function MobileDayTimeline(props: Props) {
  const { date, today, nowHour, items, onOpen, onCreate } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<{ event: DBEvent; before: CalendarPlacement; after: CalendarPlacement } | null>(null);
  const suppressClickUntil = useRef(0);
  const cancelGesture = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !props.compact) return;
    let frame = 0;
    const fit = () => {
      const viewport = window.visualViewport;
      if (viewport && viewport.scale !== 1) return;
      const bottom = (viewport?.height ?? window.innerHeight) + (viewport?.offsetTop ?? 0);
      const navHeight = document.querySelector('.mobile-bottom-nav')?.getBoundingClientRect().height ?? 76;
      const height = `${Math.max(180, Math.floor(bottom - element.getBoundingClientRect().top - navHeight - 12))}px`;
      if (element.style.height !== height) element.style.height = height;
    };
    const scheduleFit = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleFit);
    const schedule = element.closest('.mobile-schedule');
    if (schedule) observer?.observe(schedule);
    window.addEventListener('resize', scheduleFit);
    window.visualViewport?.addEventListener('resize', scheduleFit);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', scheduleFit);
      window.visualViewport?.removeEventListener('resize', scheduleFit);
      element.style.removeProperty('height');
    };
  }, [props.compact]);

  const save = async (event: DBEvent, before: CalendarPlacement, after: CalendarPlacement, isUndo = false) => {
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      await latest.current.onChangeEvent(event, after);
      setUndo(isUndo ? null : { event, before, after });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save. Your block has not moved.');
    } finally {
      savingRef.current = false;
      setSaving(false);
      setDraft(null);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const first = items.find(item => item.start !== null)?.start ?? 8;
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (date === today ? nowHour - 1 : first - 0.5) * HOUR_HEIGHT);
    // The keyed component mounts once per day, so a refresh never jumps the scroll position.
  }, []);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let gesture: Gesture | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let scrollFrame = 0;
    let lastFrame = 0;
    const clearHold = () => { clearTimeout(holdTimer); holdTimer = undefined; };
    const stop = (suppress = false) => {
      if (suppress) suppressClickUntil.current = Date.now() + 600;
      clearHold();
      cancelAnimationFrame(scrollFrame);
      scrollFrame = 0;
      gesture = null;
      setDraft(null);
    };
    cancelGesture.current = () => stop(true);
    const updateDraft = () => {
      if (!gesture?.active || !gesture.mode) return;
      const delta = (gesture.lastY - gesture.y + element.scrollTop - gesture.scrollTop) / HOUR_HEIGHT;
      gesture.last = gesture.moved || element.scrollTop !== gesture.scrollTop
        ? gesturePlacement(gesture.original, gesture.mode, delta) : gesture.original;
      setDraft({ item: gesture.item, mode: gesture.mode, placement: gesture.last });
    };
    const scroll = (time: number) => {
      if (!gesture?.active) return;
      const rect = element.getBoundingClientRect();
      const elapsed = lastFrame ? Math.min(32, time - lastFrame) : 16;
      lastFrame = time;
      const edge = 36;
      const direction = !gesture.moved ? 0 : gesture.lastY < rect.top + edge ? -1 : gesture.lastY > rect.bottom - edge ? 1 : 0;
      if (direction) {
        const previous = element.scrollTop;
        element.scrollTop = clampHour(previous + direction * elapsed * 0.35, 0, Math.max(0, element.scrollHeight - element.clientHeight));
        if (previous !== element.scrollTop) updateDraft();
      }
      scrollFrame = requestAnimationFrame(scroll);
    };
    const begin = (id: number, source: Gesture['source'], x: number, y: number, target: EventTarget | null) => {
      if (savingRef.current || !(target instanceof Element)) return;
      stop();
      const card = target.closest<HTMLElement>('[data-calendar-item]');
      const item = latest.current.items.find(item => item.id === card?.dataset.calendarItem);
      const handle = target.closest<HTMLElement>('[data-calendar-resize]')?.dataset.calendarResize;
      const canEdit = latest.current.online && item?.event && !item.event.locked;
      const slot = target.closest('[data-calendar-slot]');
      const hour = clampHour(snapHour((y - element.getBoundingClientRect().top + element.scrollTop) / HOUR_HEIGHT), 0, 23.75);
      const original = { date: latest.current.date, startHour: item?.start ?? hour, durationHours: item ? item.minutes / 60 : Math.min(0.5, 24 - hour) };
      const mode = canEdit ? handle === 'start' ? 'resize-start' : handle === 'end' ? 'resize-end' : 'move' : slot && latest.current.online ? 'create' : null;
      gesture = { id, source, x, y, lastY: y, scrollTop: element.scrollTop, item, mode, original, last: original, active: false, cancelled: false, moved: false };
      if (mode) holdTimer = setTimeout(() => {
        if (!gesture || gesture.cancelled) return;
        gesture.active = true;
        setError('');
        updateDraft();
        lastFrame = 0;
        scrollFrame = requestAnimationFrame(scroll);
      }, CALENDAR_HOLD_MS);
    };
    const move = (x: number, y: number, event: Event) => {
      if (!gesture) return;
      const dx = x - gesture.x;
      const dy = y - gesture.y;
      gesture.lastY = y;
      if (Math.hypot(dx, dy) > CALENDAR_MOVE_TOLERANCE) gesture.moved = true;
      if (gesture.active) {
        // Native non-passive touch listeners are intentional: changing touch-action
        // after the hold cannot stop Safari's already-started scrolling gesture.
        if (event.cancelable) event.preventDefault();
        updateDraft();
      } else if (gesture.moved) {
        clearHold();
        if (Math.abs(dy) > CALENDAR_MOVE_TOLERANCE && Math.abs(dy) >= Math.abs(dx)) gesture.cancelled = true;
        if (!gesture.cancelled && Math.abs(dx) > Math.abs(dy) * 1.6 && event.cancelable) event.preventDefault();
      }
    };
    const end = (x: number, y: number, event: Event) => {
      if (!gesture) return;
      const current = gesture;
      if (current.active) {
        if (!latest.current.online) { stop(true); setError('You’re offline. Reconnect and try again.'); return; }
        if (event.cancelable) event.preventDefault();
        suppressClickUntil.current = Date.now() + 600;
        clearHold();
        cancelAnimationFrame(scrollFrame);
        gesture = null;
        if (current.mode === 'create') {
          setDraft(null);
          latest.current.onCreate(current.last.date, current.last.startHour, current.last.durationHours);
        } else if (current.item?.event && (current.last.startHour !== current.original.startHour || current.last.durationHours !== current.original.durationHours)) {
          void saveRef.current(current.item.event, current.original, current.last);
        } else setDraft(null);
        return;
      }
      const direction = !current.cancelled ? swipeDirection(x - current.x, y - current.y) : 0;
      stop(current.moved);
      if (direction) latest.current.onSwipe(direction);
    };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) { stop(true); return; }
      const point = event.touches[0];
      begin(point.identifier, 'touch', point.clientX, point.clientY, event.target);
    };
    const multipleTouches = (event: TouchEvent) => { if (gesture && event.touches.length > 1) stop(true); };
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) { stop(true); return; }
      const point = event.touches[0];
      if (gesture?.source === 'touch' && point.identifier === gesture.id) move(point.clientX, point.clientY, event);
    };
    const touchEnd = (event: TouchEvent) => {
      const point = Array.from(event.changedTouches).find(point => point.identifier === gesture?.id);
      if (point && gesture?.source === 'touch') end(point.clientX, point.clientY, event);
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.button !== 0) return;
      begin(event.pointerId, 'pointer', event.clientX, event.clientY, event.target);
    };
    const pointerMove = (event: PointerEvent) => {
      if (gesture?.source === 'pointer' && event.pointerId === gesture.id) move(event.clientX, event.clientY, event);
    };
    const pointerUp = (event: PointerEvent) => {
      if (gesture?.source === 'pointer' && event.pointerId === gesture.id) end(event.clientX, event.clientY, event);
    };
    const cancel = () => stop(true);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    const hidden = () => { if (document.visibilityState !== 'visible') cancel(); };
    const contextMenu = (event: Event) => { if (gesture?.mode) event.preventDefault(); };
    element.addEventListener('touchstart', touchStart, { passive: true });
    document.addEventListener('touchstart', multipleTouches, { passive: true });
    element.addEventListener('touchmove', touchMove, { passive: false });
    element.addEventListener('touchend', touchEnd, { passive: false });
    element.addEventListener('touchcancel', cancel);
    element.addEventListener('pointerdown', pointerDown);
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    // Touch scroll can dispatch pointercancel before touchend; touchcancel owns that path.
    const pointerCancel = (event: PointerEvent) => { if (event.pointerType !== 'touch') cancel(); };
    window.addEventListener('pointercancel', pointerCancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key);
    document.addEventListener('visibilitychange', hidden);
    element.addEventListener('contextmenu', contextMenu);
    return () => {
      clearHold(); cancelAnimationFrame(scrollFrame);
      element.removeEventListener('touchstart', touchStart);
      document.removeEventListener('touchstart', multipleTouches);
      element.removeEventListener('touchmove', touchMove);
      element.removeEventListener('touchend', touchEnd);
      element.removeEventListener('touchcancel', cancel);
      element.removeEventListener('pointerdown', pointerDown);
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerCancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key);
      document.removeEventListener('visibilitychange', hidden);
      element.removeEventListener('contextmenu', contextMenu);
    };
  }, []);

  const timed = items.filter(item => item.start !== null);
  const positions = packOverlaps(timed.map(item => ({ id: item.id, start: item.start!, end: item.start! + Math.max(item.minutes / 60, 48 / HOUR_HEIGHT) })));
  const placementLabel = draft ? fmtTimeRange(draft.placement.startHour, draft.placement.durationHours) : '';
  const changedItem = draft?.item?.id;
  const clickBlocked = () => savingRef.current || Date.now() < suppressClickUntil.current;

  return <div className="relative">
    {draft && <div className="absolute inset-x-2 top-2 z-30 flex min-h-11 items-center justify-between gap-2 rounded-xl bg-indigo-700 px-3 text-xs font-semibold text-white shadow-lg" role="status">
      <span>{saving ? 'Saving…' : draft.mode === 'create' ? 'New block' : draft.mode === 'move' ? 'Move' : 'Resize'} · {placementLabel}</span>
      {!saving && <button type="button" onClick={() => cancelGesture.current()} className="min-h-11 px-1 text-xs underline">Cancel</button>}
    </div>}
    <div ref={scroller} className="mobile-day-scroll mobile-gesture-surface overflow-y-auto overscroll-contain rounded-2xl border border-slate-100 bg-white" aria-label="Day timeline"
      onClickCapture={event => { if (clickBlocked()) { event.preventDefault(); event.stopPropagation(); } }}>
      <div className="relative" style={{ height: 24 * HOUR_HEIGHT + 48 }}>
        {Array.from({ length: 24 }, (_, hour) => <div key={hour} className="absolute inset-x-0 flex" style={{ top: hour * HOUR_HEIGHT, height: HOUR_HEIGHT }}>
          <span className="w-14 shrink-0 pt-1 text-center text-[10px] font-medium text-slate-400">{fmtHourLabel(hour)}</span>
          <button data-calendar-slot onClick={() => onCreate(date, hour)} aria-label={`Add event on ${date} at ${fmtHourLabel(hour)}`} className="flex-1 border-t border-slate-100 text-left active:bg-indigo-50" />
        </div>)}
        <div className="pointer-events-none absolute inset-y-0 left-14 right-2">
          {timed.map(item => {
            const pos = positions.get(item.id)!;
            const active = item.id === changedItem;
            const start = active ? draft!.placement.startHour : item.start!;
            const duration = active ? draft!.placement.durationHours : item.minutes / 60;
            const editable = item.event && !item.event.locked && props.online;
            const height = Math.max(44, Math.min(24 - start, duration) * HOUR_HEIGHT - 3);
            return <div key={item.id} data-calendar-item={item.id}
              className={`pointer-events-auto absolute rounded-xl border-l-[3px] ${TONES[item.kind]} ${active ? 'z-20 shadow-xl ring-2 ring-indigo-500' : ''}`}
              style={{ top: start * HOUR_HEIGHT, height, left: `${pos.col / pos.cols * 100}%`, width: `calc(${100 / pos.cols}% - 3px)` }}>
              <button onClick={() => onOpen(item)} aria-label={`${item.title}, ${fmtTimeRange(start, duration)}`}
                className="h-full w-full overflow-hidden rounded-xl px-2 py-1 text-left active:brightness-95">
                <span className="block truncate text-xs font-semibold">{item.event?.locked && <Lock size={10} className="mr-1 inline" />}{item.title}</span>
                <span className="block truncate text-[10px] opacity-70">{fmtTimeRange(start, duration)}</span>
                {duration >= 1 && <span className="mt-1 block truncate text-[10px] opacity-60">{item.detail}</span>}
              </button>
              {editable && <>
                <button data-calendar-resize="start" aria-label={`Change start time of ${item.title}`} title="Hold and drag to change the start time"
                  onClick={() => onOpen(item)} className="absolute -top-2 right-0 flex h-11 w-11 items-start justify-end rounded-lg pr-1 pt-1 text-indigo-500"><span className="h-1.5 w-5 rounded-full border border-white bg-indigo-400" /></button>
                <button data-calendar-resize="end" aria-label={`Change duration of ${item.title}`} title="Hold and drag to extend or shorten"
                  onClick={() => onOpen(item)} className="absolute -bottom-2 left-0 flex h-11 w-11 items-end justify-start rounded-lg pb-1 pl-1 text-indigo-500"><span className="h-1.5 w-5 rounded-full border border-white bg-indigo-400" /></button>
              </>}
            </div>;
          })}
          {draft?.mode === 'create' && <div className="absolute inset-x-0 z-20 rounded-xl border-2 border-indigo-500 bg-indigo-100/90 px-2 py-1 text-xs font-semibold text-indigo-900 shadow-lg" style={{ top: draft.placement.startHour * HOUR_HEIGHT, height: Math.max(44, draft.placement.durationHours * HOUR_HEIGHT - 3) }}>New block<span className="block text-[10px]">{placementLabel}</span></div>}
          {date === today && <div aria-label="Current time" className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-rose-400" style={{ top: nowHour * HOUR_HEIGHT }}><span className="absolute -left-1 -top-1.5 h-2.5 w-2.5 rounded-full bg-rose-400" /></div>}
        </div>
      </div>
    </div>
    {error && <p role="alert" className="mt-2 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
    {undo && !saving && !draft && <div role="status" className="absolute inset-x-2 top-2 z-30 flex items-center justify-between gap-2 rounded-xl bg-indigo-50 px-3 text-xs text-indigo-800 shadow-md"><span>Block updated · {fmtTimeRange(undo.after.startHour, undo.after.durationHours)}</span><button disabled={!props.online} onClick={() => void save(undo.event, undo.after, undo.before, true)} className="flex min-h-11 shrink-0 items-center gap-1.5 px-2 font-semibold disabled:opacity-40"><Undo2 size={15} /> Undo</button></div>}
    <p className="mt-2 flex items-start gap-1 pr-16 text-xs leading-5 text-slate-400"><GripHorizontal size={14} className="mt-0.5 shrink-0" /><span>Hold to move or resize. Swipe for another day.</span></p>
  </div>;
}
