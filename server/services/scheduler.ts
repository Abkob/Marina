// Pure deterministic scheduler. No database calls. No LLM. Fully testable.
// The LLM receives SchedulerResult and explains it — it never does the math.

export interface SchedulerTask {
  id: string;
  title: string;
  estimated_minutes: number;
  /** Distinguishes a real estimate reduced to zero from a missing estimate. */
  has_estimate?: boolean;
  /** Earliest date on which this task may receive work. */
  start_date?: string | null;
  due_date: string | null;
  priority: 'high' | 'medium' | 'low' | string;
  blocker_ids: string[];
  max_daily_minutes?: number;
}

export interface SchedulerMeeting {
  date: string;    // YYYY-MM-DD
  duration_minutes: number;
  /** Routine time is reserved even when a day has a manual capacity override. */
  routine?: boolean;
}

export interface SchedulerPrefs {
  work_days: number[];              // 0=Sun … 6=Sat (getDay() convention)
  daily_capacity_minutes: number;
  buffer_ratio: number;             // 0–1 fraction to reserve
  work_start?: number;
  work_end?: number;
  /** IANA timezone string (e.g. 'Asia/Beirut'). Used to determine today when start_date is not provided. */
  timezone?: string;
}

export interface SchedulerOverride {
  date: string;             // YYYY-MM-DD
  available_minutes: number;
}

export interface SchedulerInput {
  tasks: SchedulerTask[];
  meetings: SchedulerMeeting[];
  prefs: SchedulerPrefs;
  overrides: SchedulerOverride[];
  horizon_days: number;
  /** Inject a fixed start date (YYYY-MM-DD) for deterministic tests. Defaults to local today. */
  start_date?: string;
}

export interface DayAssignment {
  date: string;
  available_minutes: number;
  routine_minutes?: number;
  used_minutes: number;
  task_ids: string[];
  /** Exact minutes the scheduler allocated to each task on this day. */
  task_minutes: Record<string, number>;
}

export interface TaskScheduleDiagnosticDay {
  date: string;
  capacity_minutes: number;
  committed_before_minutes: number;
  available_before_minutes: number;
  allocated_minutes: number;
}

export interface TaskScheduleDiagnostic {
  task_id: string;
  outcome: 'fit' | 'overflow' | 'unestimated';
  required_minutes: number;
  due_date: string | null;
  earliest_date: string;
  available_before_deadline_minutes: number;
  allocated_minutes: number;
  shortfall_minutes: number;
  /** Work placed in the horizon after the on-time attempt failed. */
  recovery_allocated_minutes: number;
  /** Projected recovery finish when the remaining task fits in the horizon. */
  recovery_finish_date: string | null;
  /** Work still unplaced after both the deadline attempt and recovery pass. */
  unscheduled_minutes: number;
  days: TaskScheduleDiagnosticDay[];
}

