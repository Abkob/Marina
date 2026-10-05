// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanCalendarWidget, type ChatPlan } from '../../views/copilot/PlanCalendarWidget';
import { PlanOptionsWidget } from '../../views/copilot/PlanOptionsWidget';

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
  it('keeps short overlapping standalone activities visible and applies both exact times', async () => {
    const blocks = [
      { title: '5 am prayer', date: '2026-10-12', start_hour: 5, duration_hours: 0.25 },
      { title: 'Breakfast', date: '2026-10-12', start_hour: 6, duration_hours: 1 },
    ];
    const preview = { ...plan, kind: 'series', from: '2026-10-12', to: '2026-10-12', work_start: 5, work_end: 8, blocks,
      busy: [{ title: 'Leetcode Practice', date: '2026-10-12', start_hour: 5, duration_hours: 2.5, kind: 'block' }], days: [] };
    mocks.post.mockResolvedValue({ ok: true, created: 2 }); mocks.patch.mockResolvedValue({ ok: true });
    render(<PlanCalendarWidget plan={preview} sessionId="synthetic-session" messageId="synthetic-message" />);
    expect(screen.getByText('5 am prayer')).toBeVisible();
    expect(screen.getByText('Breakfast')).toBeVisible();
    expect(screen.getByText('Leetcode Practice')).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Apply all 2' }));
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/api/ai/schedule/plan/apply', { blocks });
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/ai/sessions/synthetic-session/messages/synthetic-message/plan', { status: 'applied' }));
  });
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

describe('P01.1 recoverable preview parsing', () => {
  it.each([null, { blocks: null }, { ...plan, to: '9999-12-31' }, { ...plan, unplaced: [{ task_id: 't', title: 'Unknown work', minutes: null }] }])('invalid plan cannot render Apply or mutate anything', async value => {
    const retry = vi.fn();
    render(<PlanCalendarWidget plan={value} sessionId="synthetic-session" onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be read');
    expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reload conversation' }));
    expect(retry).toHaveBeenCalledOnce(); expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.patch).not.toHaveBeenCalled();
  });
  it('guards malformed option collections before reading option status', () => {
    render(<PlanOptionsWidget planOptions={{ options: [{ scheduler: null }] }} />);
    expect(screen.getByRole('alert')).toBeVisible();
  });
  it('recovers when reload replaces a malformed preview with a valid one', () => {
    const view = render(<PlanCalendarWidget plan={{}} sessionId="synthetic-session" />);
    view.rerender(<PlanCalendarWidget plan={plan} sessionId="synthetic-session" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Synthetic report review')).toBeVisible();
  });
});
