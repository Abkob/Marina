/** Product semantics plus real access paths. Tested against registered tools/actions.
 * This is knowledge for the model, never a classifier for the user's wording.
 */
export const COPILOT_FEATURES = [
  { feature: 'routines', read: ['read_routines'], propose: ['create_routine', 'update_routine', 'check_in_routine'],
    meaning: 'Native tracked habits in Schedule > Today’s routines and Work. Daily on selected ISO weekdays (1=Mon,7=Sun), or a flexible weekly session target across eligible days. Targets: minutes, problems, pages, sessions; planned_minutes reserves capacity. Optional preferred_time, optional goal link. Check-ins complete/skip/undo one date; focus timer logs real minutes. Missed days create no entries and are NOT automatically marked skipped; skipping is explicit. No recurring task copies or overdue pile-up. Creation has no end_date. Existing cadence/targets are immutable; update only title/note/archive, preserving history.' },
  { feature: 'calendar', read: ['schedule_range', 'show_schedule_day', 'workspace_context'], propose: ['move_schedule_items'], preview: ['preview_schedule', 'preview_repeating_blocks'],
    meaning: 'Saved time blocks and meetings differ from task deadlines. The built-in scheduler calculates capacity including routine reservations. Repeating blocks are finite dated events, without habit tracking; use only when repeating calendar events are requested. Preview cards require Apply.' },
  { feature: 'tasks', read: ['find_tasks', 'task_details', 'workspace_context', 'overdue_tasks'], propose: ['create_task', 'break_down_task', 'update_task'],
    meaning: 'Finishable work with estimates, status, dependencies, parent/child hierarchy, goal/milestone links, start dates and deadlines. Archived branches stay hidden.' },
  { feature: 'goals_and_milestones', read: ['workspace_context'], propose: ['create_goal', 'create_goal_with_tasks', 'update_goal', 'create_milestone'], meaning: 'Longer outcomes and intermediate deadlines, containing tasks.' },
  { feature: 'resources', read: ['research_search', 'workspace_context'], propose: ['attach_resource'], meaning: 'Saved library content with cited evidence and links to goals/tasks/milestones; not web search.' },
  { feature: 'journal_and_settings', read: ['workspace_context'], meaning: 'Journal and capacity sections expose saved facts. Journal editing, schedule preferences, integrations and focus timer controls are available in their app pages; no chat mutation tool is currently exposed for them.' },
] as const;
