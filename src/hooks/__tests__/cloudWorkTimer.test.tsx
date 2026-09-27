// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudWorkTimerProvider, useCloudWorkTimer } from '../useCloudWorkTimer';
import { apiFetch, apiPost } from '../../utils/apiFetch';
import { WORK_TIMER_STORAGE_KEY } from '../../utils/workTimer';

vi.mock('../../utils/apiFetch', async original => ({ ...await original<typeof import('../../utils/apiFetch')>(), apiFetch: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiPatch: vi.fn() }));
let active: { sessionId: string; taskId: string; title: string; notes: string; startedAt: string } | null;
let logged: Set<string>;
const clients: QueryClient[] = [];
const reply = () => ({ timer: active, serverNow: new Date().toISOString() });
function Device({ label }: { label: string }) {
  const timer = useCloudWorkTimer();
  return <section aria-label={label}>
    <output data-testid={`${label}-timer`}>{timer.timer?.sessionId ?? 'idle'}</output>
    <output data-testid={`${label}-elapsed`}>{timer.timer ? Math.floor((timer.nowMs - Date.parse(timer.timer.startedAt)) / 1000) : 0}</output>
    <output data-testid={`${label}-error`}>{timer.error}</output>
    <button disabled={!timer.ready || timer.busy} onClick={() => { void timer.start({ taskId: 'task-1' }).catch(() => {}); }}>{label} start</button>
    <button disabled={!timer.timer || timer.busy} onClick={() => { void timer.stop(timer.timer!.sessionId).catch(() => {}); }}>{label} stop</button>
  </section>;
}
function mount(label: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(client);
  return render(<QueryClientProvider client={client}><CloudWorkTimerProvider><Device label={label} /></CloudWorkTimerProvider></QueryClientProvider>);
}
async function settle(ms = 30) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
  vi.clearAllMocks(); active = null; logged = new Set();
  const storage = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
  vi.mocked(apiFetch).mockImplementation(async () => reply() as never);
  vi.mocked(apiPost).mockImplementation(async (url, body) => {
    const input = body as Record<string, string>;
    if (url.endsWith('/start') || url.endsWith('/import')) {
      if (logged.has(input.sessionId ?? 'legacy-import')) return { ...reply(), started: false } as never;
      active ??= { sessionId: input.sessionId ?? 'legacy-import', taskId: input.taskId, notes: input.notes ?? '', title: 'Shared focus', startedAt: input.startedAt ?? new Date().toISOString() };
      return { ...reply(), started: true } as never;
    }
    const id = url.split('/').at(-2)!;
    const duplicate = logged.has(id); logged.add(id);
    if (active?.sessionId === id) active = null;
    return { ...reply(), minutes: 1, duplicate } as never;
  });
});
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.useRealTimers(); });

it('shares start and stop across independent sessions and survives reload', async () => {
  mount('laptop'); const phone = mount('phone'); await settle();
  fireEvent.click(screen.getByText('laptop start')); await settle();
  const id = active!.sessionId;
  expect(screen.getByTestId('laptop-timer')).toHaveTextContent(id);
  await settle(3100);
  expect(screen.getByTestId('phone-timer')).toHaveTextContent(id);
  expect(screen.getByTestId('phone-elapsed').textContent).toBe(screen.getByTestId('laptop-elapsed').textContent);
  phone.unmount(); mount('reloaded'); await settle();
  expect(screen.getByTestId('reloaded-timer')).toHaveTextContent(id);
  fireEvent.click(screen.getByText('reloaded stop')); await settle(); await settle(3100);
  expect(screen.getByTestId('laptop-timer')).toHaveTextContent('idle');
  expect(logged.size).toBe(1);
});

it('keeps the timer visible after a failed stop and allows a safe retry', async () => {
  mount('laptop'); await settle(); fireEvent.click(screen.getByText('laptop start')); await settle();
  const id = active!.sessionId;
  vi.mocked(apiPost).mockRejectedValueOnce(new Error('Network unavailable'));
  fireEvent.click(screen.getByText('laptop stop')); await settle();
  expect(screen.getByTestId('laptop-timer')).toHaveTextContent(id);
  expect(screen.getByTestId('laptop-error')).toHaveTextContent('Network unavailable');
  fireEvent.click(screen.getByText('laptop stop')); await settle();
  expect(screen.getByTestId('laptop-timer')).toHaveTextContent('idle');
  expect(logged.size).toBe(1);
});

it('uses cloud time even when the device clock is wrong', async () => {
  active = { sessionId: 'clock-proof', taskId: 'task-1', title: 'Focus', notes: '', startedAt: '2026-09-27T09:00:00Z' };
  vi.mocked(apiFetch).mockResolvedValue({ timer: active, serverNow: '2026-09-27T09:10:00Z' });
  mount('phone'); await settle();
  expect(screen.getByTestId('phone-elapsed')).toHaveTextContent('600');
  await settle(1000);
  expect(screen.getByTestId('phone-elapsed')).toHaveTextContent('601');
});