export interface SchedulerResult {
  status: 'feasible' | 'tight' | 'risky' | 'impossible';
  total_available_minutes: number;
  total_required_minutes: number;
  gap_minutes: number;                // positive = surplus, negative = overflow
  tasks_fit: string[];
  tasks_overflow: string[];
  unestimated_task_ids: string[];     // flagged separately, not scheduled
  cycle_task_ids: string[];           // tasks involved in dependency cycles
  day_assignments: DayAssignment[];
  capacity_days: DayAssignment[];     // every work day in the horizon, including unused days
  task_diagnostics: TaskScheduleDiagnostic[];
  impossible_reason?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseYMD(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function priorityRank(p: string): number {
  if (p === 'high') return 1;
  if (p === 'medium') return 2;
  if (p === 'low') return 3;
  return 4;
}

// Kahn's algorithm — returns tasks in topological order (blockers first).
// Tasks not in the input set are treated as already-complete external blockers.
// Returns cycled IDs separately so the caller can flag them.
export function detectDependencyCycles(tasks: SchedulerTask[]): string[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const inDegree = new Map(tasks.map(t => [t.id, 0]));
  const edges = new Map<string, string[]>();
  for (const t of tasks) {
    for (const bid of t.blocker_ids) {
      if (!byId.has(bid)) continue;
      if (!edges.has(bid)) edges.set(bid, []);
      edges.get(bid)!.push(t.id);
      inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
    }
  }
  const queue = tasks.filter(t => (inDegree.get(t.id) ?? 0) === 0).map(t => t.id);
  const reached = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    reached.add(id);
    for (const nextId of edges.get(id) ?? []) {
      const deg = (inDegree.get(nextId) ?? 0) - 1;
      inDegree.set(nextId, deg);
      if (deg === 0) queue.push(nextId);
    }
  }
  return tasks.filter(t => !reached.has(t.id)).map(t => t.id);
}

function topologicalSort(tasks: SchedulerTask[]): SchedulerTask[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const inDegree = new Map(tasks.map(t => [t.id, 0]));
  const edges = new Map<string, string[]>(); // blocker → blocked

  for (const t of tasks) {
    for (const bid of t.blocker_ids) {
      if (!byId.has(bid)) continue; // blocker not in input set — skip
      if (!edges.has(bid)) edges.set(bid, []);
      edges.get(bid)!.push(t.id);
      inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
    }
  }

  const queue = tasks
    .filter(t => (inDegree.get(t.id) ?? 0) === 0)
    .sort((a, b) => {
      // Among unblocked, sort by due_date then priority
      const da = a.due_date ?? '9999-12-31';
      const db = b.due_date ?? '9999-12-31';
      if (da !== db) return da < db ? -1 : 1;
      return priorityRank(a.priority) - priorityRank(b.priority);
    });

  const result: SchedulerTask[] = [];
  const inQueue = new Set(queue.map(t => t.id));

  while (queue.length) {
    // Pop the highest-priority item (sorted each step to keep ordering stable)
    const t = queue.shift()!;
    result.push(t);
    for (const nextId of edges.get(t.id) ?? []) {
      const newDegree = (inDegree.get(nextId) ?? 0) - 1;
      inDegree.set(nextId, newDegree);
      if (newDegree === 0 && !inQueue.has(nextId)) {
        const next = byId.get(nextId)!;
        // Insert in due_date/priority order
        const pos = queue.findIndex(q =>
          (q.due_date ?? '9999-12-31') > (next.due_date ?? '9999-12-31') ||
          ((q.due_date ?? '9999-12-31') === (next.due_date ?? '9999-12-31') && priorityRank(q.priority) > priorityRank(next.priority)),
        );
        if (pos === -1) queue.push(next);
        else queue.splice(pos, 0, next);
        inQueue.add(nextId);
      }
    }
  }

  // Tasks not reached (cycles) — append at end sorted by due_date/priority
  const reached = new Set(result.map(t => t.id));
  const cycled = tasks
    .filter(t => !reached.has(t.id))
    .sort((a, b) => {
      const da = a.due_date ?? '9999-12-31';
      const db = b.due_date ?? '9999-12-31';
      if (da !== db) return da < db ? -1 : 1;
      return priorityRank(a.priority) - priorityRank(b.priority);
    });
  return [...result, ...cycled];
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function computeSchedule(input: SchedulerInput): SchedulerResult {
  const { tasks, meetings, prefs, overrides, horizon_days, start_date } = input;

  // Split off unestimated tasks — they can't be scheduled
  const covered = tasks.filter(t => (!t.estimated_minutes || t.estimated_minutes <= 0) && t.has_estimate === true);
  const unestimated = tasks.filter(t => (!t.estimated_minutes || t.estimated_minutes <= 0) && t.has_estimate !== true);
  const estimable = tasks.filter(t => t.estimated_minutes > 0);

  // Build work-day capacity map
  // When start_date is not injected, derive today from the configured timezone so
  // the scheduler agrees with the user's wall-clock date, not the server's system timezone.
  const todayStr = start_date ?? (
    prefs.timezone
      ? new Intl.DateTimeFormat('en-CA', { timeZone: prefs.timezone }).format(new Date())
      : toYMD(new Date())
  );
  const today = parseYMD(todayStr);
  today.setHours(0, 0, 0, 0);
  const overrideMap = new Map(overrides.map(o => [o.date, o.available_minutes]));
  const meetingMinutesByDay = new Map<string, number>();
  const routineMinutesByDay = new Map<string, number>();
  for (const m of meetings) {
    const destination = m.routine ? routineMinutesByDay : meetingMinutesByDay;
    destination.set(m.date, (destination.get(m.date) ?? 0) + Math.max(0, m.duration_minutes));
  }

  const workDaySet = new Set(prefs.work_days);
  const rawCapacity = prefs.daily_capacity_minutes;
  const bufferedCapacity = Math.round(rawCapacity * (1 - (prefs.buffer_ratio ?? 0)));

  // Generate day slots for the horizon
  const days: DayAssignment[] = [];
  for (let i = 0; i < horizon_days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const ymd = toYMD(d);
    const dow = d.getDay(); // 0=Sun

    if (!workDaySet.has(dow) && !overrideMap.has(ymd)) continue;

    let avail: number;
    if (overrideMap.has(ymd)) {
      avail = overrideMap.get(ymd)!;
    } else {
      avail = bufferedCapacity - (meetingMinutesByDay.get(ymd) ?? 0);
    }
    const routineMinutes = routineMinutesByDay.get(ymd) ?? 0;
    avail = Math.max(0, avail - routineMinutes);

    days.push({ date: ymd, available_minutes: avail, ...(routineMinutes > 0 ? { routine_minutes: routineMinutes } : {}), used_minutes: 0, task_ids: [], task_minutes: {} });
  }

  const totalAvailable = days.reduce((s, d) => s + d.available_minutes, 0);
  const totalRequired = estimable.reduce((s, t) => s + t.estimated_minutes, 0);

  // Track when each task is assigned so blocked tasks can be deferred past their blockers
  const taskAssignedDate = new Map<string, string>();

  // Detect dependency cycles before scheduling — cycled tasks can still be allocated
  // but are reported separately so callers can warn the user.
  const cycleTaskIds = detectDependencyCycles(estimable);

  // Topological sort respects blocker ordering
  const sorted = topologicalSort(estimable);

  const tasksFit: string[] = covered.map(task => task.id);
  const tasksOverflow: string[] = [];
  const zeroMinuteDiagnostic = (task: SchedulerTask, outcome: 'fit' | 'unestimated'): TaskScheduleDiagnostic => ({
    task_id: task.id,
    outcome,
    required_minutes: 0,
    due_date: task.due_date,
    earliest_date: task.start_date && task.start_date > todayStr ? task.start_date : todayStr,
    available_before_deadline_minutes: 0,
    allocated_minutes: 0,
    shortfall_minutes: 0,
    recovery_allocated_minutes: 0,
    recovery_finish_date: null,
    unscheduled_minutes: 0,
    days: [],
  });
  const taskDiagnostics: TaskScheduleDiagnostic[] = [
    ...covered.map(task => zeroMinuteDiagnostic(task, 'fit')),
    ...unestimated.map(task => zeroMinuteDiagnostic(task, 'unestimated')),
  ];

  for (const task of sorted) {
    // Earliest possible date: today, the task/goal timeline start, or the date
    // on which all blockers have been fully scheduled â€” whichever is latest.
    let earliestDate = task.start_date && task.start_date > todayStr ? task.start_date : todayStr;
    for (const bid of task.blocker_ids) {
      const bd = taskAssignedDate.get(bid);
      if (bd && bd > earliestDate) earliestDate = bd;
    }

    // Must be completed by due_date
    const deadline = task.due_date ?? null;

    // Greedily fill partial days (task splitting). A task may span multiple
    // work days — each day absorbs whatever capacity it has available until
    // the task's remaining minutes reach zero.
    let minutesLeft = task.estimated_minutes;
    let lastDayUsed: string | null = null;
    const allocations: Array<{ day: DayAssignment; allocated: number }> = [];
    const diagnosticDays: TaskScheduleDiagnosticDay[] = [];

    for (const day of days) {
      if (minutesLeft <= 0) break;
      if (day.date < earliestDate) continue;
      if (deadline && day.date > deadline) break;

      const freeMinutes = day.available_minutes - day.used_minutes;
      if (freeMinutes <= 0) continue;

      const allocate = Math.min(
        freeMinutes,
        minutesLeft,
        task.max_daily_minutes ?? Number.POSITIVE_INFINITY,
      );
      diagnosticDays.push({
        date: day.date,
        capacity_minutes: day.available_minutes,
        committed_before_minutes: day.used_minutes,
        available_before_minutes: freeMinutes,
        allocated_minutes: allocate,
      });
      day.used_minutes += allocate;
      if (!day.task_ids.includes(task.id)) day.task_ids.push(task.id);
      day.task_minutes[task.id] = (day.task_minutes[task.id] ?? 0) + allocate;
      minutesLeft -= allocate;
      lastDayUsed = day.date;
      allocations.push({ day, allocated: allocate });
    }

    if (minutesLeft <= 0 && lastDayUsed !== null) {
      taskAssignedDate.set(task.id, lastDayUsed);
      tasksFit.push(task.id);
      taskDiagnostics.push({
        task_id: task.id,
        outcome: 'fit',
        required_minutes: task.estimated_minutes,
        due_date: deadline,
        earliest_date: earliestDate,
        available_before_deadline_minutes: diagnosticDays.reduce((sum, day) => sum + day.available_before_minutes, 0),
        allocated_minutes: task.estimated_minutes,
        shortfall_minutes: 0,
        recovery_allocated_minutes: 0,
        recovery_finish_date: null,
        unscheduled_minutes: 0,
        days: diagnosticDays,
      });
    } else {
      // Roll back all partial allocations so other tasks can use this capacity
      for (const { day, allocated } of allocations) {
        day.used_minutes -= allocated;
        day.task_ids = day.task_ids.filter(id => id !== task.id);
        delete day.task_minutes[task.id];
      }
      tasksOverflow.push(task.id);
      const allocatedMinutes = allocations.reduce((sum, allocation) => sum + allocation.allocated, 0);
      taskDiagnostics.push({
        task_id: task.id,
        outcome: 'overflow',
        required_minutes: task.estimated_minutes,
        due_date: deadline,
        earliest_date: earliestDate,
        available_before_deadline_minutes: diagnosticDays.reduce((sum, day) => sum + day.available_before_minutes, 0),
        allocated_minutes: allocatedMinutes,
        shortfall_minutes: Math.max(0, minutesLeft),
        recovery_allocated_minutes: 0,
        recovery_finish_date: null,
        unscheduled_minutes: task.estimated_minutes,
        days: diagnosticDays,
      });
    }
  }

  // A missed or impossible cutoff must not make work disappear from the plan.
  // Once every task that can still finish on time has claimed capacity, use the
  // remaining horizon for best-effort recovery slices, earliest deadline first.
  // Deadline diagnostics above remain unchanged: recovery is a plan from now,
  // not a claim that the original cutoff can still be met.
  const overflowById = new Map(sorted.map(task => [task.id, task]));
  for (const diagnostic of taskDiagnostics) {
    if (diagnostic.outcome !== 'overflow') continue;
    const task = overflowById.get(diagnostic.task_id);
    if (!task) continue;

    let recoveryLeft = task.estimated_minutes;
    let recoveryAllocated = 0;
    let recoveryFinishDate: string | null = null;
    for (const day of days) {
      if (recoveryLeft <= 0) break;
      if (day.date < diagnostic.earliest_date) continue;

      const freeMinutes = day.available_minutes - day.used_minutes;
      if (freeMinutes <= 0) continue;
      const alreadyAllocatedToday = day.task_minutes[task.id] ?? 0;
      const taskDayCapacity = Math.max(
        0,
        (task.max_daily_minutes ?? Number.POSITIVE_INFINITY) - alreadyAllocatedToday,
      );
      const allocate = Math.min(freeMinutes, recoveryLeft, taskDayCapacity);
      if (allocate <= 0) continue;

      day.used_minutes += allocate;
      if (!day.task_ids.includes(task.id)) day.task_ids.push(task.id);
      day.task_minutes[task.id] = alreadyAllocatedToday + allocate;
      recoveryLeft -= allocate;
      recoveryAllocated += allocate;
      recoveryFinishDate = recoveryLeft <= 0 ? day.date : null;
    }

    diagnostic.recovery_allocated_minutes = recoveryAllocated;
    diagnostic.recovery_finish_date = recoveryFinishDate;
    diagnostic.unscheduled_minutes = Math.max(0, recoveryLeft);
  }

  const gap = totalAvailable - totalRequired;

  // Determine status
  let status: SchedulerResult['status'];
  let impossibleReason: string | undefined;

  if (tasksOverflow.length > 0) {
    status = 'impossible';
    const overflowDiagnostics = taskDiagnostics.filter(item => item.outcome === 'overflow');
    const overdueCount = overflowDiagnostics.filter(item => Boolean(item.due_date && item.due_date < todayStr)).length;
    const activeFailures = overflowDiagnostics.filter(item => !item.due_date || item.due_date >= todayStr);
    const activeShortfall = activeFailures.reduce((sum, item) => sum + item.shortfall_minutes, 0);
    const reasonParts = [`${tasksOverflow.length} task(s) cannot be scheduled in time.`];
    if (overdueCount > 0) reasonParts.push(`${overdueCount} already past their deadline${overdueCount === 1 ? '' : 's'}.`);
    if (activeFailures.length > 0) {
      reasonParts.push(`${activeFailures.length} still ${activeFailures.length === 1 ? 'has' : 'have'} ${activeShortfall} minutes unfinished at the deadline or planning cutoff.`);
    }
    impossibleReason = reasonParts.join(' ');
  } else {
    const utilisationRatio = totalRequired / Math.max(1, totalAvailable);
    const lastUsedDay = days.filter(d => d.used_minutes > 0).at(-1);
    const isLastDay = lastUsedDay?.date === days.at(-1)?.date;

    if (utilisationRatio > 0.9 || isLastDay) status = 'tight';
    else if (utilisationRatio > 0.75) status = 'risky';
    else status = 'feasible';
  }

  const cycleNote = cycleTaskIds.length > 0
    ? ` ${cycleTaskIds.length} task(s) have dependency cycles.`
    : '';
  const fullReason = impossibleReason
    ? impossibleReason + cycleNote
    : cycleNote || undefined;

  return {
    status,
    total_available_minutes: totalAvailable,
    total_required_minutes: totalRequired,
    gap_minutes: gap,
    tasks_fit: tasksFit,
    tasks_overflow: tasksOverflow,
    unestimated_task_ids: unestimated.map(t => t.id),
    cycle_task_ids: cycleTaskIds,
    day_assignments: days.filter(d => d.task_ids.length > 0 || d.used_minutes > 0),
    capacity_days: days.map(day => ({ ...day, task_ids: [...day.task_ids] })),
    task_diagnostics: taskDiagnostics,
    ...(fullReason ? { impossible_reason: fullReason } : {}),
  };
}
