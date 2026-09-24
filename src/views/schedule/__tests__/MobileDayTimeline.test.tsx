// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileDayTimeline } from '../MobileDayTimeline';
import { CALENDAR_HOLD_MS } from '../../../utils/calendarGestures';
import type { DBEvent } from '../../../db/schema';

const event = { id: 'event', title: 'Focus block', start_hour: 9, duration_hours: 1, locked: false } as DBEvent;
function props(locked = false) {
  const ev = { ...event, locked };
  return { date: '2026-09-24', today: '2026-09-24', nowHour: 9, online: true,
    items: [{ id: 'event:event', title: ev.title, kind: 'event' as const, date: '2026-09-24', start: 9, minutes: 60, detail: 'Focus', event: ev }],
    onOpen: vi.fn(), onCreate: vi.fn(), onChangeEvent: vi.fn().mockResolvedValue(undefined), onSwipe: vi.fn(),
  };
}
const point = (x: number, y: number, identifier = 1) => ({ identifier, clientX: x, clientY: y });
const start = (el: HTMLElement, x = 120, y = 150) => fireEvent.touchStart(el, { touches: [point(x, y)], changedTouches: [point(x, y)] });
const move = (el: HTMLElement, x: number, y: number) => fireEvent.touchMove(el, { touches: [point(x, y)], changedTouches: [point(x, y)], cancelable: true });
const end = (el: HTMLElement, x: number, y: number) => fireEvent.touchEnd(el, { touches: [], changedTouches: [point(x, y)], cancelable: true });
const hold = () => act(() => vi.advanceTimersByTime(CALENDAR_HOLD_MS));
const block = () => screen.getByRole('button', { name: /^Focus block,/ });
async function settle() { await act(async () => { await Promise.resolve(); }); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 100, top: 100, bottom: 500, left: 0, right: 350, width: 350, height: 400, toJSON() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('finger gestures in the day calendar', () => {
  it('keeps a normal tap as the event editor', () => {
    const p = props(); render(<MobileDayTimeline {...p} />);
    start(block()); end(block(), 120, 150); fireEvent.click(block());
    expect(p.onOpen).toHaveBeenCalled(); expect(p.onChangeEvent).not.toHaveBeenCalled();
  });
  it('does not round an existing unusual time merely because it was held', () => {
    const p = props();
    p.items[0] = { ...p.items[0], start: 9 + 5 / 60, minutes: 20 };
    render(<MobileDayTimeline {...p} />);
    start(block()); hold(); end(block(), 120, 150);
    expect(p.onChangeEvent).not.toHaveBeenCalled();
  });
  it('lets vertical scrolling cancel a pending hold', () => {
    const p = props(); render(<MobileDayTimeline {...p} />);
    start(block());
    expect(move(block(), 120, 170)).toBe(true); // Default scrolling remains allowed.
    hold(); end(block(), 120, 220);
    expect(p.onChangeEvent).not.toHaveBeenCalled(); expect(p.onSwipe).not.toHaveBeenCalled();
  });
  it('moves only on release, prevents scroll after the hold, and provides Undo', async () => {
    const p = props(); render(<MobileDayTimeline {...p} />);
    start(block()); hold();
    expect(move(block(), 120, 222)).toBe(false);
    expect(p.onChangeEvent).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('10 – 11 AM');
    end(block(), 120, 222); await settle();
    expect(p.onChangeEvent).toHaveBeenCalledWith(event, { date: p.date, startHour: 10, durationHours: 1 });
    fireEvent.click(block()); expect(p.onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' })); await settle();
    expect(p.onChangeEvent).toHaveBeenLastCalledWith(event, { date: p.date, startHour: 9, durationHours: 1 });
  });
  it('extends the end or changes the start using the edge handles', async () => {
    const p = props(); render(<MobileDayTimeline {...p} />);
    const bottom = screen.getByRole('button', { name: 'Change duration of Focus block' });
    start(bottom); hold(); move(bottom, 120, 186); end(bottom, 120, 186); await settle();
    expect(p.onChangeEvent).toHaveBeenLastCalledWith(event, { date: p.date, startHour: 9, durationHours: 1.5 });
    const top = screen.getByRole('button', { name: 'Change start time of Focus block' });
    start(top); hold(); move(top, 120, 168); end(top, 120, 168); await settle();
    expect(p.onChangeEvent).toHaveBeenLastCalledWith(event, { date: p.date, startHour: 9.25, durationHours: 0.75 });
  });
  it('does not save on interruption, Escape or a second finger', () => {
    const p = props(); render(<MobileDayTimeline {...p} />);
    start(block()); hold(); move(block(), 120, 222); fireEvent.touchCancel(block());
    expect(p.onChangeEvent).not.toHaveBeenCalled();
    start(block()); hold(); move(block(), 120, 222); fireEvent.keyDown(window, { key: 'Escape' }); end(block(), 120, 222);
    expect(p.onChangeEvent).not.toHaveBeenCalled();
    start(block()); hold(); move(block(), 120, 222);
    fireEvent.touchStart(document.body, { touches: [point(120, 222), point(200, 200, 2)] });
    end(block(), 120, 222); expect(p.onChangeEvent).not.toHaveBeenCalled();
  });
  it('leaves locked events fixed', () => {
    const p = props(true); render(<MobileDayTimeline {...p} />);
    start(block()); hold(); move(block(), 120, 222); end(block(), 120, 222);
    expect(screen.queryByRole('button', { name: 'Change duration of Focus block' })).not.toBeInTheDocument();
    expect(p.onChangeEvent).not.toHaveBeenCalled();
  });
  it('restores the original time on a failed save', async () => {
    const p = props(); p.onChangeEvent.mockRejectedValue(new Error('Could not save this change.'));
    render(<MobileDayTimeline {...p} />);
    start(block()); hold(); move(block(), 120, 222); end(block(), 120, 222); await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save this change.');
    expect(block()).toHaveAccessibleName('Focus block, 9 – 10 AM');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });
  it('swipes between days without editing the event', () => {
    const p = props(); render(<MobileDayTimeline {...p} />);
    start(block(), 220, 150); move(block(), 100, 155); end(block(), 100, 155);
    expect(p.onSwipe).toHaveBeenCalledWith(1); expect(p.onChangeEvent).not.toHaveBeenCalled();
  });
  it('holds and drags empty time to open a prefilled block', () => {
    const p = props(); render(<MobileDayTimeline {...p} />);
    const timeline = screen.getByLabelText('Day timeline'); timeline.scrollTop = 0;
    const slot = screen.getByRole('button', { name: `Add event on ${p.date} at 2 AM` });
    start(slot, 120, 244); hold(); move(slot, 120, 316); end(slot, 120, 316);
    expect(p.onCreate).toHaveBeenCalledWith(p.date, 2, 1); expect(p.onChangeEvent).not.toHaveBeenCalled();
  });
});
