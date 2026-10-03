import type pg from 'pg';
import { planningScopeKey, type PlanningScope, type PlanningRoot, type PlanContent } from '../../../shared/planningState.js';
import { activeEntitySql, activeResourceSql } from '../../utils/archiveVisibility.js';
import { resourceScopeSql } from '../resourceContext.js';
import { DRIVE_FILE_ID_SQL, filterRootedDriveRows } from '../driveResourceAccess.js';
import { loadBusyWindow } from '../calendarBusy.js';
import { digest, issuePlanningToken, verifyPlanningToken } from './tokens.js';
import { PlanningError } from './errors.js';

export async function requireRoot(client: pg.PoolClient, root: PlanningRoot) {
  const table = root.kind === 'task' ? 'tasks' : 'goals';
  const { rows } = await client.query(`SELECT * FROM ${table} WHERE id=$1 AND ${activeEntitySql('$2::text', 'id')}`, [root.id, root.kind]);
  if (!rows.length) throw new PlanningError('not_found', 'This task or goal is unavailable or archived.', 404);
  return rows[0];
}
export function rootScope(scope: PlanningScope) {
  return { [scope.root.kind === 'task' ? 'task_id' : 'goal_id']: scope.root.id, include_subtasks: scope.include_subtasks, ...(scope.resource_ids !== undefined ? { resource_ids: scope.resource_ids } : {}) };
}
type ManifestRow = { id: string; title: string; generation: number | null; status: string; file_id: string | null; updated_at: string | null; source_version: string | null };
export async function planningFacts(client: pg.PoolClient, scope: PlanningScope, after?: string) {
  const root = await requireRoot(client, scope.root);
  const params: unknown[] = []; const filter = resourceScopeSql(rootScope(scope), params);
  const from = `FROM resources r LEFT JOIN resource_processing_jobs j ON j.resource_id=r.id
    LEFT JOIN resource_drive_files d ON d.resource_id=r.id
    WHERE ${activeResourceSql('r.id')} AND (d.resource_id IS NULL OR d.available) ${filter}`;
  // SQL aggregates the manifest; no document bodies enter the snapshot or prompt.
  const version = await client.query(`SELECT COUNT(*)::int AS count, md5(COALESCE(string_agg(r.id||':'||COALESCE(r.updated_at,'')||':'||COALESCE(j.version::text,'')||':'||COALESCE(j.status,'')||':'||COALESCE(d.source_version,''), '|' ORDER BY r.id),'')) AS fingerprint ${from}`, params);
  const pageParams = [...params, after ?? '', 21];
  const { rows } = await client.query<ManifestRow>(`SELECT r.id,r.title,r.updated_at,j.version AS generation,COALESCE(j.status,'not_started') AS status,d.source_version,${DRIVE_FILE_ID_SQL} AS file_id ${from} AND r.id>$${params.length+1} ORDER BY r.id LIMIT $${params.length+2}`, pageParams);
  let visible: ManifestRow[];
  try { visible = await filterRootedDriveRows(rows.slice(0, 20), client); }
  catch { throw new PlanningError('source_unavailable', 'Source access could not be verified. Reconnect Drive or try again.', 503, true); }
  if (scope.resource_ids && scope.resource_ids.some(id => !visible.some(row => row.id === id))) throw new PlanningError('scope_mismatch', 'A selected resource is unavailable or is not attached to this task or goal.', 409);
  const calendar = (await loadBusyWindow(scope.from, scope.to, client)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const prefs = await client.query("SELECT * FROM user_schedule_prefs WHERE id='default'");
  const overrides = await client.query('SELECT * FROM schedule_day_overrides WHERE date BETWEEN $1 AND $2 ORDER BY date,id', [scope.from,scope.to]);
  const related = await client.query(`WITH RECURSIVE selected AS (
    SELECT t.id FROM tasks t WHERE ($2='task' AND t.id=$1) OR ($2='goal' AND (t.goal_id=$1 OR t.milestone_id IN (SELECT id FROM goal_milestones WHERE goal_id=$1)))
    UNION SELECT child.id FROM tasks child JOIN selected parent ON child.parent_task_id=parent.id
  ), prerequisites AS (
    SELECT id FROM selected
    UNION SELECT e.source_id FROM edges e JOIN prerequisites p ON p.id=e.target_id WHERE e.source_type='task' AND e.target_type='task' AND e.relationship='blocks'
  ) SELECT md5(COALESCE(string_agg(md5((to_jsonb(t)-ARRAY['updated_at','last_activity_at','position'])::text),'|' ORDER BY t.id),'')) AS tasks,
    (SELECT md5(COALESCE(string_agg(md5((to_jsonb(b)-ARRAY['updated_at','last_activity_at','position'])::text),'|' ORDER BY b.id),'')) FROM tasks b WHERE b.id IN (SELECT id FROM prerequisites)) AS prerequisites,
    (SELECT md5(COALESCE(string_agg(md5(row_to_json(w)::text),'|' ORDER BY w.id),'')) FROM work_sessions w WHERE w.task_id IN (SELECT id FROM selected)) AS progress,
    (SELECT md5(COALESCE(string_agg(md5(row_to_json(e)::text),'|' ORDER BY e.id),'')) FROM edges e WHERE (e.source_type='task' AND e.source_id IN (SELECT id FROM prerequisites)) OR (e.target_type='task' AND e.target_id IN (SELECT id FROM prerequisites))) AS relationships,
    (SELECT md5(COALESCE(string_agg(md5((to_jsonb(m)-ARRAY['updated_at','position'])::text),'|' ORDER BY m.id),'')) FROM goal_milestones m WHERE m.goal_id=CASE WHEN $2='goal' THEN $1 END OR m.id IN (SELECT milestone_id FROM tasks WHERE id IN (SELECT id FROM selected))) AS milestones,
    (SELECT md5(COALESCE(string_agg(md5(row_to_json(d)::text),'|' ORDER BY d.id),'')) FROM goal_deadlines d WHERE d.goal_id=CASE WHEN $2='goal' THEN $1 END OR d.id IN (SELECT deadline_id FROM tasks WHERE id IN (SELECT id FROM selected))) AS deadlines
    FROM tasks t WHERE t.id IN (SELECT id FROM selected)`, [scope.root.id, scope.root.kind]);
  const { updated_at, last_activity_at, position, ...materialRoot }=root;
  const facts = digest({ root:materialRoot, manifest: version.rows[0], related: related.rows[0], calendar, prefs: prefs.rows, overrides: overrides.rows });
  return { root, resources: visible.map(({ file_id, source_version, updated_at, ...row }) => ({ ...row, role: 'unspecified' as const })),
    facts, calendar: calendar.slice(0, 200).map(({ title, kind, ...interval }) => interval), calendar_omitted: Math.max(0, calendar.length-200),
    resources_omitted: Math.max(0, Number(version.rows[0].count)-visible.length), after: rows.length > 20 ? rows[19].id : null };
}
/** Evidence validation is independent of the displayed manifest page. A source
 * on page two must not disappear merely because the UI displays page one. */
export async function verifiedPlanEvidence(client: pg.PoolClient, scope: PlanningScope, content: PlanContent) {
  const ids = [...new Set(content.work_items.flatMap(item => item.evidence.map(source => source.resource.id)))];
  if (!ids.length) return [];
  const params: unknown[] = [ids]; const filter = resourceScopeSql(rootScope(scope), params);
  const { rows } = await client.query<{ id: string; generation: number | null; file_id: string | null }>(`SELECT r.id,j.version AS generation,${DRIVE_FILE_ID_SQL} AS file_id FROM resources r
    LEFT JOIN resource_processing_jobs j ON j.resource_id=r.id LEFT JOIN resource_drive_files d ON d.resource_id=r.id
    WHERE r.id=ANY($1::text[]) AND ${activeResourceSql('r.id')} AND (d.resource_id IS NULL OR d.available) ${filter}`, params);
  try { return await filterRootedDriveRows(rows, client); }
  catch { throw new PlanningError('source_unavailable','Source access could not be verified. Reconnect Drive or try again.',503,true); }
}
export function contextTokens(scope: PlanningScope, facts: Awaited<ReturnType<typeof planningFacts>>, revision: number, after?: string) {
  const claims = { scope: digest(planningScopeKey(scope)), facts: facts.facts, revision };
  return { snapshot_token: issuePlanningToken({ ...claims, purpose: 'snapshot', ...(after ? { after } : {}) }),
    next_cursor: facts.after ? issuePlanningToken({ ...claims, purpose: 'cursor', after: facts.after }) : null };
}
export async function validateSnapshot(client: pg.PoolClient, scope: PlanningScope, token: string, revision: number) {
  const claims = verifyPlanningToken(token, 'snapshot', digest(planningScopeKey(scope)));
  if (claims.revision !== revision) throw new PlanningError('stale_revision', 'A newer plan revision exists. Keep your draft and review the latest plan.', 409, true);
  const facts = await planningFacts(client, scope, claims.after);
  if (claims.facts !== facts.facts) throw new PlanningError('snapshot_stale', 'Tasks, resources or calendar context changed. Refresh and review your edit.', 409, true);
  return facts;
}
export function redactUnavailableEvidence(content: PlanContent, resources: Array<{ id: string; generation: number | null }>) {
  const available = new Map(resources.map(row => [row.id, row.generation])); let redacted = 0;
  const work_items = content.work_items.map(item => {
    if (item.evidence.some(source => !available.has(source.resource.id) || (source.generation !== null && available.get(source.resource.id) !== source.generation))) {
      redacted++; return { ...item, title: 'Source-based work needs review', effort: { state: 'unknown' as const, minutes: null }, evidence: [] };
    }
    return item;
  });
  return { content: { ...content, work_items }, redacted };
}
