/** Read-time archive scope. UNION (not UNION ALL) also terminates malformed task cycles.
 * SQL arguments below are code-owned column expressions, never request input.
 * Nothing is deleted: restoring a goal makes its whole branch visible again.
 */
export const ARCHIVE_SCOPE_SQL = `WITH RECURSIVE
  archived_goals AS (SELECT id FROM goals WHERE archived_at IS NOT NULL),
  archived_milestones AS (SELECT id FROM goal_milestones WHERE goal_id IN (SELECT id FROM archived_goals)),
  archived_tasks AS (
    SELECT id FROM tasks WHERE goal_id IN (SELECT id FROM archived_goals)
      OR milestone_id IN (SELECT id FROM archived_milestones)
    UNION
    SELECT child.id FROM tasks child JOIN archived_tasks parent ON child.parent_task_id = parent.id
  ),
  archived_meetings AS (
    SELECT m.id FROM meetings m WHERE m.goal_id IN (SELECT id FROM archived_goals)
      OR m.milestone_id IN (SELECT id FROM archived_milestones)
      OR (EXISTS (SELECT 1 FROM edges e WHERE e.source_type='meeting' AND e.source_id=m.id AND e.target_type='task' AND e.relationship='linked_to')
        AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_type='meeting' AND e.source_id=m.id AND e.target_type='task' AND e.relationship='linked_to' AND e.target_id NOT IN (SELECT id FROM archived_tasks)))
  ),
  archived_owners AS (
    SELECT 'goal:' || id AS entity_key FROM archived_goals
    UNION SELECT 'task:' || id FROM archived_tasks
    UNION SELECT 'milestone:' || id FROM archived_milestones
    UNION SELECT 'meeting:' || id FROM archived_meetings
  ),
  archived_resources AS (
    SELECT r.id FROM resources r
    WHERE EXISTS (SELECT 1 FROM edges e WHERE e.source_type='resource' AND e.source_id=r.id AND e.relationship='attached_to'
      AND (e.target_type || ':' || e.target_id) IN (SELECT entity_key FROM archived_owners))
    AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_type='resource' AND e.source_id=r.id AND e.relationship='attached_to'
      AND (e.target_type || ':' || e.target_id) NOT IN (SELECT entity_key FROM archived_owners))
  ),
  archived_events AS (
    SELECT e.id FROM events e
    WHERE EXISTS (SELECT 1 FROM event_task_links link WHERE link.event_id=e.id)
    AND NOT EXISTS (SELECT 1 FROM event_task_links link WHERE link.event_id=e.id AND link.task_id NOT IN (SELECT id FROM archived_tasks))
  ),
  archived_entities AS (
    SELECT entity_key FROM archived_owners
    UNION SELECT 'resource:' || id FROM archived_resources
    UNION SELECT 'resource_chunk:' || id FROM resource_chunks WHERE resource_id IN (SELECT id FROM archived_resources)
    UNION SELECT 'event:' || id FROM archived_events
    UNION SELECT 'task_note:' || id FROM task_notes WHERE task_id IN (SELECT id FROM archived_tasks)
    UNION SELECT 'note:' || id FROM task_notes WHERE task_id IN (SELECT id FROM archived_tasks)
  )`;

function outside(column: string, table: string) {
  return `(${column} IS NULL OR ${column} NOT IN (${ARCHIVE_SCOPE_SQL} SELECT id FROM ${table}))`;
}
export const activeGoalSql = (column = 'goal_id') => outside(column, 'archived_goals');
export const activeTaskSql = (column = 'id') => outside(column, 'archived_tasks');
export const activeMilestoneSql = (column = 'id') => outside(column, 'archived_milestones');
export const activeMeetingSql = (column = 'id') => outside(column, 'archived_meetings');
export const activeEventSql = (column = 'id') => outside(column, 'archived_events');
export const activeResourceSql = (column = 'id') => outside(column, 'archived_resources');
export const activeEntitySql = (type: string, id: string) =>
  `(${id} IS NULL OR (${type} || ':' || ${id}) NOT IN (${ARCHIVE_SCOPE_SQL} SELECT entity_key FROM archived_entities))`;

// Proposals keep their payload as text, including legacy malformed JSON. Inspect
// references without a database cast so one old proposal cannot break the page.
export function proposalTouchesArchive(proposal: Record<string, unknown>, archived: Set<string>): boolean {
  const linked = (type: unknown, id: unknown) => typeof type === 'string' && typeof id === 'string' && archived.has(`${type}:${id}`);
  if (linked(proposal.source_type, proposal.source_id)) return true;
  const inspect = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(inspect);
    if (!value || typeof value !== 'object') return false;
    const data = value as Record<string, unknown>;
    if (linked(data.entity_type, data.entity_id) || linked(data.target_type, data.target_id) || linked(data.source_type, data.source_id)) return true;
    for (const [key, item] of Object.entries(data)) {
      const type = key === 'parent_task_id' ? 'task' : key.replace(/_ids?$/, '');
      if (/_ids?$/.test(key) && (Array.isArray(item) ? item : [item]).some(id => linked(type, id))) return true;
      if (inspect(item)) return true;
    }
    return false;
  };
  try {
    return inspect(typeof proposal.action_payload === 'string' ? JSON.parse(proposal.action_payload) : proposal.action_payload);
  } catch { return false; }
}
