import { z } from 'zod';
export const resourceScopeSchema = z.object({
  goal_id: z.string().min(1).max(100).optional(),
  task_id: z.string().min(1).max(100).optional(),
  resource_ids: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
  include_subtasks: z.boolean().optional(),
}).strict();
export type ResourceScope = z.infer<typeof resourceScopeSchema>;
export type ResourceSelection = { id: string; title: string; kind: 'goal' | 'task' | 'resource'; include_subtasks?: boolean };
export function scopeKey(scope: ResourceScope = {}) {
  return JSON.stringify([scope.goal_id ?? null, scope.task_id ?? null, Boolean(scope.include_subtasks), [...(scope.resource_ids ?? [])].sort()]);
}
/** Model arguments may narrow selected context, never replace it. */
export function enforceResourceScope(selected: ResourceScope, requested: ResourceScope): ResourceScope {
  for (const key of ['goal_id', 'task_id'] as const) {
    if (selected[key] && requested[key] && selected[key] !== requested[key]) throw new Error('That source is outside the selected chat context. Change the context selection to search it.');
  }
  if (selected.resource_ids && requested.resource_ids?.some(id => !selected.resource_ids!.includes(id))) throw new Error('That document is outside the selected chat context.');
  return { ...requested, ...selected, resource_ids: requested.resource_ids ?? selected.resource_ids };
}
