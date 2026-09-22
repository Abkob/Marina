import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateRoutineInput, DBRoutine, DBRoutineEntry, RoutineCheckInInput } from '../types/routines';
import { apiFetch, apiPatch, apiPost } from '../utils/apiFetch';

export function useRoutines() {
  return useQuery({
    queryKey: ['routines'],
    queryFn: () => apiFetch<DBRoutine[]>('/api/routines'),
    staleTime: 10_000,
  });
}

export function useRoutineEntries(from: string, to: string) {
  return useQuery({
    queryKey: ['routine-entries', { from, to }],
    queryFn: () => apiFetch<DBRoutineEntry[]>(`/api/routines/entries?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    staleTime: 10_000,
    enabled: Boolean(from && to),
  });
}

function useInvalidateRoutines() {
  const client = useQueryClient();
  return () => Promise.all([
    ['routines'], ['routine-entries'], ['schedule-preview'], ['work-sessions'], ['work-session-stats'],
  ].map(queryKey => client.invalidateQueries({ queryKey })));
}

export function useCreateRoutine() {
  const invalidate = useInvalidateRoutines();
  return useMutation({
    mutationFn: (input: CreateRoutineInput) => apiPost<DBRoutine>('/api/routines', input),
    onSuccess: invalidate,
  });
}

export function useRoutineCheckIn() {
  const invalidate = useInvalidateRoutines();
  return useMutation({
    mutationFn: ({ routineId, ...input }: RoutineCheckInInput & { routineId: string }) =>
      apiPost<DBRoutineEntry | null>(`/api/routines/${encodeURIComponent(routineId)}/check-in`, input),
    onSuccess: invalidate,
  });
}

export function useArchiveRoutine() {
  const invalidate = useInvalidateRoutines();
  return useMutation({
    mutationFn: ({ routineId, archived }: { routineId: string; archived: true }) =>
      apiPatch<DBRoutine>(`/api/routines/${encodeURIComponent(routineId)}`, { archived }),
    onSuccess: invalidate,
  });
}
