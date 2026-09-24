// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkView } from '../WorkView';
import { readActiveWorkTimer, writeActiveWorkTimer, type ActiveWorkTimer } from '../../utils/workTimer';
import type { DBGoal, DBTask } from '../../db/schema';

const mocks = vi.hoisted(() => ({
  post: vi.fn(), create: vi.fn(), invalidate: vi.fn(), toast: vi.fn(), navigate: vi.fn(), confirm: vi.fn(),
  tasks: [] as DBTask[], goals: [] as DBGoal[], selected: 'task-1' as string | null, select: vi.fn(), goalsLoading: false,
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
vi.mock('../../api/hooks', () => ({
  useAllTasks: () => ({ data: mocks.tasks }),
  useAllGoals: () => ({ data: mocks.goalsLoading ? [] : mocks.goals, isPlaceholderData: mocks.goalsLoading }),
  useTask: () => ({ data: mocks.tasks.find(task => task.id === mocks.selected) }),
  useTaskNotes: () => ({ data: [] }), useTaskWorkSessions: () => ({ data: [] }),
  useCreateWorkSession: () => ({ mutateAsync: mocks.create }),
  useDeleteWorkSession: () => ({ mutateAsync: vi.fn() }),
  useInvalidate: () => ({}), useNoteFiles: () => ({ data: [] }),
}));
vi.mock('../../store/useAppStore', () => ({
  useAppStore: () => ({ workTaskId: mocks.selected, setWorkTaskId: mocks.select, triggerToast: mocks.toast, showConfirm: mocks.confirm, setCurrentTab: mocks.navigate }),
}));
vi.mock('../../utils/apiFetch', () => ({ apiPost: mocks.post }));
vi.mock('../../components/TaskTree', () => ({ TaskTree: ({ tasks }: { tasks: DBTask[] }) => <div aria-label="Task choices">{tasks.map(task => <span key={task.id}>{task.title}</span>)}</div> }));
vi.mock('../../components/EntityTopicChips', () => ({ EntityTopicChips: () => null }));
vi.mock('../../components/FileViewerModal', () => ({ FileViewerModal: () => null }));
vi.mock('../../db/queries/tasks', () => ({ addTaskNote: vi.fn(), deleteTaskNote: vi.fn(), toggleTask: vi.fn(), touchTask: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../db/queries/noteFiles', () => ({ addNoteFile: vi.fn(), deleteNoteFile: vi.fn() }));

function routineTimer(): ActiveWorkTimer {
  return {
    taskId: '', routineId: 'revision', routineTitle: 'Physics revision', goalId: 'physics',
    routineDate: '2026-09-22', sessionId: 'e16487c7-a140-4e07-9c89-18150952b659',
    startedAt: new Date(Date.now() - 20 * 60_000).toISOString(), notes: 'Chapter 3',
  };
}

describe('routine focus in Work', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    mocks.tasks = [];
    mocks.goals = [{ id: 'physics', title: 'Physics 210' } as DBGoal];
    mocks.selected = 'task-1';
    mocks.goalsLoading = false;
    mocks.post.mockResolvedValue({ minutes: 20 });
    mocks.create.mockResolvedValue({ id: 'saved-task-session' });
  });

  it('removes an archived branch and replaces its persisted Work selection without discarding an unsaved timer', () => {
    mocks.tasks = [
      { id: 'parent', goal_id: 'physics', title: 'Archived parent', kind: 'critical_path' },
      { id: 'task-1', goal_id: null, parent_task_id: 'parent', title: 'Archived child', status: 'todo', kind: 'manual' },
      { id: 'active', goal_id: null, title: 'Visible work', status: 'in_progress', kind: 'manual' },
    ] as DBTask[];
    mocks.goals[0].archived_at = '2026-09-24';
    const timer = { taskId: 'task-1', startedAt: routineTimer().startedAt, notes: '' };
    writeActiveWorkTimer(timer);
    render(<WorkView />);
    expect(screen.queryByText('Archived parent')).not.toBeInTheDocument();
    expect(screen.queryByText('Archived child')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Archived child' })).not.toBeInTheDocument();
    expect(screen.getByText('Visible work')).toBeInTheDocument();
    expect(mocks.select).toHaveBeenCalledWith('active');
    expect(readActiveWorkTimer()).toEqual(timer);
    expect(screen.getByRole('button', { name: 'Stop active timer and log time' })).toBeInTheDocument();
  });

  it('waits for goals before replacing a selection, clears an archived-only selection, and offers restored tasks again', () => {
    mocks.tasks = [{ id: 'task-1', goal_id: 'physics', title: 'Saved task', status: 'todo', kind: 'manual' }] as DBTask[];
    mocks.goalsLoading = true;
    const { rerender } = render(<WorkView />);
    expect(mocks.select).not.toHaveBeenCalled();
    mocks.goalsLoading = false;
    mocks.goals = [{ ...mocks.goals[0], archived_at: '2026-09-24' }];
    rerender(<WorkView />);
    expect(mocks.select).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText('Saved task')).not.toBeInTheDocument();
    mocks.selected = null;
    mocks.goals = [{ ...mocks.goals[0], archived_at: null }];
    rerender(<WorkView />);
    expect(mocks.select).toHaveBeenLastCalledWith('task-1');
    expect(screen.getByText('Saved task')).toBeInTheDocument();
  });

  it('restores a routine with no task and explains that logging time is not always completion', () => {
    writeActiveWorkTimer(routineTimer());
    render(<WorkView />);
    expect(screen.getByRole('heading', { name: 'Physics revision' })).toBeInTheDocument();
    expect(screen.getByText(/Recording Physics revision/)).toBeInTheDocument();
    expect(screen.getByText(/For problems, pages or sessions/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start timer for selected task' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('What are you reviewing or practising?'), { target: { value: 'Chapter 4' } });
    expect(readActiveWorkTimer()?.notes).toBe('Chapter 4');
    fireEvent.click(screen.getByRole('button', { name: "Back to today's routines" }));
    expect(mocks.navigate).toHaveBeenCalledWith('Schedule');
    expect(readActiveWorkTimer()?.routineId).toBe('revision');
  });

  it('logs a routine to its own occurrence once, invalidates progress and clears the timer', async () => {
    const timer = routineTimer();
    writeActiveWorkTimer(timer);
    let finish!: (value: { minutes: number }) => void;
    mocks.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<WorkView />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop routine timer and log time' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop active timer and log time' }));
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/api/routines/revision/sessions', expect.objectContaining({
      id: timer.sessionId, date: timer.routineDate, started_at: timer.startedAt, minutes: 20, notes: 'Chapter 3',
    }));
    expect(mocks.create).not.toHaveBeenCalled();
    await act(async () => { finish({ minutes: 20 }); });
    expect(readActiveWorkTimer()).toBeNull();
    for (const key of ['routines', 'routine-entries', 'schedule-preview', 'work-sessions', 'work-session-stats']) {
      expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: [key] });
    }
  });

  it('retains a failed routine save and retries with the same session id', async () => {
    const timer = routineTimer();
    writeActiveWorkTimer(timer);
    mocks.post.mockRejectedValueOnce(new Error('Network unavailable'));
    render(<WorkView />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop routine timer and log time' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('Time not saved'), 'error'));
    expect(readActiveWorkTimer()).toEqual(timer);
    mocks.post.mockResolvedValueOnce({ minutes: 17 });
    fireEvent.click(screen.getByRole('button', { name: 'Stop routine timer and log time' }));
    await waitFor(() => expect(readActiveWorkTimer()).toBeNull());
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[0][1].id).toBe(mocks.post.mock.calls[1][1].id);
    expect(mocks.toast).toHaveBeenLastCalledWith('Logged 17m to your routine.', 'success');
  });

  it('keeps legacy task timers on the task session endpoint', async () => {
    writeActiveWorkTimer({ taskId: 'task-1', startedAt: routineTimer().startedAt, notes: 'Existing task work' });
    render(<WorkView />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop active timer and log time' }));
    await waitFor(() => expect(readActiveWorkTimer()).toBeNull());
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ task_id: 'task-1', source: 'timer', notes: 'Existing task work' }));
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('requires an explicit focused-time correction for a forgotten timer over 24 hours', async () => {
    const timer = { ...routineTimer(), startedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() };
    writeActiveWorkTimer(timer);
    mocks.post.mockResolvedValueOnce({ minutes: 35 });
    render(<WorkView />);
    expect(screen.getByText(/Nothing will be trimmed automatically/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop routine timer and log time' }));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(readActiveWorkTimer()).toEqual(timer);
    expect(screen.getByRole('alert')).toHaveTextContent('Your timer has not been discarded');
    fireEvent.change(screen.getByLabelText('Minutes to save'), { target: { value: '35' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stop routine timer and log time' }));
    await waitFor(() => expect(readActiveWorkTimer()).toBeNull());
    expect(mocks.post).toHaveBeenCalledWith('/api/routines/revision/sessions', expect.objectContaining({ id: timer.sessionId, minutes: 35, started_at: timer.startedAt }));
    expect(mocks.toast).toHaveBeenLastCalledWith('Logged 35m to your routine.', 'success');
  });

  it('rejects corrected minutes beyond the elapsed time or allowed daily maximum', () => {
    writeActiveWorkTimer(routineTimer());
    render(<WorkView />);
    fireEvent.click(screen.getByLabelText('Adjust focused minutes before saving'));
    for (const value of ['0', '1500', '100', '1.5']) {
      fireEvent.change(screen.getByLabelText('Minutes to save'), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Stop routine timer and log time' }));
      expect(mocks.post).not.toHaveBeenCalled();
      expect(readActiveWorkTimer()).not.toBeNull();
    }
  });

  it('only discards an unsaved timer after confirmation and never deletes saved history', () => {
    const timer = routineTimer();
    writeActiveWorkTimer(timer);
    render(<WorkView />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard timer' }));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining('Previously saved sessions and routine history will stay unchanged'), expect.any(Function));
    expect(readActiveWorkTimer()).toEqual(timer);
    act(() => { mocks.confirm.mock.calls[0][1](); });
    expect(readActiveWorkTimer()).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
