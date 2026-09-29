// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DBRoutine, DBRoutineEntry } from '../../../types/routines';
import { RoutinesPanel } from '../RoutinesPanel';
const mocks = vi.hoisted(() => ({ routines: { data: [] as DBRoutine[], isPending: false, isError: false, refetch: vi.fn() }, entries: { data: [] as DBRoutineEntry[], isPending: false, isError: false, refetch: vi.fn() }, checkIn: { mutateAsync: vi.fn(), isPending: false }, archive: { mutateAsync: vi.fn(), isPending: false } }));
vi.mock('../../../api/routines', () => ({ useRoutines: () => mocks.routines, useRoutineEntries: () => mocks.entries, useRoutineCheckIn: () => mocks.checkIn, useArchiveRoutine: () => mocks.archive }));
const today = '2026-09-22';
const routine: DBRoutine = { id: 'routine', title: 'Biology revision', note: '', goal_id: null, cadence: 'weekly', weekdays: [1, 2, 3, 4, 5], weekly_target: 3, planned_minutes: 45, target_count: 45, target_unit: 'minutes', preferred_time: null, start_date: '2026-09-01', archived_at: null, created_at: '', updated_at: '' };
const entry = { id: 'entry', routine_id: routine.id, date: today, status: 'completed', minutes: 45, completed_count: 45, notes: '', created_at: '', updated_at: '' } as DBRoutineEntry;
beforeEach(() => { vi.clearAllMocks(); mocks.routines.data = [routine]; mocks.entries.data = []; mocks.routines.isError = false; mocks.checkIn.mutateAsync.mockResolvedValue(null); mocks.archive.mutateAsync.mockResolvedValue(null); });
function panel(date = today) { const onStartFocus = vi.fn(), onEdit = vi.fn(); render(<RoutinesPanel date={date} today={today} goals={[]} onCreate={vi.fn()} onEdit={onEdit} onStartFocus={onStartFocus} />); return { onStartFocus, onEdit }; }
async function options() { await userEvent.click(screen.getByRole('button', { name: 'Options for Biology revision' })); }
describe('repeating time overview', () => {
  it('shows weekly hours and starts the selected routine with quiet controls', async () => {
    const { onStartFocus } = panel();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '0 min logged of 2h 15m planned');
    expect(screen.queryByRole('button', { name: 'Finish session' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start focus for Biology revision' }));
    expect(onStartFocus).toHaveBeenCalledWith(routine, today);
  });
  it('keeps the routine visible after the weekly target is reached without inventing time', () => {
    mocks.routines.data = [{ ...routine, weekly_target: 1 }]; mocks.entries.data = [{ ...entry, date: '2026-09-21', minutes: 0 }]; panel();
    expect(screen.getByRole('article')).toBeInTheDocument();
    expect(screen.getByText('1/1 sessions')).toBeInTheDocument(); expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
  });
  it('finishes and skips only the selected session', async () => {
    panel(); await options(); await userEvent.click(screen.getByRole('button', { name: 'Finish session' }));
    expect(mocks.checkIn.mutateAsync).toHaveBeenLastCalledWith({ routineId: routine.id, date: today, status: 'completed' });
    await options(); await userEvent.click(screen.getByRole('button', { name: 'Skip this session' }));
    expect(mocks.checkIn.mutateAsync).toHaveBeenLastCalledWith({ routineId: routine.id, date: today, status: 'skipped' });
  });
  it('supports an explicit future skip but prevents future finish and timer start', async () => {
    panel(); await userEvent.click(screen.getByRole('button', { name: 'Wednesday, Sep 23' })); await options();
    expect(screen.queryByRole('button', { name: 'Finish session' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start focus/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Skip this session' }));
    expect(mocks.checkIn.mutateAsync).toHaveBeenCalledWith({ routineId: routine.id, date: '2026-09-23', status: 'skipped' });
  });
  it('opens repeat editing with the complete original routine', async () => {
    const { onEdit } = panel(); await options(); await userEvent.click(screen.getByRole('button', { name: 'Edit repeat schedule' })); expect(onEdit).toHaveBeenCalledWith(routine);
  });
  it('undoes finish without deleting logged time and retains archived history', async () => {
    mocks.entries.data = [entry]; panel(); await options(); await userEvent.click(screen.getByRole('button', { name: 'Undo finish' }));
    expect(mocks.checkIn.mutateAsync).toHaveBeenCalledWith({ routineId: routine.id, date: today, status: 'pending' });
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '45');
  });
  it('does not offer mutations on stopped routines but shows their hours', async () => {
    mocks.routines.data = [{ ...routine, archived_at: '2026-09-22T12:00:00Z' }]; mocks.entries.data = [entry]; panel(); await options();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '45'); expect(screen.queryByRole('button', { name: 'Undo finish' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Edit repeat schedule' })).not.toBeInTheDocument();
  });
  it('keeps failed writes visible and the action available', async () => {
    mocks.checkIn.mutateAsync.mockRejectedValue(new Error('Connection interrupted')); panel(); await options(); await userEvent.click(screen.getByRole('button', { name: 'Finish session' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Connection interrupted'); expect(screen.getByRole('button', { name: 'Finish session' })).toBeInTheDocument();
  });
  it('provides a retry for a failed cloud read', async () => {
    mocks.routines.isError = true; panel(); await userEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(mocks.routines.refetch).toHaveBeenCalled(); expect(mocks.entries.refetch).toHaveBeenCalled();
  });
});
