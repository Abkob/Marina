// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useArchiveRoutine, useCreateRoutine, useRoutineCheckIn, useRoutineEntries, useRoutines } from '../routines';
import type { CreateRoutineInput } from '../../types/routines';

afterEach(() => { vi.unstubAllGlobals(); });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] });
  vi.stubGlobal('fetch', fetch);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, fetch, wrapper };
}

describe('routine API hooks', () => {
  it('fetches routines and bounded history without treating empty placeholder data as loaded', async () => {
    const { fetch, wrapper } = setup();
    const result = renderHook(() => ({ routines: useRoutines(), entries: useRoutineEntries('2026-09-21', '2026-09-27') }), { wrapper });
    expect(result.result.current.routines.isPending).toBe(true);
    await waitFor(() => expect(result.result.current.entries.isSuccess).toBe(true));
    expect(fetch).toHaveBeenCalledWith('/api/routines', undefined);
    expect(fetch).toHaveBeenCalledWith('/api/routines/entries?from=2026-09-21&to=2026-09-27', undefined);
  });

  it('invalidates routine history and planner/work totals after a check-in', async () => {
    const { client, fetch, wrapper } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useRoutineCheckIn(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ routineId: 'a/b', date: '2026-09-22', status: 'completed' }); });
    expect(fetch).toHaveBeenCalledWith('/api/routines/a%2Fb/check-in', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ date: '2026-09-22', status: 'completed' }),
    }));
    for (const key of ['routines', 'routine-entries', 'schedule-preview', 'work-sessions', 'work-session-stats']) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
    }
  });

  it('posts creation and uses an archive PATCH instead of deleting a routine', async () => {
    const { fetch, wrapper } = setup();
    const input: CreateRoutineInput = { title: 'Practice', note: '', goal_id: null, cadence: 'weekly', weekdays: [1, 2, 3, 4, 5], weekly_target: 3, target_count: 5, target_unit: 'problems', planned_minutes: 25, preferred_time: null, start_date: '2026-09-22' };
    const { result } = renderHook(() => ({ create: useCreateRoutine(), archive: useArchiveRoutine() }), { wrapper });
    await act(async () => { await result.current.create.mutateAsync(input); });
    expect(fetch).toHaveBeenCalledWith('/api/routines', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
    await act(async () => { await result.current.archive.mutateAsync({ routineId: 'routine-id', archived: true }); });
    expect(fetch).toHaveBeenCalledWith('/api/routines/routine-id', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ archived: true }) }));
  });
});
