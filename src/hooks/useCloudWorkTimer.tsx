import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiDelete, apiFetch, apiPatch, apiPost } from '../utils/apiFetch';
import { readActiveWorkTimer, writeActiveWorkTimer, type ActiveWorkTimer } from '../utils/workTimer';

export const CLOUD_TIMER_KEY = ['cloud-work-timer'];
const MIGRATED_KEY = 'marina-work-timer-cloud-v1';
type CloudTimer = ActiveWorkTimer & { sessionId: string };
type Reply = { timer: CloudTimer | null; serverNow: string; started?: boolean; minutes?: number; duplicate?: boolean };
type Snapshot = Reply & { serverTime: number; receivedAt: number };
const snapshot = (reply: Reply): Snapshot => ({ ...reply, serverTime: Date.parse(reply.serverNow), receivedAt: performance.now() });
type TimerContext = {
  timer: CloudTimer | null; nowMs: number; ready: boolean; busy: boolean; error: string | null;
  start: (input: { taskId: string; routineId?: string; notes?: string }) => Promise<Reply>;
  stop: (id: string, input?: { minutes?: number; notes?: string }) => Promise<Reply>;
  discard: (id: string) => Promise<Reply>;
  updateNotes: (id: string, notes: string) => Promise<Reply>;
};
const Context = createContext<TimerContext | null>(null);

export function CloudWorkTimerProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const initialized = useRef(false);
  const mutationInFlight = useRef(false);
  const previousSession = useRef<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const query = useQuery({
    queryKey: CLOUD_TIMER_KEY,
    queryFn: async ({ signal }) => {
      let reply: Reply | undefined;
      if (!initialized.current) {
        let migrated = false;
        try { migrated = localStorage.getItem(MIGRATED_KEY) === '1'; } catch { /* optional cache */ }
        const legacy = !migrated ? readActiveWorkTimer() : null;
        if (legacy) {
          // Preserve the original before adopting the cloud's authoritative timer.
          try { localStorage.setItem(`marina-work-timer-recovery:${legacy.sessionId ?? legacy.startedAt}`, JSON.stringify(legacy)); } catch { /* optional cache */ }
          try { reply = await apiPost<Reply>('/api/work-timer/import', legacy); }
          catch (error) {
            if (!(error instanceof ApiError) || ![404, 409].includes(error.status)) throw error;
          }
        }
      }
      reply ??= await apiFetch<Reply>('/api/work-timer', { signal, cache: 'no-store' });
      initialized.current = true;
      try { localStorage.setItem(MIGRATED_KEY, '1'); } catch { /* optional cache */ }
      return snapshot(reply);
    },
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    staleTime: 1000,
    retry: 1,
  });
  useEffect(() => {
    if (!query.data) return;
    writeActiveWorkTimer(query.data.timer);
    const session = query.data.timer?.sessionId ?? null;
    if (previousSession.current !== undefined && previousSession.current !== session) {
      for (const key of ['work-sessions', 'work-session-stats', 'tasks', 'goals', 'routines', 'routine-entries', 'schedule-preview']) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    }
    previousSession.current = session;
  }, [query.data, qc]);
  useEffect(() => {
    const data = query.data;
    if (!data?.timer) return;
    let timeout: number;
    const schedule = () => {
      const elapsed = Math.max(0, data.serverTime + performance.now() - data.receivedAt - Date.parse(data.timer!.startedAt));
      timeout = window.setTimeout(() => { tick(value => value + 1); schedule(); }, 1000 - elapsed % 1000 + 5);
    };
    schedule();
    return () => window.clearTimeout(timeout);
  }, [query.data]);

  async function mutate(request: () => Promise<Reply>, refreshLogs = false) {
    if (!query.data) throw new Error('Wait for the cloud timer to connect, then try again.');
    if (mutationInFlight.current) throw new Error('A timer change is still being saved. Please try again.');
    mutationInFlight.current = true;
    setBusy(true); setActionError(null);
    await qc.cancelQueries({ queryKey: CLOUD_TIMER_KEY });
    try {
      const reply = await request();
      await qc.cancelQueries({ queryKey: CLOUD_TIMER_KEY });
      qc.setQueryData(CLOUD_TIMER_KEY, snapshot(reply));
      writeActiveWorkTimer(reply.timer);
      if (refreshLogs) for (const key of ['work-sessions', 'work-session-stats', 'tasks', 'goals', 'routines', 'routine-entries', 'schedule-preview']) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
      return reply;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not save the timer. Please retry.');
      void qc.invalidateQueries({ queryKey: CLOUD_TIMER_KEY });
      throw error;
    } finally { mutationInFlight.current = false; setBusy(false); }
  }
  const data = query.data;
  return <Context.Provider value={{
    timer: data?.timer ?? null,
    nowMs: data ? data.serverTime + Math.max(0, performance.now() - data.receivedAt) : Date.now(),
    ready: Boolean(data), busy,
    error: actionError ?? (query.error ? 'Timer sync is unavailable. Reconnect to see changes from other devices.' : null),
    start: input => mutate(() => apiPost<Reply>('/api/work-timer/start', { ...input, sessionId: crypto.randomUUID() })),
    stop: (id, input = {}) => mutate(() => apiPost<Reply>(`/api/work-timer/${encodeURIComponent(id)}/stop`, input), true),
    discard: id => mutate(() => apiDelete<Reply>(`/api/work-timer/${encodeURIComponent(id)}`)),
    updateNotes: (id, notes) => mutate(() => apiPatch<Reply>(`/api/work-timer/${encodeURIComponent(id)}`, { notes })),
  }}>{children}</Context.Provider>;
}

export function useCloudWorkTimer() {
  const value = useContext(Context);
  if (!value) throw new Error('Work timers require CloudWorkTimerProvider');
  return value;
}
