// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DBGoal } from '../../../db/schema';
import { RoutineComposer } from '../RoutineComposer';

const create = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
vi.mock('../../../api/routines', () => ({ useCreateRoutine: () => create }));
const goals = [{ id: 'physics', title: 'Physics 210', archived_at: null }] as DBGoal[];
beforeEach(() => { vi.clearAllMocks(); create.mutateAsync.mockResolvedValue({ id: 'new' }); create.isPending = false; });

function composer() {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<RoutineComposer date="2026-09-22" goals={goals} onClose={onClose} onSaved={onSaved} />);
  return { onSaved, onClose };
}

describe('RoutineComposer', () => {
  it('creates a standalone anytime catch-up routine with a small daily budget', async () => {
    const user = userEvent.setup();
    const { onSaved } = composer();
    await user.click(screen.getByRole('button', { name: 'Create routine' }));
    expect(create.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Daily catch-up', cadence: 'daily', goal_id: null, weekdays: [1, 2, 3, 4, 5],
      weekly_target: 5, target_count: 20, target_unit: 'minutes', planned_minutes: 20,
      preferred_time: null, start_date: '2026-09-22',
    }));
    expect(onSaved).toHaveBeenCalledOnce();
    expect(screen.getByText(/Missed days don’t pile up/)).toBeInTheDocument();
  });

  it('creates goal-linked practice with a count target and independent time budget', async () => {
    const user = userEvent.setup();
    composer();
    await user.click(screen.getByRole('button', { name: 'Practice' }));
    await user.selectOptions(screen.getByLabelText('Linked goal'), 'physics');
    await user.clear(screen.getByLabelText('Time budget (minutes)', { exact: false }));
    await user.type(screen.getByLabelText('Time budget (minutes)', { exact: false }), '40');
    await user.click(screen.getByRole('button', { name: 'Create routine' }));
    expect(create.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Practice problems', cadence: 'weekly', weekly_target: 3, goal_id: 'physics',
      target_count: 5, target_unit: 'problems', planned_minutes: 40,
    }));
  });

  it('records an optional preferred time and derives minutes budget from a minutes target', async () => {
    const user = userEvent.setup();
    composer();
    await user.selectOptions(screen.getByLabelText('When'), 'preferred');
    await user.type(screen.getByLabelText('Preferred time'), '09:30');
    await user.clear(screen.getByLabelText('Target per session'));
    await user.type(screen.getByLabelText('Target per session'), '35');
    await user.click(screen.getByRole('button', { name: 'Create routine' }));
    expect(create.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ preferred_time: '09:30', planned_minutes: 35, target_count: 35 }));
  });

  it('requires at least one eligible day', async () => {
    const user = userEvent.setup();
    composer();
    for (const name of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
      await user.click(screen.getByRole('button', { name }));
    }
    await user.click(screen.getByRole('button', { name: 'Create routine' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one day');
    expect(create.mutateAsync).not.toHaveBeenCalled();
  });

  it('explains why a preferred slot cannot run past midnight', async () => {
    const user = userEvent.setup();
    composer();
    await user.selectOptions(screen.getByLabelText('When'), 'preferred');
    await user.type(screen.getByLabelText('Preferred time'), '23:55');
    await user.click(screen.getByRole('button', { name: 'Create routine' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose an earlier time');
    expect(create.mutateAsync).not.toHaveBeenCalled();
  });

  it('retains the form on API failure and lets the user retry', async () => {
    const user = userEvent.setup();
    create.mutateAsync.mockRejectedValue(new Error('Unable to save right now'));
    const { onSaved } = composer();
    await user.click(screen.getByRole('button', { name: 'Create routine' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to save right now');
    expect(screen.getByLabelText('Routine name')).toHaveValue('Daily catch-up');
    expect(onSaved).not.toHaveBeenCalled();
  });
});
