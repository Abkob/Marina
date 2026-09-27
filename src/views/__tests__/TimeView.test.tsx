// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TimeView } from '../TimeView';
import type { TimeHeatmap } from '../../utils/timeHeatmap';

const state = vi.hoisted(() => ({
  data: undefined as TimeHeatmap | undefined, isError: false, refetch: vi.fn(), timer: null as { sessionId: string; startedAt: string } | null,
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: state.data, isError: state.isError, isPending: !state.data && !state.isError, refetch: state.refetch }) }));
vi.mock('../../api/hooks', () => ({ useSchedulePrefs: () => ({ data: { timezone: 'Asia/Beirut' } }) }));
vi.mock('../../hooks/useCloudWorkTimer', () => ({ useCloudWorkTimer: () => ({ nowMs: Date.parse('2026-09-27T12:00:00Z'), timer: state.timer, error: null }) }));
beforeEach(() => {
  state.data = { year: 2026, timezone: 'Asia/Beirut', today: '2026-09-27', days: [{ date: '2026-09-26', minutes: 125, sessions: 2 }], loggedSessionIds: [] };
  state.isError = false; state.timer = null; state.refetch.mockClear();
});
afterEach(cleanup);

it('renders twelve monthly matrices from saved time and lets touch reveal a day', () => {
  render(<TimeView />);
  expect(screen.getAllByRole('group')).toHaveLength(12);
  const square = screen.getByRole('button', { name: 'Saturday, September 26, 2026: 2h 5m' });
  expect(square).toHaveAttribute('data-level', '3');
  fireEvent.click(square);
  expect(square).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('2 sessions')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Monday, September 28, 2026: Future day' })).toHaveAttribute('data-future', 'true');
});
it('keeps the matrix keyboard navigable without hundreds of tab stops', () => {
  render(<TimeView />);
  const september = screen.getByRole('group', { name: 'September' });
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
  expect(screen.queryByText('No time logged this year yet.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(state.refetch).toHaveBeenCalledOnce();
});
it('supports previous years and returning to the current year', () => {
  render(<TimeView />); expect(screen.getByRole('button', { name: 'Next year' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Previous year' }));
  expect(screen.getByRole('heading', { name: '2025' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Return to this year' }));
  expect(screen.getByRole('heading', { name: '2026' })).toBeInTheDocument();
});
