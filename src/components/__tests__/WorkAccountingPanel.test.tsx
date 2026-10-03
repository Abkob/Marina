// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkAccountingPanel, type WorkAccountingResponse } from '../planning/WorkAccountingPanel';
import { accountWork } from '../../../shared/workAccounting';
const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('../../utils/apiFetch', async original => ({ ...await original<typeof import('../../utils/apiFetch')>(), apiFetch: mocks.get, apiPatch: mocks.patch }));
const response = (): WorkAccountingResponse => ({ work: accountWork({ estimated_minutes: 60, logged_minutes: 70 }),
  window: { from: '2026-10-03', to: '2026-11-06' }, as_of: '2026-10-03T12:00:00Z', versions: { work: 1, logs: 1, forecast: 0 }, forecast_updated_at: null });
const mount = (id = 'task-a') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}><WorkAccountingPanel taskId={id}/></QueryClientProvider>) };
};
beforeEach(() => { vi.resetAllMocks(); mocks.get.mockResolvedValue(response()); mocks.patch.mockResolvedValue({ saved: true }); });
afterEach(cleanup);
describe('P03.1 time details', () => {
  it('makes unfinished overruns unknown and exposes a keyboard-accessible explanation', async () => {
    mount(); await screen.findByText('Work remaining'); expect(screen.getAllByText('Unknown')).toHaveLength(2);
    const details = screen.getByRole('button', { name: /Time details/ }); details.focus(); await userEvent.keyboard('{Enter}');
    expect(details).toHaveAttribute('aria-expanded', 'true'); expect(screen.getByText(/original estimate is exhausted/)).toBeVisible();
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it('distinguishes 90 minutes of work from zero minutes needing a reservation', async () => {
    mocks.get.mockResolvedValue({ ...response(), work: accountWork({ estimated_minutes: 90 }, 90) }); mount();
    await screen.findByText('Needs calendar time'); expect(screen.getByText('Needs calendar time').parentElement).toHaveTextContent('0 min'); expect(screen.getAllByText('1h 30m')).toHaveLength(2);
  });
  it('saves an explicit zero without completing the task', async () => {
    mount(); await userEvent.click(await screen.findByRole('button', { name: /Time details/ }));
    await userEvent.type(screen.getByRole('spinbutton'), '0'); await userEvent.click(screen.getByRole('button', { name: 'Save forecast' }));
    await screen.findByText('Forecast saved.'); expect(mocks.patch).toHaveBeenCalledWith('/api/tasks/task-a/work-accounting', { minutes: 0, expected: response().versions });
  });
  it('keeps the typed forecast and original versions through a background refresh and conflict', async () => {
    const { client } = mount(); await userEvent.click(await screen.findByRole('button', { name: /Time details/ }));
    await userEvent.type(screen.getByRole('spinbutton'), '45');
    mocks.get.mockResolvedValue({ ...response(), versions: { work: 2, logs: 3, forecast: 1 } });
    await client.invalidateQueries({ queryKey: ['tasks'] }); mocks.patch.mockRejectedValue(new Error('Task changed; refresh to review.'));
    await userEvent.click(screen.getByRole('button', { name: 'Save forecast' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Task changed'); expect(screen.getByRole('spinbutton')).toHaveValue(45);
    expect(mocks.patch.mock.calls[0][1].expected).toEqual(response().versions);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' })); mocks.patch.mockResolvedValue({ saved: true });
    await userEvent.click(screen.getByRole('button', { name: 'Save forecast' }));
    await waitFor(() => expect(mocks.patch.mock.calls.at(-1)[1].expected).toEqual({ work: 2, logs: 3, forecast: 1 }));
  });
  it('keeps a failed load visible and offers retry', async () => {
    mocks.get.mockRejectedValue(new Error('offline')); mount(); expect(await screen.findByRole('alert')).toHaveTextContent('could not load');
    mocks.get.mockResolvedValue(response()); await userEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByText('Work remaining');
  });
});
