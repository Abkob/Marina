// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TimeView } from '../TimeView';
import type { TimeHeatmap } from '../../utils/timeHeatmap';

const state = vi.hoisted(() => ({
  data: undefined as TimeHeatmap | undefined, isError: false, refetch: vi.fn(), timer: null as { sessionId: string; startedAt: string } | null,
  previous: undefined as TimeHeatmap | undefined, previousError: false,
  nowMs: Date.parse('2026-09-27T12:00:00Z'), requestedYears: [] as number[],
}));
vi.mock('@tanstack/react-query', () => ({ useQueries: ({ queries }: { queries: { queryKey: unknown[] }[] }) => {
  state.requestedYears = queries.map(query => Number(query.queryKey[2]));
  return state.requestedYears.map(year => {
    const data = state.isError ? undefined : year === 2026 ? state.data : year === 2025 ? state.previous : { ...state.previous, year, days: [] };
    const isError = state.isError || (year === 2025 && state.previousError);
    return { data, isError, isPending: !data && !isError, refetch: state.refetch };
  });
} }));
vi.mock('../../api/hooks', () => ({ useSchedulePrefs: () => ({ data: { timezone: 'Asia/Beirut' } }) }));
vi.mock('../../hooks/useCloudWorkTimer', () => ({ useCloudWorkTimer: () => ({ nowMs: state.nowMs, timer: state.timer, error: null }) }));
beforeEach(() => {
  state.data = { year: 2026, timezone: 'Asia/Beirut', today: '2026-09-27', days: [{ date: '2026-09-26', minutes: 125, sessions: 2 }], loggedSessionIds: [] };
  state.previous = { ...state.data, year: 2025, days: [] };
  state.previousError = false; state.nowMs = Date.parse('2026-09-27T12:00:00Z');
  state.isError = false; state.timer = null; state.refetch.mockClear();
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  document.getElementById('time-responsive-test-style')?.remove();
});

it('opens near now at each width, with older months above and upcoming months below', () => {
  let width = 333;
  const style = document.createElement('style');
  style.id = 'time-responsive-test-style';
  style.textContent = '.time-months { --time-month-min: 144px; column-gap: 20px; }';
  document.head.appendChild(style);
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')?.get;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) {
    return this.classList.contains('time-months') ? width : clientWidth?.call(this) ?? 0;
  });
  // Give each actual grid row a height so the scroll position is observable.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const grid = this.closest<HTMLElement>('.time-months');
    const columns = Number(grid?.style.gridTemplateColumns.match(/repeat\((\d)/)?.[1] ?? 1);
    const index = grid ? [...grid.children].indexOf(this) : -1;
    return { top: index < 0 ? 0 : Math.floor(index / columns) * 250 } as DOMRect;
  });
  const { rerender } = render(<TimeView />);
  const timeline = screen.getByRole('region', { name: /Monthly timeline/ });
  const labels = () => screen.getAllByRole('group').map(group => group.getAttribute('aria-label'));
  const order = labels();
  expect(order.slice(11, 15)).toEqual(['August 2026', 'September 2026', 'October 2026', 'November 2026']);
  expect(timeline.scrollTop).toBe(6 * 250);
  expect(screen.queryByText('Swipe to see all three months')).not.toBeInTheDocument();
  expect(screen.getByRole('figure')).toHaveAccessibleName('Accounted time, Sep 2025 – Sep 2027');
  timeline.scrollTop = 3 * 250;
  state.nowMs += 60_000;
  state.data = { ...state.data!, days: [...state.data!.days] };
  rerender(<TimeView />);
  expect(timeline.scrollTop).toBe(3 * 250);
  fireEvent.click(screen.getByRole('button', { name: 'Return to current month' }));
  expect(timeline.scrollTop).toBe(6 * 250);
  width = 640;
  fireEvent(window, new Event('resize'));
  expect(timeline.scrollTop).toBe(4 * 250);
  expect(labels()).toEqual(order);
  width = 200;
  fireEvent(window, new Event('resize'));
  expect(timeline.scrollTop).toBe(11 * 250);
  expect(labels()).toEqual(order);
  expect(screen.getByText('2h 5m accounted for')).toBeInTheDocument();
});

