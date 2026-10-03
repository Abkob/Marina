import { entityReferenceSchema, planningId, referenceKey, type EntityReference } from '../../shared/planningContracts.js';
import { query } from '../db.js';
import { activeEntitySql, activeGoalSql } from '../utils/archiveVisibility.js';

const fields: Record<string, EntityReference['kind']> = { task_id: 'task', parent_task_id: 'task', goal_id: 'goal', milestone_id: 'milestone', resource_id: 'resource', routine_id: 'routine' };
export type ActionReference = EntityReference & { field: string };
/** Call only after action/tool schema validation. No IDs are inferred from prose. */
export function actionReferences(params: Record<string, unknown>): ActionReference[] {
  const result: ActionReference[] = [];
  for (const [field, kind] of Object.entries(fields)) if (typeof params[field] === 'string') result.push({ kind, id: params[field] as string, field });
  if (Array.isArray(params.task_ids)) for (const id of params.task_ids) if (typeof id === 'string') result.push({ kind: 'task', id, field: 'task_ids' });
  if (typeof params.target_id === 'string' && ['goal', 'task', 'milestone'].includes(String(params.target_type))) result.push({ kind: params.target_type as 'goal' | 'task' | 'milestone', id: params.target_id, field: 'target_id' });
  return result;
}

const collections: Record<string, EntityReference['kind']> = { tasks: 'task', goals: 'goal', milestones: 'milestone', resources: 'resource', routines: 'routine', targeted_task_context: 'task', day_level_tasks: 'task' };
const documentTools = new Set(['find_resources', 'read_document', 'inspect_document_page', 'search_documents', 'research_search']);

/** Only code-owned structured collections confer identity. Coverage filters,
 * missing IDs, notes, source passages and arbitrary metadata never do. */
export function observedReferences(tool: string, data: unknown): Array<EntityReference & { title?: string }> {
  const found = new Map<string, EntityReference & { title?: string }>();
  const resourceOnly = documentTools.has(tool);
  const add = (kind: EntityReference['kind'], id: unknown, title?: unknown) => {
    const parsed = entityReferenceSchema.safeParse({ kind, id });
    if (!parsed.success || id === 'unassigned') return;
    const key = referenceKey(parsed.data);
    found.set(key, { ...found.get(key), ...parsed.data, ...(typeof title === 'string' ? { title: title.slice(0, 200) } : {}) });
  };
  const queue: Array<{ value: unknown; kind?: EntityReference['kind'] }> = [{ value: data }];
  const seen = new WeakSet<object>(); let visited = 0;
  while (queue.length && visited++ < 4000) {
    const { value, kind } = queue.shift()!;
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { for (const row of value.slice(0, 1000)) queue.push({ value: row, kind }); continue; }
    const row = value as Record<string, unknown>;
    if (kind) {
      add(kind, row.id ?? row[`${kind}_id`], row.title);
      if (!resourceOnly) for (const [field, type] of Object.entries(fields)) if (field !== 'resource_id' || kind === 'resource') add(type, row[field]);
      if (kind === 'task' && !resourceOnly) queue.push({ value: row.children, kind: 'task' });
    }
    if (resourceOnly) {
      add('resource', row.resource_id, row.title);
      // Deliberately stop at evidence records: never inspect passage/metadata objects.
      for (const key of ['resources', 'title_matches', 'evidence', 'previews']) if (row[key]) queue.push({ value: row[key], kind: ['resources', 'title_matches'].includes(key) ? 'resource' : undefined });
    } else {
      for (const [key, type] of Object.entries(collections)) if (row[key]) queue.push({ value: row[key], kind: type });
      for (const key of ['workspace', 'graph']) if (row[key]) queue.push({ value: row[key] });
      if (tool === 'resource_context' && kind === 'resource') {
        queue.push({ value: row.tasks, kind: 'task' }, { value: row.goals, kind: 'goal' });
      }
    }
  }
  return [...found.values()];
}

export const referenceTables = { task: 'tasks', goal: 'goals', resource: 'resources', milestone: 'goal_milestones', routine: 'routines' } as const;
/** Authoritative typed lookup before proposal persistence/expensive previews.
 * Apply independently repeats the typed checks under its existing row locks. */
export async function unavailableReferences(refs: ActionReference[]): Promise<ActionReference[]> {
  if (refs.length > 200) throw new Error('Too many entity references');
  const missing: ActionReference[] = [];
  for (const kind of Object.keys(referenceTables) as EntityReference['kind'][]) {
    const selected = refs.filter(ref => ref.kind === kind);
    if (!selected.length) continue;
    const ids = [...new Set(selected.map(ref => planningId.parse(ref.id)))];
    const active = kind === 'routine' ? `archived_at IS NULL AND ${activeGoalSql()}` : activeEntitySql('$2::text', 'id');
    const { rows } = await query<{ id: string }>(`SELECT id FROM ${referenceTables[kind]} WHERE id=ANY($1::text[]) AND ${active}`, kind === 'routine' ? [ids] : [ids, kind]);
    const existing = new Set(rows.map(row => row.id));
    missing.push(...selected.filter(ref => !existing.has(ref.id)));
  }
  return missing;
}
