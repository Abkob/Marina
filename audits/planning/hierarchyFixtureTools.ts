import { createCopilotTools } from '../../server/services/copilotTools.js';
import { selectWorkspaceSections } from '../../server/services/copilotWorkspaceGraph.js';
import type { HierarchyAnswerCase } from './hierarchyAnswerFixtures.js';

/** Synthetic adapters retain production parameter schemas. DB parity tests check the facts independently. */
export function createHierarchyFixtureTools(fixture: HierarchyAnswerCase) {
  const facts = fixture.tasks.map(task => {
    const expected = fixture.expected.tasks.find(row => row.id === task.id)!;
    const children = fixture.tasks.filter(row => row.parent_task_id === task.id);
    const ownEstimate = children.length ? expected.own_minutes : task.estimated_minutes;
    return { ...task, goal_id: null, status: task.completed ? 'done' : 'todo', work_version: 1, worklog_version: 1, forecast_revision: 0,
      work_accounting: { estimated_minutes: ownEstimate, logged_minutes: 0, logged_basis: 'none', remaining_minutes: expected.own_minutes,
        remaining_basis: task.completed ? 'completed' : expected.own_minutes === null ? 'unknown' : 'estimate_minus_logged',
        remaining_state: expected.own_minutes === null ? 'unestimated' : 'known', reserved_minutes: 0, unscheduled_minutes: expected.own_minutes, stale_reservation_count: 0 },
      hierarchy: { remaining_minutes: expected.subtree_minutes, known_remaining_minutes: expected.known_subtotal,
        unknown_count: expected.unknown_count, residual_estimated_minutes: ownEstimate, issues: [] },
    };
  });
  // The current production overview is flatter and less complete than task_details.
  // Do not strengthen a live fixture with facts this path does not actually expose.
  const graphTasks = facts.filter(task => !task.completed).map(task => ({ id:task.id,title:task.title,parent_task_id:task.parent_task_id,goal_id:null,
    estimated_minutes:task.estimated_minutes,remaining_minutes:task.work_accounting.remaining_minutes,
    subtree_remaining_minutes:task.hierarchy.remaining_minutes,residual_estimated_minutes:task.hierarchy.residual_estimated_minutes }));
  const workspace = { today: '2026-10-06', planning_coverage: { tasks_in_context: graphTasks.length, total_incomplete: graphTasks.length, task_overview_limit: 200 },
    retrieval_meta: { vector_degraded: false }, graph: { goals: [], milestones: [], tasks: graphTasks }, schedule_prefs: { timezone: 'Asia/Beirut' },
    targeted_task_context: { tasks: facts }, resources: fixture.resources, scheduler_result: null, schedule_horizon_next_14_days: [],
    meetings_next_14_days: [], schedule_overrides: [], attention_queue: [], planning_focus: [], recent_journal: [] };
  const unsupported = async () => { throw new Error('This fixture does not supply that evidence. No application data was read or written.'); };
  const tools = createCopilotTools({ workspace: async (_search, sections) => selectWorkspaceSections(workspace, sections),
    previewSchedule: unsupported, previewRoutine: unsupported, scheduleDay: unsupported, overdueTasks: unsupported });
  for (const tool of Object.values(tools)) tool.execute = unsupported;
  tools.workspace_context.execute = async args => ({ data: selectWorkspaceSections(workspace, args.sections as any) });
  tools.find_tasks.execute = async args => {
    const words = String(args.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const rows = facts.filter(task => words.every(word => `${task.title} ${task.description}`.toLowerCase().includes(word))
      && (!args.parent_task_id || task.parent_task_id === args.parent_task_id) && !args.goal_id && (!args.after || task.id > String(args.after)));
    const selected = rows.sort((a,b) => a.id.localeCompare(b.id)).slice(0, Number(args.limit ?? 30));
    return { data: { tasks: selected.map(({ id, title, parent_task_id, completed, status, estimated_minutes, goal_id }) => ({ id, title, parent_task_id, completed, status, estimated_minutes, goal_id })),
      coverage: { returned: selected.length, has_more: rows.length > selected.length, next_after: rows.length > selected.length ? selected.at(-1)!.id : null,
        order: 'id', search: args.search ?? null, goal_id: args.goal_id ?? null, parent_task_id: args.parent_task_id ?? null } } };
  };
  tools.task_details.execute = async args => {
    const ids = args.task_ids as string[];
    return { data: { tasks: facts.filter(task => ids.includes(task.id) || task.parent_task_id && ids.includes(task.parent_task_id)),
      missing_ids: ids.filter(id => !facts.some(task => task.id === id)), limit: 100, children_has_more: false, more_children_tool: 'find_tasks with parent_task_id' } };
  };
  tools.find_resources.execute = async () => ({ data: { resources: fixture.resources, coverage: { complete: true, contents_read: false } } });
  tools.resource_context.execute = async () => ({ data: { resources: fixture.resources, contents_read: false } });
  tools.read_document.execute = async () => ({ data: { passages: [], coverage: { status: 'unavailable', reason: 'Only metadata is supplied; no source content can be claimed.' } } });
  return { tools, facts };
}
