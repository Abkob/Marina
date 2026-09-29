// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventComposer } from '../EventComposer';
import type { DBEvent, DBTask } from '../../../db/schema';

const mocks = vi.hoisted(() => ({ patch: vi.fn(), post: vi.fn(), toast: vi.fn() }));
vi.mock('../../../utils/apiFetch', () => ({ apiPatch: mocks.patch, apiPost: mocks.post, apiDelete: vi.fn() }));
vi.mock('../../../store/useAppStore', () => ({ useAppStore: () => ({ triggerToast: mocks.toast }) }));
beforeEach(() => { vi.clearAllMocks(); mocks.patch.mockReset().mockResolvedValue({}); mocks.post.mockReset().mockResolvedValue({ id: 'new' }); });
afterEach(cleanup);

const event = { id: 'event', title: 'Focus', week_start: '2026-09-21', day_index: 3, start_hour: 9, duration_hours: 1, type: 'Focus' } as DBEvent;
describe('mobile event editing', () => {
  it('saves an arbitrary date outside the displayed week', async () => {
    const close = vi.fn();
    render(<EventComposer seed={{ mode: 'edit', event, date: '2026-09-24', startHour: 9, durationHours: 1 }} days={['2026-09-24']} tasks={[]} goals={[]} onClose={close} />);
    fireEvent.change(screen.getByLabelText('Block date'), { target: { value: '2026-10-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(mocks.patch).toHaveBeenCalledWith('/api/events/event', expect.objectContaining({ week_start: '2026-09-28', day_index: 5 }));
  });
  it('prevents a block from spilling beyond the selected day', () => {
    render(<EventComposer seed={{ mode: 'edit', event, date: '2026-09-24', startHour: 23, durationHours: 2 }} days={['2026-09-24']} tasks={[]} goals={[]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('midnight'), 'error');
  });
  it('moves the end with Start, accepts am/pm, and changes length from End', async () => {
    render(<EventComposer seed={{ mode: 'edit', event, date: '2026-09-24', startHour: 9, durationHours: 1 }} days={[]} tasks={[]} goals={[]} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Block start time'), { target: { value: '2:30pm' } });
    expect(screen.getByLabelText('Block end time')).toHaveValue('15:30');
    fireEvent.change(screen.getByLabelText('Block end time'), { target: { value: '4pm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/events/event', expect.objectContaining({ start_hour: 14.5, duration_hours: 1.5 })));
  });
  it('keeps a drawn range when linking and saves the link in the same request', async () => {
    const task = { id: 'task', title: 'Study', estimated_minutes: 180, actual_minutes: 0 } as DBTask;
    render(<EventComposer seed={{ mode: 'create', date: '2026-09-24', startHour: 9, durationHours: .75 }} days={[]} tasks={[task]} goals={[]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link a task' }));
    fireEvent.click(screen.getByRole('button', { name: /Study/ }));
    expect(screen.getByLabelText('Block end time')).toHaveValue('09:45');
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/api/events', expect.objectContaining({ duration_hours: .75, task_link_changes: { add: [{ task_id: 'task', planned_minutes: null }], remove: [] } })));
  });
  it('keeps the draft when minimized and when the cloud save fails', async () => {
    mocks.patch.mockRejectedValueOnce(new Error('Connection lost'));
    const close = vi.fn();
    render(<EventComposer seed={{ mode: 'edit', event, date: '2026-09-24', startHour: 9, durationHours: 1 }} days={[]} tasks={[]} goals={[]} onClose={close} />);
    fireEvent.change(screen.getByLabelText('Block title'), { target: { value: 'My draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Minimize calendar editor' }));
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand calendar editor' }));
    expect(screen.getByLabelText('Block title')).toHaveValue('My draft');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Block title')).toHaveValue('My draft');
  });
  it('removes only an explicitly unlinked task while preserving other links', async () => {
    render(<EventComposer seed={{ mode: 'edit', event, date: '2026-09-24', startHour: 9, durationHours: 1, links: [{ id: 'a', task_id: 'first', task_title: 'First' }, { id: 'b', task_id: 'second', task_title: 'Second' }] }} days={[]} tasks={[]} goals={[]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink First' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/events/event', expect.objectContaining({ task_link_changes: { add: [], remove: ['a'] } })));
  });
});
