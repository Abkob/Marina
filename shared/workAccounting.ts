/** Own-task accounting. Hierarchy aggregation and calendar feasibility are separate concerns. */
export interface WorkInputs {
  estimated_minutes?: unknown;
  actual_minutes?: unknown;
  logged_minutes?: unknown;
  session_count?: unknown;
  completed?: unknown;
  status?: unknown;
  work_version?: unknown;
  worklog_version?: unknown;
  remaining_forecast_minutes?: unknown;
  remaining_forecast_work_version?: unknown;
  remaining_forecast_log_version?: unknown;
  remaining_forecast_updated_at?: unknown;
  forecast_revision?: unknown;
}

export interface WorkAccounting {
  estimated_minutes: number | null;
  logged_minutes: number;
  logged_basis: 'sessions' | 'reported' | 'none';
  remaining_minutes: number | null;
  remaining_basis: 'completed' | 'forecast' | 'estimate_minus_logged' | 'unknown';
  remaining_state: 'known' | 'unestimated' | 'overrun' | 'stale_forecast' | 'invalid';
  reserved_minutes: number;
  unscheduled_minutes: number | null;
  stale_reservation_count: number;
}

export const MAX_WORK_MINUTES = 60_000_000;

/** Database integer minutes and numeric aggregate strings only; never coerce null to zero. */
export function validMinutes(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= MAX_WORK_MINUTES ? number : null;
}

export function accountWork(task: WorkInputs, reservedMinutes = 0, staleReservationCount = 0): WorkAccounting {
  const estimated = validMinutes(task.estimated_minutes);
  // A server aggregate (including zero after deleting the last session) is authoritative.
  const hasAggregate = task.logged_minutes != null;
  const logged = validMinutes(hasAggregate ? task.logged_minutes : task.actual_minutes);
  const hasSessions = Number(task.session_count ?? (hasAggregate ? 1 : 0)) > 0;
  const forecast = validMinutes(task.remaining_forecast_minutes);
  const hasForecast = task.remaining_forecast_minutes != null;
  const fresh = hasForecast && Number(task.remaining_forecast_work_version) === Number(task.work_version)
    && Number(task.remaining_forecast_log_version) === Number(task.worklog_version);
  const result: WorkAccounting = {
    estimated_minutes: estimated,
    logged_minutes: logged ?? 0,
    logged_basis: hasSessions ? 'sessions' : logged != null ? 'reported' : 'none',
    remaining_minutes: null,
    remaining_basis: 'unknown',
    remaining_state: 'unestimated',
    reserved_minutes: validMinutes(reservedMinutes) ?? 0,
    unscheduled_minutes: null,
    stale_reservation_count: Math.max(0, staleReservationCount),
  };
  if (task.completed === true || task.status === 'done') {
    result.remaining_minutes = 0;
    result.remaining_basis = 'completed';
    result.remaining_state = 'known';
  } else if (((hasAggregate || task.actual_minutes != null) && logged === null) || (hasForecast && forecast === null)
    || (task.estimated_minutes != null && estimated === null)) {
    result.remaining_state = 'invalid';
  } else if (hasForecast && !fresh) {
    // A changed scope or corrected log must not silently turn an old forecast into a new one.
    result.remaining_state = 'stale_forecast';
  } else if (fresh && forecast !== null) {
    result.remaining_minutes = forecast;
    result.remaining_basis = 'forecast';
    result.remaining_state = 'known';
  } else if (estimated !== null && estimated > 0) {
    if (estimated > result.logged_minutes) {
      result.remaining_minutes = estimated - result.logged_minutes;
      result.remaining_basis = 'estimate_minus_logged';
      result.remaining_state = 'known';
    } else result.remaining_state = 'overrun';
  }
  if (result.remaining_minutes !== null) result.unscheduled_minutes = Math.max(0, result.remaining_minutes - result.reserved_minutes);
  return result;
}

export interface ReservationRow {
  id: string;
  event_id: string;
  task_id: string;
  planned_minutes: unknown;
  work_version: unknown;
  task_work_version: unknown;
  date: string;
  start_hour: number;
  duration_hours: number;
  canceled?: boolean;
  eligible_from?: string | null;
  eligible_to?: string | null;
}
export interface ReservationWindow { from: string; to: string; today: string; minute: number }

/** Exact task links only. Ambiguous multi-task allocations receive no invented shares. */
export function accountReservations(rows: ReservationRow[], window: ReservationWindow): Map<string, { minutes: number; stale: number }> {
  const events = new Map<string, Map<string, ReservationRow>>();
  for (const row of rows) {
    let links = events.get(row.event_id);
    if (!links) events.set(row.event_id, links = new Map());
    const previous = links.get(row.task_id);
    // Duplicate joined rows are common. Conflicting duplicate IDs fail closed deterministically.
    if (!previous || row.id.localeCompare(previous.id) < 0) links.set(row.task_id, row);
  }
  const result = new Map<string, { minutes: number; stale: number }>();
  const overflowed = new Set<string>();
  for (const links of events.values()) {
    const allocations = [...links.values()];
    const event = allocations[0];
    const start = event.start_hour * 60;
    const duration = Math.round(event.duration_hours * 60);
    if (event.canceled || event.date < window.from || event.date > window.to || event.date < window.today
      || !Number.isFinite(start) || validMinutes(duration) === null || duration <= 0) continue;
    if (start < 0 || start >= 1440 || start + duration > 1440) {
      for (const link of allocations) {
        const account = result.get(link.task_id) ?? { minutes: 0, stale: 0 };
        account.stale++; result.set(link.task_id, account);
      }
      continue;
    }
    // A running block is already underway: do not claim its elapsed portion is future capacity.
    const elapsed = event.date === window.today ? Math.max(0, window.minute - start) : 0;
    const future = Math.max(0, Math.floor(duration - elapsed));
    if (!future) continue;
    const explicitTotal = allocations.reduce((sum, link) => sum + (validMinutes(link.planned_minutes) ?? 0), 0);
    const ambiguous = explicitTotal > duration || allocations.some(link => link.planned_minutes == null && allocations.length > 1);
    for (const link of allocations) {
      const account = result.get(link.task_id) ?? { minutes: 0, stale: 0 };
      result.set(link.task_id, account);
      if (link.work_version == null || Number(link.work_version) !== Number(link.task_work_version)
        || (link.eligible_from != null && link.date < link.eligible_from)
        || (link.eligible_to != null && link.date > link.eligible_to)
        || ambiguous || (link.planned_minutes != null && validMinutes(link.planned_minutes) === null)) {
        account.stale++;
        continue;
      }
      const planned = Math.min(duration, validMinutes(link.planned_minutes) ?? duration);
      // Unknown ordering of tasks inside a partly elapsed block: conservative lower bound.
      if (!overflowed.has(link.task_id)) account.minutes += Math.max(0, Math.min(future, planned - elapsed));
      if (account.minutes > MAX_WORK_MINUTES) { account.minutes = 0; account.stale++; overflowed.add(link.task_id); }
    }
  }
  return result;
}
