// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventComposer } from '../EventComposer';
import type { DBEvent } from '../../../db/schema';

const mocks = vi.hoisted(() => ({ patch: vi.fn(), post: vi.fn(), toast: vi.fn() }));
vi.mock('../../../utils/apiFetch', () => ({ apiPatch: mocks.patch, apiPost: mocks.post, apiDelete: vi.fn() }));
vi.mock('../../../store/useAppStore', () => ({ useAppStore: () => ({ triggerToast: mocks.toast }) }));
beforeEach(() => { vi.clearAllMocks(); mocks.patch.mockResolvedValue({}); });
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
});
