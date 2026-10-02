import { query } from '../db.js';
import { activeGoalSql, activeResourceSql, activeTaskSql } from '../utils/archiveVisibility.js';

export type ResourceScope = { goal_id?: string; task_id?: string };

// Normalize saved relationships; semantic similarity never invents ownership.
// UNION terminates malformed task cycles and removes repeated mentions.
export const RESOURCE_RELATIONSHIPS_SQL = `WITH RECURSIVE
  visible_tasks AS (SELECT t.* FROM tasks t WHERE ${activeTaskSql('t.id')}),
  resource_task_links AS (
    SELECT e.source_id AS resource_id,t.id AS task_id FROM edges e JOIN visible_tasks t ON t.id=e.target_id
      WHERE e.source_type='resource' AND e.target_type='task' AND e.relationship='attached_to'
    UNION SELECT e.target_id,t.id FROM edges e JOIN visible_tasks t ON t.id=e.source_id
      WHERE e.target_type='resource' AND e.source_type='task' AND e.relationship='mentions'
    UNION SELECT e.target_id,t.id FROM edges e JOIN task_notes n ON n.id=e.source_id JOIN visible_tasks t ON t.id=n.task_id
      WHERE e.target_type='resource' AND e.source_type IN ('note','task_note') AND e.relationship='mentions'
  ),
  task_goal_paths AS (
    SELECT t.id AS task_id,COALESCE(t.goal_id,m.goal_id) AS goal_id FROM visible_tasks t
      LEFT JOIN goal_milestones m ON m.id=t.milestone_id WHERE COALESCE(t.goal_id,m.goal_id) IS NOT NULL
    UNION SELECT child.id,parent.goal_id FROM visible_tasks child JOIN task_goal_paths parent ON parent.task_id=child.parent_task_id
      WHERE child.goal_id IS NULL AND child.milestone_id IS NULL
  ),
  resource_goal_links AS (
    SELECT e.source_id AS resource_id,e.target_id AS goal_id FROM edges e
      WHERE e.source_type='resource' AND e.target_type='goal' AND e.relationship='attached_to'
    UNION SELECT e.target_id,e.source_id FROM edges e
      WHERE e.target_type='resource' AND e.source_type='goal' AND e.relationship='mentions'
    UNION SELECT l.resource_id,p.goal_id FROM resource_task_links l JOIN task_goal_paths p ON p.task_id=l.task_id
  )`;

/** Parameterized filters compose with both retrieval lanes; an empty scope cannot broaden. */
export function resourceScopeSql(scope: ResourceScope, values: unknown[], resourceColumn = 'r.id'): string {
  const clauses: string[] = [];
  if (scope.goal_id) {
    values.push(scope.goal_id);
    clauses.push(`${resourceColumn} IN (${RESOURCE_RELATIONSHIPS_SQL} SELECT l.resource_id FROM resource_goal_links l
      JOIN goals g ON g.id=l.goal_id WHERE g.id=$${values.length} AND ${activeGoalSql('g.id')})`);
  }
  if (scope.task_id) {
    values.push(scope.task_id);
    clauses.push(`${resourceColumn} IN (${RESOURCE_RELATIONSHIPS_SQL}, selected_tasks AS (
      SELECT id FROM visible_tasks WHERE id=$${values.length}
      UNION SELECT t.id FROM visible_tasks t JOIN selected_tasks p ON t.parent_task_id=p.id
    ) SELECT l.resource_id FROM resource_task_links l JOIN selected_tasks t ON t.id=l.task_id)`);
  }
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
}

/** Current relational context is read from SQL, independently of frozen embedding text. */
export async function readResourceContext(resourceIds: string[]) {
  const ids = [...new Set(resourceIds)].slice(0, 20);
  const { rows: resources } = await query<{ id: string; title: string }>(`SELECT r.id,r.title,r.read_state,r.created_at,r.updated_at,
    COALESCE(j.status,'not_started') AS indexing_status,d.checked_at AS last_source_check,d.last_error AS source_check_error,
    CASE WHEN d.file_id IS NOT NULL THEN 'https://drive.google.com/file/d/'||d.file_id||'/view'
      WHEN r.file_path IS NOT NULL THEN '/api/resources/blob/'||r.id ELSE NULL END AS source_url,
    (SELECT COUNT(*)::int FROM resource_chunks c WHERE c.resource_id=r.id) AS indexed_passages,
    (SELECT COUNT(DISTINCT page_start)::int FROM resource_chunks c WHERE c.resource_id=r.id) AS indexed_text_pages
    FROM resources r LEFT JOIN resource_processing_jobs j ON j.resource_id=r.id
    LEFT JOIN resource_drive_files d ON d.resource_id=r.id AND r.file_path LIKE 'gdrive://%'
    WHERE r.id=ANY($1::text[]) AND ${activeResourceSql('r.id')} AND (d.resource_id IS NULL OR d.available) ORDER BY r.id`, [ids]);
  const visibleIds = resources.map(row => row.id);
  const [{ rows: taskRows }, { rows: goalRows }] = await Promise.all([
    query<{ resource_id: string }>(`${RESOURCE_RELATIONSHIPS_SQL} SELECT * FROM (SELECT l.resource_id,t.id,t.title,t.goal_id,t.parent_task_id,
      t.start_date,t.due_date,t.target_date,t.hard_deadline,t.completed,t.estimated_minutes,
      row_number() OVER(PARTITION BY l.resource_id ORDER BY t.id) AS relation_rank
      FROM resource_task_links l JOIN visible_tasks t ON t.id=l.task_id WHERE l.resource_id=ANY($1::text[])) ranked
      WHERE relation_rank<=21 ORDER BY resource_id,relation_rank`, [visibleIds]),
    query<{ resource_id: string }>(`${RESOURCE_RELATIONSHIPS_SQL} SELECT * FROM (SELECT l.resource_id,g.id,g.title,g.deadline,g.start_date,g.target_date,g.hard_deadline,g.status,
      row_number() OVER(PARTITION BY l.resource_id ORDER BY g.id) AS relation_rank
      FROM resource_goal_links l JOIN goals g ON g.id=l.goal_id WHERE l.resource_id=ANY($1::text[]) AND ${activeGoalSql('g.id')}) ranked
      WHERE relation_rank<=21 ORDER BY resource_id,relation_rank`, [visibleIds]),
  ]);
  return { resources: resources.map(resource => {
    const tasks = taskRows.filter(row => row.resource_id === resource.id);
    const goals = goalRows.filter(row => row.resource_id === resource.id);
    return { ...resource, tasks: tasks.slice(0,20), goals: goals.slice(0,20), tasks_has_more: tasks.length>20, goals_has_more: goals.length>20,
      relationship_basis: 'Saved attachments and mentions, including task-note mentions and inherited task goals; not inferred from document content.' };
  }), missing_resource_ids: ids.filter(id => !visibleIds.includes(id)),
  timing_note: 'Deadlines and assigned days are not calendar time blocks. Use schedule_range for actual scheduled events. Indexed text pages exclude image-only pages; this is not a complete visual review.' };
}
