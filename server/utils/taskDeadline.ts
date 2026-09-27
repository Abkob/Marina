export type DeadlineTask = { id: string; title: string; due_date: string };

export function dateOnly(value: unknown): string | null {
  return typeof value === 'string' && value ? value.slice(0, 10) : null;
}

export function isDeadlineAfter(candidate: unknown, limit: unknown): boolean {
  const candidateDate = dateOnly(candidate);
  const limitDate = dateOnly(limit);
  return Boolean(candidateDate && limitDate && candidateDate > limitDate);
}

export function childDeadlineError(parent: DeadlineTask): string {
  return `Child task deadline must be on or before parent task "${parent.title}" deadline (${dateOnly(parent.due_date)}).`;
}

/**
 * The task card exposes one deadline control (`due_date`). Keep the hidden
 * planning target aligned with that user-visible value so downstream planning
 * cannot continue using an older invisible date. An existing hard deadline is
 * also moved/cleared because the card is the only task deadline editor.
 * Explicit target/hard values in the same request always win.
 */
export function synchronizedTaskDeadlineUpdates(
  body: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  if (!('due_date' in body)) return {};
  const deadline = body.due_date;
  const synced: Record<string, unknown> = {};
  if (!('target_date' in body)) synced.target_date = deadline;
  if (!('hard_deadline' in body) && existing.hard_deadline != null) {
    synced.hard_deadline = deadline;
  }
  return synced;
}
