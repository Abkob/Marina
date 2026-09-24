import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../utils/apiFetch';

interface GoogleSyncStatus {
  configured: boolean;
  schema_ready: boolean;
  connected: boolean;
  initial_sync_complete?: boolean;
  auto_sync_enabled?: boolean;
}

const RELEVANT_PATH = /^\/api\/(tasks|goals|events|meetings|event-task-links)(?:\/|$)/;

/**
 * Keeps the Google mirror warm without a permanent server process. Marina
 * edits trigger a debounced push; focus/online and a two-minute pulse pull
 * changes made in Google Tasks or the dedicated Marina calendar.
 */
export function GoogleSyncPulse() {
  const queryClient = useQueryClient();
  const statusRef = useRef<GoogleSyncStatus | null>(null);
  const syncingRef = useRef(false);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refreshStatus = async () => {
      try {
        const status = await apiFetch<GoogleSyncStatus>('/api/google/status');
        if (!cancelled) statusRef.current = status;
        return status;
      } catch {
        return null;
      }
    };

    const sync = async () => {
      const status = statusRef.current ?? await refreshStatus();
      if (cancelled || syncingRef.current || !status?.configured || !status.schema_ready || !status.connected
          || !status.initial_sync_complete || !status.auto_sync_enabled) return;
      syncingRef.current = true;
      try {
        const response = await fetch('/api/google/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (response.ok && !cancelled) {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['google-sync-status'] }),
            queryClient.invalidateQueries({ queryKey: ['goals'] }),
            queryClient.invalidateQueries({ queryKey: ['tasks'] }),
            queryClient.invalidateQueries({ queryKey: ['events'] }),
            queryClient.invalidateQueries({ queryKey: ['meetings'] }),
            queryClient.invalidateQueries({ queryKey: ['schedule-preview'] }),
          ]);
        }
      } catch {
        // Status card reports durable sync errors; background polling stays quiet.
      } finally {
        syncingRef.current = false;
      }
    };

    const scheduleSync = (delay = 900) => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(sync, delay);
    };
    const onFocus = () => scheduleSync(250);
    const onOnline = () => scheduleSync(250);
    const onMutation = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path ?? '';
      if (RELEVANT_PATH.test(path)) scheduleSync();
    };

    refreshStatus().then(status => {
      if (status?.connected && status.initial_sync_complete && status.auto_sync_enabled) scheduleSync(1200);
    });
    const interval = window.setInterval(() => {
      refreshStatus().then(status => {
        if (status?.connected && status.initial_sync_complete && status.auto_sync_enabled) scheduleSync(0);
      });
    }, 120_000);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('marina:data-mutated', onMutation);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('marina:data-mutated', onMutation);
    };
  }, [queryClient]);

  return null;
}

