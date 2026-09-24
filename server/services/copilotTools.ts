import { z } from 'zod';
import { query } from '../db.js';
import { activeTaskSql, activeEventSql, activeMeetingSql } from '../utils/archiveVisibility.js';
import { ActionParamsSchemas } from './actionValidation.js';
import { searchResearchEvidence } from './researchRag.js';
import { eventDateServer } from './planLayout.js';
import type { ConversationTool } from './copilotConversation.js';
import { WORKSPACE_SECTIONS, type WorkspaceSection } from './copilotWorkspaceGraph.js';

export async function readCopilotClock() {
  const { rows } = await query<{ timezone: string | null }>("SELECT timezone FROM user_schedule_prefs WHERE id='default'");
  const timezone = rows[0]?.timezone || 'UTC';
  const now = new Date();
  return {
    today: new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now),
    time: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now),
    timezone,
  };
}

const day = z.iso.date();
const rangeSchema = z.object({ from: day, to: day }).strict().refine(
  value => value.to >= value.from && Date.parse(value.to) - Date.parse(value.from) <= 31 * 86_400_000,
  { message: 'Use an ordered date range of at most 32 days.' },
);

export function createCopilotTools(dependencies: {
  workspace: (search?: string, sections?: WorkspaceSection[]) => Promise<unknown>;
  previewSchedule: (args: Record<string, unknown>) => Promise<unknown>;
  previewRoutine: (args: Record<string, unknown>) => Promise<unknown>;
  scheduleDay: (date: string) => Promise<unknown>;
  overdueTasks: () => Promise<unknown>;
}): Record<string, ConversationTool> {
  return {
    workspace_context: {
      description: 'Read a compact workspace graph and capacity ledger. Choose sections to avoid unrelated data: tasks, capacity, attention, details, journal, resources. Default: tasks+capacity+attention; with search: tasks+details. The task overview is capped at 200; use find_tasks to search/page beyond it. Details expands search matches. Coverage is explicit, not a completeness claim. No writes.',
      parameters: z.object({ search: z.string().max(500).optional(), sections: z.array(z.enum(WORKSPACE_SECTIONS)).min(1).max(6).optional() }).strict(),
      execute: async args => ({ data: await dependencies.workspace(args.search as string | undefined, args.sections as WorkspaceSection[] | undefined) }),
    },
    find_tasks: {
      description: 'Find exact task IDs without loading the entire workspace. Search literal words in title/description, optionally filter goal_id or parent_task_id. Omit search to page all active tasks (including completed tasks). Read next_after pages when present; no match is not permission to choose a different task. Use task_details for descriptions and current values.',
      parameters: z.object({ search: z.string().trim().min(1).max(300).optional(), goal_id: z.string().min(1).optional(), parent_task_id: z.string().min(1).optional(), after: z.string().min(1).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
      execute: async args => {
        const limit = Number(args.limit ?? 30);
        const values: unknown[] = [];
        const conditions = [activeTaskSql('t.id')];
        if (args.search) {
          // Search is a literal retrieval operation chosen by the model, never an intent router.
          const words = String(args.search).trim().split(/\s+/).filter(Boolean);
          for (const word of words) {
            values.push(`%${word.replace(/[\\%_]/g, '\\$&')}%`);
            conditions.push(`(t.title ILIKE $${values.length} OR COALESCE(t.description,'') ILIKE $${values.length})`);
          }
        }
        for (const key of ['goal_id', 'parent_task_id'] as const) if (args[key]) {
          values.push(args[key]); conditions.push(`t.${key} = $${values.length}`);
        }
        if (args.after) { values.push(args.after); conditions.push(`t.id > $${values.length}`); }
        values.push(limit + 1);
        const { rows } = await query<{ id: string }>(`SELECT t.id,t.title,t.goal_id,t.parent_task_id,t.milestone_id,t.status,t.completed,t.priority,
          t.start_date,t.due_date,t.target_date,t.hard_deadline,t.estimated_minutes
          FROM tasks t WHERE ${conditions.join(' AND ')} ORDER BY t.id LIMIT $${values.length}`, values);
        const tasks = rows.slice(0, limit);
        return { data: { tasks, coverage: { returned: tasks.length, has_more: rows.length > limit, next_after: rows.length > limit ? tasks.at(-1)!.id : null, order: 'id', search: args.search ?? null, goal_id: args.goal_id ?? null, parent_task_id: args.parent_task_id ?? null } } };
      },
    },
    task_details: {
      description: 'Read named tasks and their immediate children by exact IDs. Use this to resolve follow-ups and inspect current values before proposing changes. Missing IDs are reported; never substitute another task.',
      parameters: z.object({ task_ids: z.array(z.string().min(1).max(100)).min(1).max(20) }).strict(),
      execute: async args => {
        const ids = args.task_ids as string[];
        const { rows } = await query<{ id: string }>(
          `SELECT t.id, t.title, t.description, t.goal_id, t.parent_task_id, t.milestone_id,
                  t.status, t.priority, t.completed, t.start_date, t.due_date, t.target_date,
                  t.hard_deadline, t.estimated_minutes, t.actual_minutes, t.scheduling_enabled, t.kind,
                  COALESCE((SELECT json_agg(e.source_id) FROM edges e WHERE e.relationship='blocks'
                    AND e.source_type='task' AND e.target_type='task' AND e.target_id=t.id AND ${activeTaskSql('e.source_id')}), '[]'::json) AS blocker_ids,
                  COALESCE((SELECT SUM(ws.minutes) FROM work_sessions ws WHERE ws.task_id=t.id),0) AS logged_minutes
           FROM tasks t WHERE (t.id = ANY($1) OR t.parent_task_id = ANY($1)) AND ${activeTaskSql('t.id')}
           ORDER BY (t.id = ANY($1)) DESC, t.position, t.title LIMIT 101`, [ids],
        );
        const tasks = rows.slice(0, 100);
        return { data: { tasks, missing_ids: ids.filter(id => !tasks.some(row => row.id === id)), limit: 100,
          children_has_more: rows.length > 100, more_children_tool: 'find_tasks with parent_task_id' } };
      },
    },
    schedule_range: {
      description: 'Read actual scheduled events, meetings and directly dated tasks for an explicit date range, including dates outside the overview. For moving existing work, inspect source and target dates first. start_date is a day assignment; due_date/target_date/hard_deadline are deadlines, not time blocks. No changes are made.',
      parameters: rangeSchema,
      execute: async args => {
        const from = args.from as string; const to = args.to as string;
        const [{ rows: tasks }, { rows: events }, { rows: meetings }] = await Promise.all([
          query(`SELECT t.id,t.title,t.goal_id,t.parent_task_id,t.status,t.completed,t.start_date,t.due_date,t.target_date,t.hard_deadline,t.estimated_minutes
            FROM tasks t WHERE ${activeTaskSql('t.id')} AND (t.start_date BETWEEN $1 AND $2 OR t.due_date BETWEEN $1 AND $2 OR t.target_date BETWEEN $1 AND $2 OR t.hard_deadline BETWEEN $1 AND $2)
            ORDER BY t.start_date,t.title LIMIT 200`, [from, to]),
          query(`SELECT e.id,e.title,e.type,e.week_start,e.day_index,e.start_hour,e.duration_hours,e.locked,
            COALESCE((SELECT json_agg(etl.task_id) FROM event_task_links etl WHERE etl.event_id=e.id), '[]'::json) AS task_ids
            FROM events e WHERE ${activeEventSql('e.id')} AND (e.week_start::date + e.day_index) BETWEEN $1::date AND $2::date ORDER BY e.week_start,e.day_index,e.start_hour LIMIT 200`, [from, to]),
          query(`SELECT m.id,m.title,m.scheduled_at,m.duration_minutes FROM meetings m WHERE ${activeMeetingSql('m.id')} AND DATE(m.scheduled_at::timestamp) BETWEEN $1 AND $2 ORDER BY m.scheduled_at LIMIT 100`, [from, to]),
        ]);
        return { data: { from, to, tasks, events: events.map(event => ({ ...event, date: eventDateServer(String(event.week_start), Number(event.day_index)) })), meetings, limits: { tasks: 200, events: 200, meetings: 100 } } };
      },
    },
    research_search: {
      description: 'Search passages from the user’s saved research library. This is not an internet search. Use the returned paper/chunk/page provenance for citations; an empty result is not evidence that a claim is true.',
      parameters: z.object({ query: z.string().min(2).max(500) }).strict(),
      execute: async args => ({ data: { evidence: await searchResearchEvidence(String(args.query), 6) } }),
    },
    show_schedule_day: {
      description: 'Read and optionally display one existing day with capacity and deadlines. Returns an error when that date is outside the available overview; use schedule_range for other dates. Add this call ID to display only when a visual day card answers the user’s request.',
      parameters: z.object({ date: day }).strict(),
      execute: async args => {
        const data = await dependencies.scheduleDay(String(args.date));
        if (!data) throw new Error('That date is outside the available day overview. Use schedule_range for the requested date; do not show a different day.');
        return { data, artifact: { kind: 'schedule_day_view', data } };
      },
    },
    overdue_tasks: {
      description: 'Read open overdue tasks. Optionally display their card by including this call ID in display. This tool does not reschedule anything.',
      parameters: z.object({}).strict(),
      execute: async () => { const data = await dependencies.overdueTasks(); return { data, artifact: { kind: 'overdue_tasks_view', data } }; },
    },
    preview_schedule: {
      description: 'Calculate a proposed calendar layout only when the user requests a new plan. Supply their explicit window and exact task_id/task_ids for a narrow scope; omitting IDs plans eligible workspace work. max_daily_minutes limits each selected task per day. Tasks need estimates and deadlines; excluded_tasks explains any omission. This computes a preview, never writes dates or events. Read its constraints, then explain the result and include this call ID in display.',
      parameters: ActionParamsSchemas.plan_schedule.refine((args: Record<string, unknown>) => Boolean(
        args.relative_hours || args.horizon_days || (args.from_date && args.to_date),
      ), { message: 'Supply an explicit date window, horizon_days, or relative_hours. Do not guess a default window.' }).refine((args: Record<string, unknown>) => (
        (!args.from_date || !args.to_date || (String(args.to_date) >= String(args.from_date)
          && Date.parse(String(args.to_date)) - Date.parse(String(args.from_date)) <= 89 * 86_400_000))
        && ((args.start_hour === undefined && args.end_hour === undefined)
          || (typeof args.start_hour === 'number' && typeof args.end_hour === 'number' && args.end_hour > args.start_hour))
      ), { message: 'Use an ordered date range of at most 90 days. Any hour window needs both start_hour and a later end_hour.' }),
      execute: async args => { const data = await dependencies.previewSchedule(args); return { data, artifact: { kind: 'plan', data, autoDisplay: true } }; },
    },
    preview_routine: {
      description: 'Compute a preview of explicitly requested repeating time blocks. Supply start/end dates, hours, and weekdays (1=Monday through 7=Sunday). Ask if recurrence or timing is unclear. This tool does not create a saved routine or events; the user applies its card.',
      parameters: ActionParamsSchemas.create_block_series.refine((args: Record<string, unknown>) => (
        String(args.end_date) >= String(args.start_date) && Number(args.end_hour) > Number(args.start_hour)
        && Date.parse(String(args.end_date)) - Date.parse(String(args.start_date)) <= 119 * 86_400_000
      ), { message: 'Use an ordered date range of at most 120 days and an end_hour after start_hour.' }),
      execute: async args => { const data = await dependencies.previewRoutine(args); return { data, artifact: { kind: 'plan', data, autoDisplay: true } }; },
    },
  };
}
