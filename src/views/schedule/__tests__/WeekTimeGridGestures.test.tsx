// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WeekTimeGrid } from '../WeekTimeGrid';
import type { DBEvent } from '../../../db/schema';

afterEach(cleanup);
const event = { id: 'event', title: 'Focus block', start_hour: 9, duration_hours: 1, locked: false } as DBEvent;
function setup(onEventChange?: (event: DBEvent, next: import('../../../utils/calendarGestures').CalendarPlacement) => Promise<void>) {
  const callbacks = { onSlotClick: vi.fn(), onEventClick: vi.fn(), onEventMove: vi.fn(), onEventResize: vi.fn() };
  render(<WeekTimeGrid days={['2026-09-28']} events={[{ event, date: '2026-09-28' }]} meetings={[]}
    linksByEvent={new Map()} workStart={9} workEnd={18} workDays={[1]} renderAllDayCell={() => null} onEventChange={onEventChange} {...callbacks} />);
  const block = screen.getByTitle('Focus block');
  const handle = screen.getByTitle('Drag to change how long this block runs');
  for (const node of [block, handle]) Object.defineProperty(node, 'setPointerCapture', { value: vi.fn() });
  return { ...callbacks, block, handle };
}
function pointer(target: HTMLElement, type: string, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
  fireEvent(target, event);
}

it('extends a block without opening its editor or creating another block', () => {
  const p = setup();
  pointer(p.handle, 'pointerdown', 200);
  pointer(p.handle, 'pointermove', 248);
  expect(p.onEventResize).not.toHaveBeenCalled();
  pointer(p.handle, 'pointerup', 248);
  fireEvent.click(p.handle);
  expect(p.onEventResize).toHaveBeenCalledExactlyOnceWith(event, 2);
  expect(p.onEventClick).not.toHaveBeenCalled();
  expect(p.onSlotClick).not.toHaveBeenCalled();
});

it('retains the resized placement during a slow save and restores it on failure', async () => {
  let reject!: (error: Error) => void;
  const save = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const p = setup(save);
  pointer(p.handle, 'pointerdown', 200); pointer(p.handle, 'pointermove', 248); pointer(p.handle, 'pointerup', 248);
  expect(save).toHaveBeenCalledExactlyOnceWith(event, { date: '2026-09-28', startHour: 9, durationHours: 2 });
  expect(screen.getByRole('button', { name: 'Focus block, 9 – 11 AM, saving' })).toBeInTheDocument();
  await act(async () => { reject(new Error('Connection lost')); });
  expect(screen.getByRole('button', { name: 'Focus block, 9 – 10 AM' })).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Connection lost');
  expect(p.onEventClick).not.toHaveBeenCalled();
});

it('resizes the start edge without changing the end', () => {
  const save = vi.fn().mockImplementation(() => new Promise<void>(() => {}));
  setup(save);
  const top = screen.getByTitle('Drag to change the start time');
  Object.defineProperty(top, 'setPointerCapture', { value: vi.fn() });
  pointer(top, 'pointerdown', 200); pointer(top, 'pointermove', 224); pointer(top, 'pointerup', 224);
  expect(save).toHaveBeenCalledExactlyOnceWith(event, { date: '2026-09-28', startHour: 9.5, durationHours: .5 });
});

it('draws a range without opening a second default-length draft on click', () => {
  const p = setup();
  const column = screen.getByLabelText('Time slots for 2026-09-28');
  Object.defineProperty(column, 'setPointerCapture', { value: vi.fn() });
  pointer(column, 'pointerdown', 432); pointer(column, 'pointermove', 504); pointer(column, 'pointerup', 504);
  fireEvent.click(column);
  expect(p.onSlotClick).toHaveBeenCalledExactlyOnceWith('2026-09-28', 9, 1.5);
});

it('draws backwards to the same range and allows ending exactly at midnight', () => {
  const p = setup();
  const column = screen.getByLabelText('Time slots for 2026-09-28');
  Object.defineProperty(column, 'setPointerCapture', { value: vi.fn() });
  pointer(column, 'pointerdown', 504); pointer(column, 'pointermove', 432); pointer(column, 'pointerup', 432);
  expect(p.onSlotClick).toHaveBeenLastCalledWith('2026-09-28', 9, 1.5);
  pointer(column, 'pointerdown', 1128); pointer(column, 'pointermove', 1152); pointer(column, 'pointerup', 1152);
  expect(p.onSlotClick).toHaveBeenLastCalledWith('2026-09-28', 23.5, .5);
});

it('does not save or open the editor when a resize handle is merely tapped', () => {
  const p = setup();
  pointer(p.handle, 'pointerdown', 200);
  pointer(p.handle, 'pointerup', 200);
  fireEvent.click(p.handle);
  expect(p.onEventResize).not.toHaveBeenCalled();
  expect(p.onEventClick).not.toHaveBeenCalled();
});

it('cancels an interrupted resize and still allows an intentional event click', () => {
  const p = setup();
  pointer(p.handle, 'pointerdown', 200);
  pointer(p.handle, 'pointermove', 248);
  pointer(p.handle, 'pointercancel', 248);
  pointer(p.handle, 'pointerup', 248);
  expect(p.onEventResize).not.toHaveBeenCalled();
  expect(p.onEventClick).not.toHaveBeenCalled();
  pointer(p.block, 'pointerdown', 150);
  pointer(p.block, 'pointerup', 150);
  expect(p.onEventClick).toHaveBeenCalledExactlyOnceWith(event);
});
