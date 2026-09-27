export type RoutineTargetUnit = 'minutes' | 'problems' | 'pages' | 'sessions';

export interface DBRoutine {
  id: string;
  title: string;
  note: string;
  goal_id: string | null;
  cadence: 'daily' | 'weekly';
  /** ISO weekdays: Monday = 1, Sunday = 7. */
  weekdays: number[];
  weekly_target: number;
  target_count: number;
  target_unit: RoutineTargetUnit;
  planned_minutes: number;
  preferred_time: string | null;
  start_date: string;
  archived_at: string | null;
  /** First inactive local calendar date; archive keeps the current day's history. */
  archived_on?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DBRoutineEntry {
  id: string;
  routine_id: string;
  date: string;
  status: 'completed' | 'skipped' | 'partial';
  minutes: number;
  completed_count: number;
  notes: string;
  created_at: string;
  updated_at: string;
}

export type CreateRoutineInput = Pick<DBRoutine, 'title' | 'note' | 'goal_id' | 'cadence' | 'weekdays' | 'weekly_target' | 'target_count' | 'target_unit' | 'planned_minutes' | 'preferred_time' | 'start_date'>;

export interface RoutineCheckInInput {
  date: string;
  status: 'completed' | 'skipped' | 'pending';
  completed_count?: number;
  notes?: string;
}

export interface RoutineSessionInput {
  /** A client-generated UUID reused for retries. */
  id: string;
  date: string;
  started_at: string;
  ended_at: string;
  minutes: number;
  notes?: string;
}

export interface RoutineReservation {
  routine_id: string;
  title: string;
  date: string;
  minutes: number;
  preferred_time: string | null;
}
