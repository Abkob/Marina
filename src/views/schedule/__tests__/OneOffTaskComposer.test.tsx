// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DBGoal, DBTask } from '../../../db/schema';
import { OneOffTaskComposer } from '../TaskTreeDrawer';

const goal = { id: 'goal-1', title: 'Finish thesis' } as DBGoal;
const parent = {
  id: 'parent-1', title: 'Write methods', goal_id: goal.id, parent_task_id: null,
  completed: false, status: 'in_progress', position: 0,
} as DBTask;

describe('OneOffTaskComposer', () => {
  it('creates a standalone task draft with optional estimate and deadline', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<OneOffTaskComposer onCreate={onCreate} onCancel={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('What needs doing?'), 'Buy printer paper');
    await user.type(screen.getByPlaceholderText('Decide later'), '1h 30m');
    await user.type(screen.getByLabelText('Due date'), '2026-07-30');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(onCreate).toHaveBeenCalledWith({
      title: 'Buy printer paper',
      goalId: null,
      parentTaskId: null,
      startDate: null,
      estimatedMinutes: 90,
      dueDate: '2026-07-30',
    });
  });

  it('creates an unestimated all-day task attached directly to a goal', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <OneOffTaskComposer
        onCreate={onCreate}
        onCancel={vi.fn()}
        goals={[goal]}
        tasks={[parent]}
        defaultStartDate="2026-08-12"
      />,
    );

    await user.type(screen.getByPlaceholderText('What needs doing?'), 'Sketch chapter diagram');
    await user.click(screen.getByRole('button', { name: 'Attach to goal' }));
    await user.selectOptions(screen.getByLabelText('Task goal'), goal.id);
    await user.click(screen.getByRole('button', { name: 'Add all-day task' }));

    expect(onCreate).toHaveBeenCalledWith({
      title: 'Sketch chapter diagram',
      goalId: goal.id,
      parentTaskId: null,
      startDate: '2026-08-12',
      estimatedMinutes: null,
      dueDate: null,
    });
  });

  it('can nest the all-day task under a parent task in the selected goal', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <OneOffTaskComposer
        onCreate={onCreate}
        onCancel={vi.fn()}
        goals={[goal]}
        tasks={[parent]}
        defaultStartDate="2026-08-13"
      />,
    );

    await user.type(screen.getByPlaceholderText('What needs doing?'), 'Check citations');
    await user.click(screen.getByRole('button', { name: 'Nest under parent task' }));
    await user.selectOptions(screen.getByLabelText('Task goal'), goal.id);
    await user.selectOptions(screen.getByLabelText('Parent task'), parent.id);
    await user.click(screen.getByRole('button', { name: 'Add all-day task' }));

    expect(onCreate).toHaveBeenCalledWith({
      title: 'Check citations',
      goalId: goal.id,
      parentTaskId: parent.id,
      startDate: '2026-08-13',
      estimatedMinutes: null,
      dueDate: null,
    });
  });
});
