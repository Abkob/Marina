// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DBRoutine } from '../../../types/routines';
import { RoutineComposer } from '../RoutineComposer';

const mocks = vi.hoisted(() => ({ create: { mutateAsync: vi.fn(), isPending: false }, edit: { mutateAsync: vi.fn(), isPending: false } }));
vi.mock('../../../api/routines', () => ({ useCreateRoutine: () => mocks.create, useRescheduleRoutine: () => mocks.edit }));
beforeEach(() => { vi.clearAllMocks(); mocks.create.mutateAsync.mockResolvedValue({}); mocks.edit.mutateAsync.mockResolvedValue({}); });
const routine = { id: 'routine', title: 'Biology', planned_minutes: 30, weekdays: [1, 3, 5], weekly_target: 3, cadence: 'daily', target_unit: 'minutes', target_count: 30, preferred_time: '09:00', updated_at: '2026-09-22T08:00:00Z' } as DBRoutine;
function composer(edit?: DBRoutine) {
  const onSaved = vi.fn();
  render(<RoutineComposer date="2026-09-22" today="2026-09-22" routine={edit} goals={[]} onClose={vi.fn()} onSaved={onSaved} />);
  return onSaved;
}
async function name() { await userEvent.type(screen.getByLabelText('Name'), 'Biology revision'); }

describe('time-based repeat editor', () => {
  it('creates minutes and a weekly frequency, without count targets', async () => {
    const user = userEvent.setup(); const saved = composer(); await name();
    expect(screen.getByRole('status')).toHaveTextContent('2h 15m');
    await user.click(screen.getByRole('button', { name: 'Create routine' }));
    expect(mocks.create.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ title: 'Biology revision', cadence: 'weekly', weekly_target: 3, planned_minutes: 45, target_count: 45, target_unit: 'minutes', preferred_time: null }));
    expect(saved).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Measure')).not.toBeInTheDocument();
  });
  it('accepts hours and typed clock times, derives a precise end and weekly total', async () => {
    const user = userEvent.setup(); composer(); await name();
    await user.clear(screen.getByLabelText('Each session')); await user.type(screen.getByLabelText('Each session'), '1.5h');
    await user.click(screen.getByRole('button', { name: 'At a time' }));
    await user.clear(screen.getByLabelText('Start time')); await user.type(screen.getByLabelText('Start time'), '2:30pm');
    expect(screen.getByText('Ends 16:00')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('4h 30m');
    await user.click(screen.getByRole('button', { name: 'Create routine' }));
    expect(mocks.create.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ planned_minutes: 90, target_count: 90, preferred_time: '14:30' }));
  });
  it('derives fixed-day frequency from the weekday choices', async () => {
    const user = userEvent.setup(); composer(); await name();
    await user.click(screen.getByRole('button', { name: 'Choose days' }));
    for (const day of ['Tuesday', 'Thursday', 'Saturday', 'Sunday']) await user.click(screen.getByRole('button', { name: day }));
    expect(screen.getByLabelText('Times per week')).toHaveValue(3);
    await user.click(screen.getByRole('button', { name: 'Create routine' }));
    expect(mocks.create.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ cadence: 'daily', weekdays: [1, 3, 5], weekly_target: 3 }));
  });
  it('rejects too few eligible days and an overnight time range', async () => {
    const user = userEvent.setup(); composer(); await name();
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) await user.click(screen.getByRole('button', { name: day }));
    await user.click(screen.getByRole('button', { name: 'Create routine' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose enough available days');
    await user.click(screen.getByRole('button', { name: 'Monday' })); await user.click(screen.getByRole('button', { name: 'At a time' }));
    await user.clear(screen.getByLabelText('Start time')); await user.type(screen.getByLabelText('Start time'), '23:50');
    await user.click(screen.getByRole('button', { name: 'Create routine' }));
    expect(screen.getByRole('alert')).toHaveTextContent('before midnight');
    expect(mocks.create.mutateAsync).not.toHaveBeenCalled();
  });
  it('keeps failed saves and the draft visible for retry', async () => {
    mocks.create.mutateAsync.mockRejectedValue(new Error('Cloud save unavailable'));
    const user = userEvent.setup(); const saved = composer(); await name();
    await user.click(screen.getByRole('button', { name: 'Create routine' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Cloud save unavailable');
    expect(screen.getByLabelText('Name')).toHaveValue('Biology revision'); expect(saved).not.toHaveBeenCalled();
  });
  it('edits the same routine from next Monday with a concurrency token', async () => {
    const user = userEvent.setup(); composer(routine);
    await user.click(screen.getByRole('button', { name: '1h' }));
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(mocks.edit.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ routineId: routine.id, planned_minutes: 60, effective_from: '2026-09-28', expected_updated_at: routine.updated_at }));
    expect(mocks.create.mutateAsync).not.toHaveBeenCalled();
  });
  it('does not let an edit change this week or begin midweek', async () => {
    const user = userEvent.setup(); composer(routine);
    await user.clear(screen.getByLabelText('Apply from Monday')); await user.type(screen.getByLabelText('Apply from Monday'), '2026-09-29');
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a Monday');
    expect(mocks.edit.mutateAsync).not.toHaveBeenCalled();
  });
});
