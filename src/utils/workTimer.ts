export const WORK_TIMER_STORAGE_KEY = 'marina-work-active-timer';

export type ActiveWorkTimer = {
  taskId: string;
  startedAt: string;
  notes: string;
  routineId?: string;
  routineTitle?: string;
  goalId?: string | null;
  routineDate?: string;
  /** Stable across reloads and failed saves so retries cannot double-log time. */
  sessionId?: string;
};

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseTimer(value: unknown): ActiveWorkTimer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = value as Partial<ActiveWorkTimer>;
  if (typeof parsed.taskId !== 'string'
    || typeof parsed.startedAt !== 'string'
    || !Number.isFinite(Date.parse(parsed.startedAt))
    || (parsed.notes !== undefined && typeof parsed.notes !== 'string')) return null;

  const base = { taskId: parsed.taskId, startedAt: parsed.startedAt, notes: parsed.notes ?? '' };
  if (parsed.routineId !== undefined) {
    if (parsed.taskId !== '' || typeof parsed.routineId !== 'string' || !parsed.routineId.trim()
      || typeof parsed.routineTitle !== 'string' || !parsed.routineTitle.trim()
      || !validDate(parsed.routineDate)
      || typeof parsed.sessionId !== 'string' || !parsed.sessionId.trim()
      || (parsed.goalId !== undefined && parsed.goalId !== null && typeof parsed.goalId !== 'string')) return null;
    return {
      ...base,
      routineId: parsed.routineId,
      routineTitle: parsed.routineTitle,
      goalId: parsed.goalId ?? null,
      routineDate: parsed.routineDate,
      sessionId: parsed.sessionId,
    };
  }
  return parsed.taskId.trim() ? base : null;
}

export function readActiveWorkTimer(): ActiveWorkTimer | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(WORK_TIMER_STORAGE_KEY);
    if (!raw) return null;
    return parseTimer(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeActiveWorkTimer(timer: ActiveWorkTimer | null) {
  if (typeof window === 'undefined') return;
  try {
    if (timer) {
      const validTimer = parseTimer(timer);
      if (validTimer) window.localStorage?.setItem(WORK_TIMER_STORAGE_KEY, JSON.stringify(validTimer));
    }
    else window.localStorage?.removeItem(WORK_TIMER_STORAGE_KEY);
  } catch {
    // Storage can be disabled by the browser; callers keep their in-memory state.
  }
}