it('renders chronological monthly matrices from saved time and lets touch reveal a day', () => {
  render(<TimeView />);
  expect(screen.getAllByRole('group')).toHaveLength(25);
  expect(screen.getAllByRole('group').slice(10, 16).map(group => group.getAttribute('aria-label'))).toEqual([
    'July 2026', 'August 2026', 'September 2026', 'October 2026', 'November 2026', 'December 2026',
  ]);
  const square = screen.getByRole('button', { name: 'Saturday, September 26, 2026: 2h 5m' });
  expect(square).toHaveAttribute('data-level', '3');
  fireEvent.click(square);
  expect(square).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('2 sessions')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Monday, September 28, 2026: Future day' })).toHaveAttribute('data-future', 'true');
});
it('keeps the matrix keyboard navigable without hundreds of tab stops', () => {
  render(<TimeView />);
  const september = screen.getByRole('group', { name: 'September 2026' });
  expect(within(september).getAllByRole('button').filter(button => button.tabIndex === 0)).toHaveLength(1);
  const today = screen.getByRole('button', { name: 'Sunday, September 27, 2026: No time logged' });
  today.focus(); fireEvent.keyDown(today, { key: 'ArrowUp' });
  expect(document.activeElement).toHaveAttribute('data-date', '2026-09-26');
});
it('includes the actual running timer without starting or stopping it', () => {
  state.timer = { sessionId: 'live', startedAt: '2026-09-27T11:30:00Z' };
  render(<TimeView />);
  expect(screen.getByRole('button', { name: 'Sunday, September 27, 2026: 30m, timer running' })).toHaveAttribute('data-live', 'true');
  expect(screen.getByText('Timer running')).toBeInTheDocument();
});
it('offers a visible retry instead of treating a failed read as zero work', () => {
  state.data = undefined; state.isError = true; render(<TimeView />);
  expect(screen.getByText('Your time could not be loaded.')).toBeInTheDocument();
  expect(screen.queryByText('No time recorded in these months yet.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(state.refetch).toHaveBeenCalledTimes(3);
});
it('includes the preceding year and counts only months in the rolling window', () => {
  state.previous!.days = [{ date: '2025-10-10', minutes: 60, sessions: 1 }, { date: '2025-08-10', minutes: 400, sessions: 1 }];
  render(<TimeView />);
  expect(state.requestedYears).toEqual([2025, 2026, 2027]);
  expect(screen.getByText('3h 5m accounted for')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Friday, October 10, 2025: 1h' })).toHaveAttribute('data-level', '2');
  expect(screen.getByRole('figure')).toHaveAccessibleName('Accounted time, Sep 2025 – Sep 2027');
});
it('does not show missing previous-year data as empty days or a complete total', () => {
  state.previous = undefined; state.previousError = true;
  render(<TimeView />);
  expect(screen.getByText('Time unavailable')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Friday, October 10, 2025: Time unavailable' })).toBeInTheDocument();
  expect(screen.queryByText('2h 5m accounted for')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(state.refetch).toHaveBeenCalledOnce();
});
it('moves the default position forward when the workspace enters the next month', () => {
  const { rerender } = render(<TimeView />);
  fireEvent.click(screen.getByRole('button', { name: 'Wednesday, September 10, 2025: No time logged' }));
  // Midnight in Beirut, while it is still September in UTC.
  state.nowMs = Date.parse('2026-09-30T21:00:00Z');
  rerender(<TimeView />);
  expect(screen.getAllByRole('group').slice(10, 15).map(group => group.getAttribute('aria-label'))).toEqual(['August 2026', 'September 2026', 'October 2026', 'November 2026', 'December 2026']);
  expect(screen.queryByRole('group', { name: 'September 2025' })).not.toBeInTheDocument();
  expect(screen.getByRole('figure')).toHaveAccessibleName('Accounted time, Oct 2025 – Oct 2027');
  expect(screen.getByText('Oct 1 · Today')).toBeInTheDocument();
});
it('offers a discreet day breakdown with linked calendar and miscellaneous time', () => {
  state.data!.days = [{ date: '2026-09-26', minutes: 90, sessions: 0, calendarMinutes: 90, details: [
    { key: 'linked', title: 'Study block', taskId: 'quiz', taskTitle: 'Quiz 1', goalTitle: 'Biology', source: 'calendar', minutes: 60 },
    { key: 'misc', title: 'Errands', source: 'calendar', minutes: 30 },
  ] }];
  render(<TimeView />);
  fireEvent.click(screen.getByRole('button', { name: 'Saturday, September 26, 2026: 1h 30m' }));
  const details = screen.getByText('Day breakdown').closest('details')!;
  expect(details).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('Day breakdown'));
  expect(details).toHaveAttribute('open');
  expect(screen.getByText('Quiz 1 · Biology')).toBeVisible();
  expect(screen.getByText('Miscellaneous')).toBeVisible();
  expect(screen.getByText('1h 30m from calendar')).toBeInTheDocument();
  const hover = new Event('pointerover', { bubbles: true });
  Object.defineProperty(hover, 'pointerType', { value: 'mouse' });
  fireEvent(screen.getByRole('button', { name: 'Monday, September 28, 2026: Future day' }), hover);
  expect(screen.getByText('Ahead of you')).toBeInTheDocument();
  expect(screen.getByText('Quiz 1 · Biology')).toBeVisible();
  expect(screen.getByRole('list', { name: 'Time breakdown for Saturday, September 26, 2026' })).toBeInTheDocument();
});
it('supports previous years and keeps following now after returning to the current month', () => {
  const { rerender } = render(<TimeView />); expect(screen.getByRole('button', { name: 'Next year' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Previous year' }));
  expect(screen.getByRole('heading', { name: '2025' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Return to current month' }));
  expect(screen.getByRole('heading', { name: '2026' })).toBeInTheDocument();
  state.nowMs = Date.parse('2026-12-31T22:00:00Z');
  rerender(<TimeView />);
  expect(screen.getByRole('heading', { name: '2027' })).toBeInTheDocument();
  expect(screen.getByText('Jan 1 · Today')).toBeInTheDocument();
});
