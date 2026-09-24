// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileSchedule } from '../MobileSchedule';
import type { DBEvent, DBTask } from '../../../db/schema';
const store = vi.hoisted(() => ({ navigateToGoal: vi.fn(), openCompletionReport: vi.fn() }));
vi.mock('../../../store/useAppStore', () => ({ useAppStore: () => store }));

const date = '2026-09-24';
const event = { id: 'event', title: 'Design session', start_hour: 9, duration_hours: 1, type: 'Focus' } as DBEvent;
const task = { id: 'task', title: 'Read chapter', start_date: date, estimated_minutes: 30, status: 'todo', completed: false } as DBTask;
function props() {
  return { date, today: date, now: new Date('2026-09-24T06:30:00Z'), timezone: 'Asia/Beirut',
    days: ['2026-09-21', '2026-09-22', '2026-09-23', date, '2026-09-25', '2026-09-26', '2026-09-27'],
    events: [{ date, event }], meetings: [], tasks: [task], previewByDate: new Map(), assignmentsByDate: new Map(), blockedTaskIds: new Set<string>(),
    loading: false, refreshing: false, error: false,
    onDate: vi.fn(), onRefresh: vi.fn().mockResolvedValue(undefined), onCreate: vi.fn(), onEdit: vi.fn(), onAddTask: vi.fn(), onScheduleTask: vi.fn(), onStartFocus: vi.fn(), onMoveTask: vi.fn().mockResolvedValue(undefined), onChangeEvent: vi.fn().mockResolvedValue(undefined), renderRoutines: () => null,
  };
}
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('phone calendar interactions', () => {
  it('remembers compact controls and Day view after leaving and reopening Schedule', () => {
    const first = render(<MobileSchedule {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize calendar controls' }));
    expect(screen.queryByLabelText('Week dates')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    first.unmount();
    render(<MobileSchedule {...props()} />);
    expect(screen.getByRole('button', { name: 'Expand calendar controls' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }));
    expect(screen.getByLabelText('Month date picker')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand calendar controls' }));
    expect(screen.getByLabelText('Week dates')).toBeInTheDocument();
  });
  it('starts compact on a small iPhone while honoring a saved expanded preference', () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(max-width: 389px)', addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const first = render(<MobileSchedule {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand calendar controls' }));
    first.unmount();
    render(<MobileSchedule {...props()} />);
    expect(screen.getByLabelText('Week dates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Minimize calendar controls' })).toHaveAttribute('aria-pressed', 'false');
  });
  it('attaches day swipes after loading and restores week swipes after closing the month picker', () => {
    const p = props();
    const { rerender } = render(<MobileSchedule {...p} loading />);
    rerender(<MobileSchedule {...p} />);
    const swipe = (element: HTMLElement) => {
      fireEvent.touchStart(element, { touches: [{ clientX: 250, clientY: 100 }] });
      fireEvent.touchMove(element, { touches: [{ clientX: 140, clientY: 103 }] });
      fireEvent.touchEnd(element, { changedTouches: [{ clientX: 140, clientY: 103 }] });
    };
    swipe(screen.getByLabelText('Schedule agenda'));
    expect(p.onDate).toHaveBeenLastCalledWith('2026-09-25');
    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }));
    swipe(screen.getByLabelText('Month date picker'));
    expect(screen.getByLabelText('Month date picker')).toHaveTextContent('October 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }));
    swipe(screen.getByLabelText('Week dates'));
    expect(p.onDate).toHaveBeenLastCalledWith('2026-10-01');
  });
  it('navigates across weeks, jumps to dates and opens existing events', () => {
    const p = props(); render(<MobileSchedule {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /Design session/ }));
    expect(p.onEdit).toHaveBeenCalledWith(event);
    fireEvent.click(screen.getByLabelText('Next week'));
    expect(p.onDate).toHaveBeenCalledWith('2026-10-01');
    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }));
    fireEvent.change(screen.getByLabelText('Jump to date'), { target: { value: '2027-01-03' } });
    expect(p.onDate).toHaveBeenCalledWith('2027-01-03');
  });
  it('adds at a tapped hour and exposes the live current-time marker', () => {
    const p = props(); render(<MobileSchedule {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    fireEvent.click(screen.getByRole('button', { name: `Add event on ${date} at 12 AM` }));
    expect(p.onCreate).toHaveBeenCalledWith(date, 0);
    expect(screen.getByLabelText('Current time')).toHaveStyle({ top: '684px' });
  });
  it('saves task moves and retains the dialog with an error if saving fails', async () => {
    const p = props(); p.onMoveTask.mockRejectedValueOnce(new Error('Connection lost'));
    render(<MobileSchedule {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /Read chapter/ }));
    fireEvent.change(screen.getByLabelText('Move task to date'), { target: { value: '2026-09-29' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move task' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(p.onMoveTask).toHaveBeenLastCalledWith('task', '2026-09-29');
  });
  it('uses the existing task completion workflow', () => {
    render(<MobileSchedule {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /Read chapter/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete task' }));
    expect(store.openCompletionReport).toHaveBeenCalledWith('task');
  });
  it('shows an error instead of claiming a failed schedule is empty', () => {
    render(<MobileSchedule {...props()} tasks={[]} events={[]} error />);
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load the latest schedule');
    expect(screen.queryByText('Nothing scheduled')).not.toBeInTheDocument();
  });
  it('keeps adjacent short timeline events in separate touch targets', () => {
    const p = props();
    render(<MobileSchedule {...p} events={[
      { date, event: { ...event, id: 'a', title: 'First short event', start_hour: 9, duration_hours: 0.25 } },
      { date, event: { ...event, id: 'b', title: 'Second short event', start_hour: 9.25, duration_hours: 0.25 } },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    const a = screen.getByRole('button', { name: /^First short event,/ }).parentElement!;
    const b = screen.getByRole('button', { name: /^Second short event,/ }).parentElement!;
    expect(a.style.height).toBe('44px');
    expect(a.style.width).toBe('calc(50% - 3px)');
    expect(a.style.left).not.toBe(b.style.left);
  });
});
