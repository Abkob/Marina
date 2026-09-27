import { isRoutinesSchemaMissing, listRoutineEntries, listRoutines } from './routines.js';
import { addRoutineDays, routineReservations, routineWeekStart } from '../../src/utils/routines.js';
import type { RoutineReservation } from '../../src/types/routines.js';

/** Read only: full boundary weeks keep weekly quotas stable across view changes. */
export async function loadRoutineReservations(from: string, to: string, today: string): Promise<RoutineReservation[]> {
  try {
    const [routines, entries] = await Promise.all([
      listRoutines(), listRoutineEntries(routineWeekStart(from), addRoutineDays(routineWeekStart(to), 6)),
    ]);
    return routineReservations(routines, entries, from, to, today);
  } catch (error) {
    // A staged deployment may precede its additive migration. Never hide connection failures.
    if (isRoutinesSchemaMissing(error)) return [];
    throw error;
  }
}

export function routineCapacity(reservations: RoutineReservation[]) {
  return reservations.map(routine => ({ date: routine.date, duration_minutes: routine.minutes, routine: true as const }));
}
