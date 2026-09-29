// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ScheduleToolbar } from '../ScheduleToolbar';
import { ScheduleMonthView } from '../ScheduleMonthView';
import { WeekTimeGrid } from '../WeekTimeGrid';
import { monthDates, navigateCalendar } from '../../../utils/calendarView';
import type { DBEvent, DBTask } from '../../../db/schema';

afterEach(cleanup);
it('navigates days, weeks and months correctly across year and leap-day boundaries', () => {
  expect(navigateCalendar('2026-12-31', 'day', 1)).toBe('2027-01-01');
  expect(navigateCalendar('2026-12-31', 'week', 1)).toBe('2027-01-07');
  expect(navigateCalendar('2026-01-31', 'month', 1)).toBe('2026-02-28');
  expect(navigateCalendar('2028-03-31', 'month', -1)).toBe('2028-02-29');
  const days = monthDates('2026-09-29');
  expect(days).toHaveLength(42);
  expect(days[0]).toBe('2026-08-31');
  expect(days[41]).toBe('2026-10-11');
});
it('makes date navigation follow the chosen view and shows Today only when away', () => {
  const p = { date: '2026-09-29', today: '2026-09-29', planning: false, onDate: vi.fn(), onView: vi.fn(), onPlan: vi.fn(), onCreate: vi.fn() };
  const { rerender } = render(<ScheduleToolbar {...p} view="week" />);
  expect(screen.queryByRole('button', { name: 'Today' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  expect(p.onDate).toHaveBeenLastCalledWith('2026-10-06');
  fireEvent.change(screen.getByRole('combobox', { name: 'Calendar view' }), { target: { value: 'month' } });
  expect(p.onView).toHaveBeenLastCalledWith('month');
  rerender(<ScheduleToolbar {...p} date="2026-10-31" view="month" />);
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect(p.onDate).toHaveBeenLastCalledWith('2026-11-30');
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  expect(p.onDate).toHaveBeenLastCalledWith(p.today);
});
it('shows actual month events including adjacent months and opens the correct date or event', () => {
  const event = { id: 'block', title: 'Study session', start_hour: 10, duration_hours: 1 } as DBEvent;
  const onDate = vi.fn(), onEvent = vi.fn();
  render(<ScheduleMonthView days={monthDates('2026-09-29')} date="2026-09-29" today="2026-09-29" events={[{ event, date: '2026-10-01' }]}
    meetings={[]} tasksByDate={new Map([['2026-10-01', [{ id: 'task', title: 'Study task' } as DBTask]]])}
    blockedTaskIds={new Set(['task|2026-10-01'])} previewByDate={new Map()} onDate={onDate} onEvent={onEvent} />);
  expect(screen.queryByText('Study task')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Study session/ }));
  expect(onEvent).toHaveBeenCalledWith(event);
  fireEvent.click(screen.getByRole('button', { name: 'Open Thursday, October 1, 2026' }));
  expect(onDate).toHaveBeenCalledWith('2026-10-01');
});
it('uses one full-width column for Day and hides an empty all-day row', () => {
  const { container } = render(<WeekTimeGrid days={['2026-10-04']} events={[]} meetings={[]} linksByEvent={new Map()} workStart={9} workEnd={18} workDays={[7]}
    showAllDay={false} renderAllDayCell={() => null} onSlotClick={vi.fn()} onEventClick={vi.fn()} onEventMove={vi.fn()} onEventResize={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Show all-day details' })).not.toBeInTheDocument();
  expect(container.querySelector('[style*="grid-template-columns"]')).toHaveStyle({ gridTemplateColumns: '52px repeat(1, minmax(0, 1fr))' });
  expect(screen.getAllByLabelText(/Time slots for/)).toHaveLength(1);
  expect(screen.getByLabelText('Time slots for 2026-10-04')).not.toHaveClass('bg-gray-50/70');
});