it('adopts a legacy device timer once without resetting its start or reviving it later', async () => {
  const legacy = { taskId: 'task-1', notes: 'Earlier work', startedAt: '2026-09-27T11:30:00Z' };
  localStorage.setItem(WORK_TIMER_STORAGE_KEY, JSON.stringify(legacy));
  const first = mount('laptop'); await settle();
  expect(apiPost).toHaveBeenCalledWith('/api/work-timer/import', legacy);
  expect(active?.startedAt).toBe(legacy.startedAt);
  fireEvent.click(screen.getByText('laptop stop')); await settle(); first.unmount();
  mount('reloaded'); await settle();
  expect(screen.getByTestId('reloaded-timer')).toHaveTextContent('idle');
  expect(vi.mocked(apiPost).mock.calls.filter(([url]) => url.endsWith('/import'))).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem(`marina-work-timer-recovery:${legacy.startedAt}`)!)).toEqual(legacy);
});

it('does not replace a running cloud timer with an older device timer', async () => {
  active = { sessionId: 'cloud-wins', taskId: 'task-2', notes: '', title: 'Cloud task', startedAt: '2026-09-27T11:50:00Z' };
  localStorage.setItem(WORK_TIMER_STORAGE_KEY, JSON.stringify({ taskId: 'task-1', notes: 'Keep this recovery copy', startedAt: '2026-09-27T11:30:00Z' }));
  mount('phone'); await settle();
  expect(screen.getByTestId('phone-timer')).toHaveTextContent('cloud-wins');
  expect(active.taskId).toBe('task-2');
});

it('recovers a local timer even when this browser was previously marked migrated', async () => {
  localStorage.setItem('marina-work-timer-cloud-v1', '1');
  const legacy = { taskId: 'task-1', notes: 'Quiz revision', startedAt: '2026-09-27T11:30:00Z' };
  localStorage.setItem(WORK_TIMER_STORAGE_KEY, JSON.stringify(legacy));
  mount('laptop'); await settle();
  expect(apiPost).toHaveBeenCalledWith('/api/work-timer/import', legacy);
  expect(active?.startedAt).toBe(legacy.startedAt);
  expect(screen.getByTestId('laptop-timer')).toHaveTextContent('legacy-import');
});

it('adopts a timer started in an older tab after this session has connected', async () => {
  mount('laptop'); await settle();
  const legacy = { taskId: 'task-1', notes: '', startedAt: '2026-09-27T11:40:00Z' };
  localStorage.setItem(WORK_TIMER_STORAGE_KEY, JSON.stringify(legacy));
  window.dispatchEvent(new StorageEvent('storage', { key: WORK_TIMER_STORAGE_KEY }));
  await settle();
  expect(apiPost).toHaveBeenCalledWith('/api/work-timer/import', legacy);
  expect(active?.startedAt).toBe(legacy.startedAt);
  expect(screen.getByTestId('laptop-timer')).toHaveTextContent('legacy-import');
});

it('preserves a local timer created while an empty cloud response is in flight', async () => {
  mount('laptop'); await settle();
  let respond!: (value: unknown) => void;
  vi.mocked(apiFetch).mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }) as never);
  await act(async () => { void clients[0].invalidateQueries({ queryKey: ['cloud-work-timer'] }); });
  const legacy = { taskId: 'task-1', notes: 'Do not lose this', startedAt: '2026-09-27T11:40:00Z' };
  localStorage.setItem(WORK_TIMER_STORAGE_KEY, JSON.stringify(legacy));
  await act(async () => { respond({ timer: null, serverNow: new Date().toISOString() }); });
  await settle(100);
  expect(apiPost).toHaveBeenCalledWith('/api/work-timer/import', legacy);
  expect(active?.startedAt).toBe(legacy.startedAt);
  expect(JSON.parse(localStorage.getItem(WORK_TIMER_STORAGE_KEY)!)).toMatchObject(legacy);
});

it('keeps an unuploaded timer through an import failure and retries successfully', async () => {
  const legacy = { taskId: 'task-1', notes: 'Keep me', startedAt: '2026-09-27T11:30:00Z' };
  localStorage.setItem(WORK_TIMER_STORAGE_KEY, JSON.stringify(legacy));
  vi.mocked(apiPost).mockRejectedValueOnce(new Error('Offline'));
  mount('laptop'); await settle();
  expect(JSON.parse(localStorage.getItem(WORK_TIMER_STORAGE_KEY)!)).toEqual(legacy);
  expect(active).toBeNull();
  await settle(1500);
  expect(active?.startedAt).toBe(legacy.startedAt);
  expect(screen.getByTestId('laptop-timer')).toHaveTextContent('legacy-import');
});

it('reconciles a stale stopped timer on reload without reviving it', async () => {
  const stale = { sessionId: 'already-stopped', taskId: 'task-1', notes: '', startedAt: '2026-09-27T11:30:00Z' };
  logged.add(stale.sessionId);
  localStorage.setItem(WORK_TIMER_STORAGE_KEY, JSON.stringify(stale));
  mount('phone'); await settle();
  expect(apiPost).toHaveBeenCalledWith('/api/work-timer/import', stale);
  expect(active).toBeNull();
  expect(screen.getByTestId('phone-timer')).toHaveTextContent('idle');
  expect(localStorage.getItem(WORK_TIMER_STORAGE_KEY)).toBeNull();
});
