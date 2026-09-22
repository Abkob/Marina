// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DBGoal } from '../../../db/schema';
import type { DBRoutine, DBRoutineEntry } from '../../../types/routines';
import { RoutinesPanel } from '../RoutinesPanel';

const mocks = vi.hoisted(() => ({
  routines: { data: [] as DBRoutine[], isPending: false, isError: false, refetch: vi.fn() },
  entries: { data: [] as DBRoutineEntry[], isPending: false, isError: false, refetch: vi.fn() },
  checkIn: { mutateAsync: vi.fn(), isPending: false },
  archive: { mutateAsync: vi.fn(), isPending: false },
  entryQuery: vi.fn(),
}));
vi.mock('../../../api/routines', () => ({
  useRoutines: () => mocks.routines,
  useRoutineEntries: (...args: unknown[]) => { mocks.entryQuery(...args); return mocks.entries; },
  useRoutineCheckIn: () => mocks.checkIn,
  useArchiveRoutine: () => mocks.archive,
}));

const today = '2026-09-22';
const routine: DBRoutine = {
  id: 'revision', title: 'Physics revision', note: 'Recall the key equations.', goal_id: 'physics',
  cadence: 'daily', weekdays: [1, 2, 3, 4, 5], weekly_target: 5, target_count: 20,
  target_unit: 'minutes', planned_minutes: 20, preferred_time: null, start_date: '2026-09-01',
  archived_at: null, created_at: '2026-09-01T08:00:00Z', updated_at: '2026-09-01T08:00:00Z',
};
const entry = (date: string, status: DBRoutineEntry['status'] = 'completed'): DBRoutineEntry => ({
  id: `${routine.id}-${date}`, routine_id: routine.id, date, status, minutes: 12,
  completed_count: status === 'completed' ? 20 : 0, notes: '', created_at: '', updated_at: '',
});
const goals = [{ id: 'physics', title: 'Physics 210' }] as DBGoal[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.routines.data = [routine];
  mocks.routines.isError = false;
  mocks.routines.isPending = false;
  mocks.entries.data = [];
  mocks.entries.isError = false;
  mocks.entries.isPending = false;
  mocks.checkIn.isPending = false;
  mocks.checkIn.mutateAsync.mockResolvedValue(null);
  mocks.archive.mutateAsync.mockResolvedValue(null);
});

function panel(date = today) {
  const onCreate = vi.fn();
  const onStartFocus = vi.fn();
  render(<RoutinesPanel date={date} today={today} goals={goals} onCreate={onCreate} onStartFocus={onStartFocus} />);
  return { onCreate, onStartFocus };
}

describe('RoutinesPanel', () => {
  it('shows a compact target, goal, weekly count and starts the chosen routine', async () => {
    const user = userEvent.setup();
    mocks.entries.data = [entry('2026-09-21')];
    const { onStartFocus } = panel();
    expect(screen.getByText('Today’s routines')).toBeInTheDocument();
    expect(screen.getByText('20 min')).toBeInTheDocument();
    expect(screen.getByText('Physics 210')).toBeInTheDocument();
    expect(screen.getByText('1 of 5 sessions this week')).toBeInTheDocument();
    expect(mocks.entryQuery).toHaveBeenCalledWith('2026-09-21', '2026-09-27');
    await user.click(screen.getByRole('button', { name: 'Start focus' }));
    expect(onStartFocus).toHaveBeenCalledWith(routine, today);
  });

  it('records done or an explicit skip without making a focus session', async () => {
    const user = userEvent.setup();
    const { onStartFocus } = panel();
    await user.click(screen.getByRole('button', { name: 'Done today' }));
    expect(mocks.checkIn.mutateAsync).toHaveBeenLastCalledWith({ routineId: routine.id, date: today, status: 'completed' });
    await user.click(screen.getByRole('button', { name: 'Skip today' }));
    expect(mocks.checkIn.mutateAsync).toHaveBeenLastCalledWith({ routineId: routine.id, date: today, status: 'skipped' });
    expect(onStartFocus).not.toHaveBeenCalled();
  });

  it('keeps a completed weekly session visible for Undo even when its quota is met', async () => {
    const user = userEvent.setup();
    mocks.routines.data = [{ ...routine, cadence: 'weekly', weekly_target: 1 }];
    mocks.entries.data = [entry(today)];
    panel();
    expect(screen.getByText('1 of 1 sessions this week')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(mocks.checkIn.mutateAsync).toHaveBeenCalledWith({ routineId: routine.id, date: today, status: 'pending' });
  });

  it('does not pile up missed days or show an already-met weekly quota again', () => {
    mocks.routines.data = [{ ...routine, cadence: 'weekly', weekly_target: 1 }];
    mocks.entries.data = [entry('2026-09-21')];
    panel();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing to do for this day/)).toBeInTheDocument();
  });

  it('hides additional rows until asked and keeps management collapsed', async () => {
    const user = userEvent.setup();
    mocks.routines.data = Array.from({ length: 5 }, (_, index) => ({ ...routine, id: `routine-${index}`, title: `Routine ${index}` }));
    panel();
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all 5 routines' }));
    expect(screen.getAllByRole('article')).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'Manage routines' }));
    expect(screen.getAllByRole('button', { name: 'Archive' })).toHaveLength(5);
    await user.click(screen.getAllByRole('button', { name: 'Archive' })[0]);
    expect(mocks.archive.mutateAsync).toHaveBeenCalledWith({ routineId: 'routine-0', archived: true });
  });

  it('shows a clear loading or error state rather than pretending the list is empty', async () => {
    const user = userEvent.setup();
    mocks.routines.isError = true;
    panel();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load your routines');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.routines.refetch).toHaveBeenCalled();
    expect(mocks.entries.refetch).toHaveBeenCalled();
  });

  it('keeps write errors visible and does not mark a failed check-in as done', async () => {
    const user = userEvent.setup();
    mocks.checkIn.mutateAsync.mockRejectedValue(new Error('Connection interrupted'));
    panel();
    await user.click(screen.getByRole('button', { name: 'Done today' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Connection interrupted');
    expect(screen.getByRole('button', { name: 'Done today' })).toBeInTheDocument();
  });

  it('shows a future routine without allowing it to be logged as already done', () => {
    panel('2026-09-23');
    expect(screen.getByRole('article')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start focus' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Done today|Mark done/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip day' })).not.toBeInTheDocument();
  });

  it('preserves archived routines in management without offering unsafe retroactive resume', async () => {
    const user = userEvent.setup();
    mocks.routines.data = [{ ...routine, archived_at: '2026-09-21T08:00:00Z' }];
    panel();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Manage routines' }));
    expect(within(screen.getByRole('list')).getByText('Physics revision')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });
});
