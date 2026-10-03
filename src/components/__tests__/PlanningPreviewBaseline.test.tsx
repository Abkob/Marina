// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanCalendarWidget, type ChatPlan } from '../../views/copilot/PlanCalendarWidget';

const mocks = vi.hoisted(() => ({ patch: vi.fn(), post: vi.fn(), toast: vi.fn() }));
vi.mock('../../utils/apiFetch', () => ({ apiPatch: mocks.patch, apiPost: mocks.post }));
vi.mock('../../store/useAppStore', () => ({ useAppStore: () => ({ triggerToast: mocks.toast }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const plan: ChatPlan = {
  from: '2026-10-06', to: '2026-10-06', work_start: 9, work_end: 12,
  days: [{ date: '2026-10-06', available_minutes: 120 }], busy: [],
  blocks: [{ task_id: 'synthetic-task', title: 'Synthetic report review', date: '2026-10-06', start_hour: 9, duration_hours: 0.5 }],
  unplaced: [], scheduler: { status: 'feasible', gap_minutes: 0, unestimated_count: 0, overflow_count: 0 }, status: 'pending',
};
describe('P00.2 existing calendar preview baseline', () => {
  it('P00.2-F02 shows the proposed work without automatically applying it', () => {
    render(<PlanCalendarWidget plan={plan} sessionId="synthetic-session" messageId="synthetic-message" />);
    expect(screen.getByText('Synthetic report review')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Apply 1 block' })).toBeEnabled();
    expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.patch).not.toHaveBeenCalled();
  });
  it('P00.2-F03 removing preview work saves the adjustment without creating calendar events', async () => {
    mocks.patch.mockResolvedValue({ ok: true });
    render(<PlanCalendarWidget plan={plan} sessionId="synthetic-session" messageId="synthetic-message" />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Synthetic report review from plan' }));
    expect(screen.getByRole('button', { name: 'Apply 0 blocks' })).toBeDisabled();
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/ai/sessions/synthetic-session/messages/synthetic-message/plan', expect.objectContaining({ adjustments: expect.any(Object) })));
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('P00.2-F04 a failed Apply keeps the pending preview available for retry', async () => {
    mocks.post.mockRejectedValue(new Error('Synthetic save unavailable'));
    render(<PlanCalendarWidget plan={plan} sessionId="synthetic-session" messageId="synthetic-message" />);
    await userEvent.click(screen.getByRole('button', { name: 'Apply 1 block' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Synthetic save unavailable', 'error'));
    expect(screen.getByRole('button', { name: 'Apply 1 block' })).toBeEnabled();
    expect(screen.queryByText('Added to your schedule')).not.toBeInTheDocument();
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});
