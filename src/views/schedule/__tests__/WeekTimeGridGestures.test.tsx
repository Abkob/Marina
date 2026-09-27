// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WeekTimeGrid } from '../WeekTimeGrid';
import type { DBEvent } from '../../../db/schema';

afterEach(cleanup);
const event = { id: 'event', title: 'Focus block', start_hour: 9, duration_hours: 1, locked: false } as DBEvent;
function setup() {
  const callbacks = { onSlotClick: vi.fn(), onEventClick: vi.fn(), onEventMove: vi.fn(), onEventResize: vi.fn() };
  render(<WeekTimeGrid days={['2026-09-28']} events={[{ event, date: '2026-09-28' }]} meetings={[]}
    linksByEvent={new Map()} workStart={9} workEnd={18} workDays={[1]} renderAllDayCell={() => null} {...callbacks} />);
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
