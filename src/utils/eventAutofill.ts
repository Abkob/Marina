/**
 * Autofill rules for calendar blocks linked to tasks, and the completion
 * state a block inherits from its linked tasks. Pure functions — the
 * composer and the week grid both consume these.
 */

import { accountWork, type WorkInputs } from '../../shared/workAccounting';
export interface AutofillSource extends WorkInputs {
  title: string;
  estimated_minutes: number | null;
}

export interface EventAutofill {
  title: string;
  duration_hours: number;
  planned_minutes: number | null;
}

export const DEFAULT_EVENT_DURATION_HOURS = 1;
const MIN_BLOCK_HOURS = 0.5;
const MAX_BLOCK_HOURS = 4;

/** Minutes of estimated work still unlogged; null when the task has no estimate. */
export function remainingMinutes(
  estimated: number | null | undefined,
  loggedMinutes = 0,
): number | null {
  return accountWork({ estimated_minutes: estimated, logged_minutes: loggedMinutes }).remaining_minutes;
}

/**
 * What a calendar block prefills when a task is linked: the task's title,
 * a duration sized to the remaining estimate (rounded up to 30 min, capped
 * at a 4-hour block), and how many task-minutes this block is planned to cover.
 */
export function autofillFromTask(task: AutofillSource, loggedMinutes = 0): EventAutofill {
  const remaining = accountWork({ ...task, logged_minutes: task.logged_minutes ?? task.actual_minutes ?? loggedMinutes }).remaining_minutes;
  const hasWork = remaining !== null && remaining > 0;
  const duration_hours = hasWork
    ? Math.min(MAX_BLOCK_HOURS, Math.max(MIN_BLOCK_HOURS, Math.ceil(remaining / 30) / 2))
    : DEFAULT_EVENT_DURATION_HOURS;
  return {
    title: task.title,
    duration_hours,
    planned_minutes: hasWork ? Math.min(remaining, Math.round(duration_hours * 60)) : null,
  };
}

export type EventCompletionState = 'none' | 'partial' | 'done';

/** Completion a block inherits from its linked tasks. */
export function eventCompletion(
  links: Array<{ completed?: boolean | null; task_status?: string | null }>,
): EventCompletionState {
  if (!links.length) return 'none';
  const done = links.filter(l => Boolean(l.completed) || l.task_status === 'done').length;
  if (done === links.length) return 'done';
  return done > 0 ? 'partial' : 'none';
}
