import { query } from '../db.js';
import { LEGACY_BRAND, LEGACY_LABEL } from '../utils/brandCompatibility.js';
import { refreshGoogleAccessToken } from './googleWorkspaceAuth.js';
import { calculateGoalTaskMetrics } from '../../src/utils/goalTaskMetrics.js';

const CONNECTION_ID = 'primary';
const GOOGLE_TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';
const GOOGLE_CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

type EntityType = 'goal' | 'task' | 'event' | 'meeting' | 'task_day' | 'system';
type RemoteType = 'task_list' | 'task' | 'calendar_event';

interface ConnectionRow extends Record<string, unknown> {
  id: string;
  account_email: string | null;
  encrypted_refresh_token: string;
  calendar_id: string | null;
  calendar_name: string;
  initial_sync_complete: boolean;
  auto_sync_enabled: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  sync_lease_until: string | null;
}

interface LinkRow extends Record<string, unknown> {
  id: string;
  connection_id: string;
  entity_type: EntityType;
  entity_id: string;
  remote_type: RemoteType;
  remote_container_id: string | null;
  remote_id: string;
  remote_etag: string | null;
  remote_updated_at: string | null;
  local_updated_at: string | null;
  sync_status: 'synced' | 'conflict' | 'remote_deleted' | 'error';
  conflict_json: string | null;
}

interface GoalRow extends Record<string, unknown> {
  id: string;
  title: string;
  updated_at: string;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  goal_id: string | null;
  parent_task_id: string | null;
  title: string;
  description: string;
  due_date: string | null;
  start_date: string | null;
  estimated_minutes: number | null;
  completed: boolean;
  position: number;
  updated_at: string;
}

interface EventRow extends Record<string, unknown> {
  id: string;
  title: string;
  type: string;
  day_index: number;
  start_hour: number;
  duration_hours: number;
  description: string;
  week_start: string | null;
  updated_at: string;
}

interface MeetingRow extends Record<string, unknown> {
  id: string;
  goal_id: string | null;
  title: string;
  scheduled_at: string;
  duration_minutes: number;
  location: string;
  notes: string;
  updated_at: string;
}

interface GoogleTaskList {
  id: string;
  title: string;
  etag?: string;
  updated?: string;
}

interface GoogleTask {
  id: string;
  title?: string;
  notes?: string;
  status?: 'needsAction' | 'completed';
  due?: string;
  completed?: string;
  deleted?: boolean;
  hidden?: boolean;
  parent?: string;
  etag?: string;
  updated?: string;
}

interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  etag?: string;
  updated?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export interface GoogleSyncStats {
  task_lists_created: number;
  tasks_created: number;
  tasks_hidden_in_google: number;
  tasks_updated_in_google: number;
  tasks_updated_in_marina: number;
  tasks_imported: number;
  calendar_events_created: number;
  calendar_events_updated_in_google: number;
  calendar_items_updated_in_marina: number;
  calendar_items_imported: number;
  conflicts: number;
  skipped: number;
}

export interface GoogleSyncPreview {
  goals_as_task_lists: number;
  one_off_task_list: boolean;
  tasks: number;
  timed_schedule_blocks: number;
  meetings: number;
  all_day_tasks: number;
  repeating_blocks_skipped: number;
}

function emptyStats(): GoogleSyncStats {
  return {
    task_lists_created: 0,
    tasks_created: 0,
    tasks_hidden_in_google: 0,
    tasks_updated_in_google: 0,
    tasks_updated_in_marina: 0,
    tasks_imported: 0,
    calendar_events_created: 0,
    calendar_events_updated_in_google: 0,
    calendar_items_updated_in_marina: 0,
    calendar_items_imported: 0,
    conflicts: 0,
    skipped: 0,
  };
}

function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

function changedSince(current: string | null | undefined, previous: string | null | undefined): boolean {
  if (!previous) return true;
  if (!current) return false;
  return new Date(current).getTime() > new Date(previous).getTime() + 500;
}

function addDays(date: string, amount: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function dateToWeekPosition(date: string): { week_start: string; day_index: number } {
  const d = new Date(`${date}T00:00:00Z`);
  return { week_start: mondayOf(date), day_index: (d.getUTCDay() + 6) % 7 };
}

function concreteEventDate(event: Pick<EventRow, 'week_start' | 'day_index'>): string | null {
  return event.week_start ? addDays(mondayOf(event.week_start), ((event.day_index % 7) + 7) % 7) : null;
}

function localDateTime(date: string, hour: number): string {
  const totalMinutes = Math.round(hour * 60);
  const dayOffset = Math.floor(totalMinutes / 1440);
  const minuteOfDay = ((totalMinutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const mm = String(minuteOfDay % 60).padStart(2, '0');
  return `${addDays(date, dayOffset)}T${hh}:${mm}:00`;
}

function timeRange(startHour: number, durationHours: number): string {
  const fmt = (hour: number) => {
    const mins = Math.round(hour * 60);
    const normalized = ((mins % 1440) + 1440) % 1440;
    const h = Math.floor(normalized / 60);
    const m = normalized % 60;
    const display = h % 12 || 12;
    return `${display}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
  };
  return `${fmt(startHour)} – ${fmt(startHour + durationHours)}`;
}

function zonedParts(dateTime: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(dateTime));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value ?? 0);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  return {
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    hour: hour + minute / 60,
  };
}

function taskListTitle(goal: Pick<GoalRow, 'title'>): string {
  return `Marina · ${goal.title}`.slice(0, 1024);
}

function taskMarker(taskId: string): string {
  return `Marina task: ${taskId}`;
}

function markerTaskId(notes: string | undefined): string | null {
  return notes?.match(new RegExp(`(?:^|\\n)(?:Marina|${LEGACY_LABEL}) task: ([0-9a-f-]{36})(?:\\n|$)`, 'i'))?.[1] ?? null;
}

function sortedTasks(tasks: TaskRow[]): TaskRow[] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const depth = (task: TaskRow) => {
    let value = 0;
    let parent = task.parent_task_id ? byId.get(task.parent_task_id) : undefined;
    const seen = new Set([task.id]);
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      value += 1;
      parent = parent.parent_task_id ? byId.get(parent.parent_task_id) : undefined;
    }
    return value;
  };
  return [...tasks].sort((a, b) => depth(a) - depth(b) || a.position - b.position || a.title.localeCompare(b.title));
}

export interface GoogleTaskProjection {
  visible: boolean;
  root_task_id: string;
  google_parent_task_id: string | null;
  path_titles: string[];
}

/**
 * Google Tasks supports one subtask level. Marina keeps its full hierarchy,
 * while Google shows each root plus the currently actionable leaves beneath
 * it. An intermediate task becomes visible once it has no unfinished
 * descendants left.
 */
export function buildGoogleTaskProjections(tasks: TaskRow[]): Map<string, GoogleTaskProjection> {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    if (!task.parent_task_id || !byId.has(task.parent_task_id)) continue;
    const siblings = children.get(task.parent_task_id) ?? [];
    siblings.push(task);
    children.set(task.parent_task_id, siblings);
  }

  const activeDescendantMemo = new Map<string, boolean>();
  const hasActiveDescendant = (taskId: string, visiting = new Set<string>()): boolean => {
    const memoized = activeDescendantMemo.get(taskId);
    if (memoized !== undefined) return memoized;
    if (visiting.has(taskId)) return false;
    visiting.add(taskId);
    const result = (children.get(taskId) ?? []).some(child =>
      !child.completed || hasActiveDescendant(child.id, visiting));
    visiting.delete(taskId);
    activeDescendantMemo.set(taskId, result);
    return result;
  };

  const pathFor = (task: TaskRow): TaskRow[] => {
    const reversed = [task];
    const seen = new Set([task.id]);
    let cursor = task;
    while (cursor.parent_task_id) {
      const parent = byId.get(cursor.parent_task_id);
      if (!parent) break;
      if (seen.has(parent.id)) return [task];
      reversed.push(parent);
      seen.add(parent.id);
      cursor = parent;
    }
    return reversed.reverse();
  };

  return new Map(tasks.map(task => {
    const path = pathFor(task);
    const root = path[0] ?? task;
    const isRoot = root.id === task.id;
    return [task.id, {
      visible: isRoot || !hasActiveDescendant(task.id),
      root_task_id: root.id,
      google_parent_task_id: isRoot ? null : root.id,
      path_titles: path.map(item => item.title),
    } satisfies GoogleTaskProjection];
  }));
}

async function taskDeadlineHierarchyConflict(task: TaskRow, dueDate: string | null): Promise<string | null> {
  if (!dueDate) return null;
  if (task.parent_task_id) {
    const { rows } = await query<{ title: string; due_date: string }>(
      `WITH RECURSIVE ancestors AS (
         SELECT id,title,parent_task_id,due_date,0 AS depth,ARRAY[id] AS path FROM tasks WHERE id=$1
         UNION ALL
         SELECT t.id,t.title,t.parent_task_id,t.due_date,a.depth+1,a.path||t.id
         FROM tasks t JOIN ancestors a ON t.id=a.parent_task_id WHERE NOT t.id=ANY(a.path)
       )
       SELECT title,due_date FROM ancestors WHERE due_date IS NOT NULL ORDER BY depth LIMIT 1`,
      [task.parent_task_id],
    );
    const parent = rows[0];
    if (parent && dueDate > parent.due_date.slice(0, 10)) {
      return `Google due date ${dueDate} is after parent “${parent.title}” (${parent.due_date.slice(0, 10)}).`;
    }
  }
  const { rows: childRows } = await query<{ title: string; due_date: string }>(
    `WITH RECURSIVE descendants AS (
       SELECT id,title,parent_task_id,due_date,ARRAY[id] AS path FROM tasks WHERE parent_task_id=$1
       UNION ALL
       SELECT t.id,t.title,t.parent_task_id,t.due_date,d.path||t.id
       FROM tasks t JOIN descendants d ON t.parent_task_id=d.id WHERE NOT t.id=ANY(d.path)
     )
     SELECT title,due_date FROM descendants
     WHERE due_date IS NOT NULL AND LEFT(due_date,10)>$2 ORDER BY LEFT(due_date,10) DESC LIMIT 1`,
    [task.id, dueDate],
  );
  const child = childRows[0];
  return child ? `Google due date ${dueDate} is before child “${child.title}” (${child.due_date.slice(0, 10)}).` : null;
}

export function buildGoogleTaskPayload(
  task: TaskRow,
  goalTitle: string | null,
  parentTitle: string | null,
  pathTitles: string[] = [],
) {
  const notes = [
    task.description?.trim() || null,
    goalTitle ? `Goal: ${goalTitle}` : 'One-off task',
    parentTitle ? `Parent: ${parentTitle}` : null,
    pathTitles.length > 1 ? `Marina path: ${pathTitles.join(' > ')}` : null,
    task.estimated_minutes ? `Estimate: ${Math.round(task.estimated_minutes / 6) / 10} hours` : null,
    taskMarker(task.id),
  ].filter(Boolean).join('\n');
  return {
    title: googleTaskDisplayTitle(task.title, pathTitles),
    notes,
    status: task.completed ? 'completed' : 'needsAction',
    completed: task.completed ? new Date().toISOString() : null,
    due: isoDate(task.due_date) ? `${isoDate(task.due_date)}T00:00:00.000Z` : null,
  };
}

export function googleTaskDisplayTitle(taskTitle: string, pathTitles: string[]): string {
  const immediateParent = pathTitles.length >= 3 ? pathTitles[pathTitles.length - 2]?.trim() : '';
  return (immediateParent ? `${immediateParent}: ${taskTitle}` : taskTitle).slice(0, 1024);
}

export function marinaTaskTitleFromGoogle(
  remoteTitle: string | undefined,
  currentTaskTitle: string,
  pathTitles: string[],
): string {
  const nextTitle = remoteTitle?.trim() || currentTaskTitle;
  const immediateParent = pathTitles.length >= 3 ? pathTitles[pathTitles.length - 2]?.trim() : '';
  if (!immediateParent) return nextTitle;

  const flattenedPrefix = `${immediateParent}:`;
  if (!nextTitle.startsWith(flattenedPrefix)) return nextTitle;
  return nextTitle.slice(flattenedPrefix.length).trimStart() || currentTaskTitle;
}

export function buildGoogleCalendarPayload(
  item: { kind: 'event'; row: EventRow } | { kind: 'meeting'; row: MeetingRow } | { kind: 'task_day'; row: TaskRow },
  timeZone: string,
) {
  if (item.kind === 'task_day') {
    const date = isoDate(item.row.start_date)!;
    return {
      summary: item.row.title,
      description: `All-day task from Marina.\n${taskMarker(item.row.id)}`,
      start: { date },
      end: { date: addDays(date, 1) },
      transparency: 'transparent',
      extendedProperties: { private: { marinaManaged: '1', marinaKind: 'task_day', marinaId: item.row.id } },
    };
  }
  if (item.kind === 'meeting') {
    const date = item.row.scheduled_at.slice(0, 10);
    const time = item.row.scheduled_at.slice(11, 16) || '09:00';
    const startHour = Number(time.slice(0, 2)) + Number(time.slice(3, 5)) / 60;
    return {
      summary: item.row.title,
      description: item.row.notes || 'Meeting synced from Marina.',
      location: item.row.location || undefined,
      start: { dateTime: localDateTime(date, startHour), timeZone },
      end: { dateTime: localDateTime(date, startHour + item.row.duration_minutes / 60), timeZone },
      extendedProperties: { private: { marinaManaged: '1', marinaKind: 'meeting', marinaId: item.row.id } },
    };
  }
  const date = concreteEventDate(item.row)!;
  return {
    summary: item.row.title,
    description: item.row.description || 'Schedule block synced from Marina.',
    start: { dateTime: localDateTime(date, item.row.start_hour), timeZone },
    end: { dateTime: localDateTime(date, item.row.start_hour + item.row.duration_hours), timeZone },
    extendedProperties: { private: { marinaManaged: '1', marinaKind: 'event', marinaId: item.row.id } },
  };
}

async function googleApi<T>(accessToken: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } | string };
    const detail = typeof body.error === 'string' ? body.error : body.error?.message;
    throw Object.assign(new Error(detail ?? `Google API request failed (${response.status})`), { status: response.status });
  }
  if (response.status === 204) return {} as T;
  return response.json() as Promise<T>;
}

async function listAll<T>(accessToken: string, baseUrl: string): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(baseUrl);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await googleApi<{ items?: T[]; nextPageToken?: string }>(accessToken, url.toString());
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

async function getConnection(): Promise<ConnectionRow | null> {
  const { rows } = await query<ConnectionRow>('SELECT * FROM google_sync_connections WHERE id=$1', [CONNECTION_ID]);
  return rows[0] ?? null;
}

async function getLinks(): Promise<LinkRow[]> {
  const { rows } = await query<LinkRow>('SELECT * FROM google_sync_links WHERE connection_id=$1', [CONNECTION_ID]);
  return rows;
}

function linkKey(remoteType: RemoteType, entityType: EntityType, entityId: string): string {
  return `${remoteType}:${entityType}:${entityId}`;
}

async function saveLink(input: {
  existing?: LinkRow;
  entityType: EntityType;
  entityId: string;
  remoteType: RemoteType;
  remoteContainerId?: string | null;
  remoteId: string;
  remoteEtag?: string | null;
  remoteUpdatedAt?: string | null;
  localUpdatedAt?: string | null;
  status?: LinkRow['sync_status'];
  conflict?: unknown;
}): Promise<LinkRow> {
  const now = new Date().toISOString();
  const id = input.existing?.id ?? crypto.randomUUID();
  const { rows } = await query<LinkRow>(
    `INSERT INTO google_sync_links
       (id,connection_id,entity_type,entity_id,remote_type,remote_container_id,remote_id,remote_etag,
        remote_updated_at,local_updated_at,sync_status,conflict_json,last_synced_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$13)
     ON CONFLICT (connection_id,remote_type,entity_type,entity_id) DO UPDATE SET
       remote_container_id=EXCLUDED.remote_container_id, remote_id=EXCLUDED.remote_id,
       remote_etag=EXCLUDED.remote_etag, remote_updated_at=EXCLUDED.remote_updated_at,
       local_updated_at=EXCLUDED.local_updated_at, sync_status=EXCLUDED.sync_status,
       conflict_json=EXCLUDED.conflict_json, last_synced_at=EXCLUDED.last_synced_at, updated_at=EXCLUDED.updated_at
     RETURNING *`,
    [id, CONNECTION_ID, input.entityType, input.entityId, input.remoteType, input.remoteContainerId ?? null,
      input.remoteId, input.remoteEtag ?? null, input.remoteUpdatedAt ?? null, input.localUpdatedAt ?? null,
      input.status ?? 'synced', input.conflict ? JSON.stringify(input.conflict) : null, now],
  );
  return rows[0];
}

export async function googleSyncSchemaReady(): Promise<boolean> {
  try {
    const { rows } = await query<{ ready: boolean }>(
      `SELECT to_regclass('public.google_sync_connections') IS NOT NULL
          AND to_regclass('public.google_sync_links') IS NOT NULL AS ready`,
    );
    return Boolean(rows[0]?.ready);
  } catch {
    return false;
  }
}

export async function getGoogleSyncPreview(): Promise<GoogleSyncPreview> {
  const [{ rows: goals }, { rows: tasks }, { rows: events }, { rows: meetings }] = await Promise.all([
    query<{ count: number }>('SELECT COUNT(*)::int AS count FROM goals WHERE archived_at IS NULL'),
    query<{ count: number; one_offs: number; all_day: number }>(
      `SELECT COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE goal_id IS NULL)::int AS one_offs,
              COUNT(*) FILTER (WHERE start_date IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM event_task_links etl WHERE etl.task_id=tasks.id
              ))::int AS all_day
       FROM tasks
       WHERE goal_id IS NULL OR EXISTS (SELECT 1 FROM goals g WHERE g.id=tasks.goal_id AND g.archived_at IS NULL)`,
    ),
    query<{ concrete: number; repeating: number }>(
      `SELECT COUNT(*) FILTER (WHERE week_start IS NOT NULL)::int AS concrete,
              COUNT(*) FILTER (WHERE week_start IS NULL)::int AS repeating FROM events`,
    ),
    query<{ count: number }>('SELECT COUNT(*)::int AS count FROM meetings'),
  ]);
  return {
    goals_as_task_lists: Number(goals[0]?.count ?? 0),
    one_off_task_list: Number(tasks[0]?.one_offs ?? 0) > 0,
    tasks: Number(tasks[0]?.count ?? 0),
    timed_schedule_blocks: Number(events[0]?.concrete ?? 0),
    meetings: Number(meetings[0]?.count ?? 0),
    all_day_tasks: Number(tasks[0]?.all_day ?? 0),
    repeating_blocks_skipped: Number(events[0]?.repeating ?? 0),
  };
}

async function ensureTaskList(
  accessToken: string,
  entityType: 'goal' | 'system',
  entityId: string,
  title: string,
  localUpdatedAt: string | null,
  links: Map<string, LinkRow>,
  remoteLists: GoogleTaskList[],
  stats: GoogleSyncStats,
): Promise<GoogleTaskList> {
  const key = linkKey('task_list', entityType, entityId);
  const existing = links.get(key);
  let remote = existing ? remoteLists.find(list => list.id === existing.remote_id) : undefined;
  if (!remote) remote = remoteLists.find(list => list.title === title);
  if (!remote) remote = remoteLists.find(list => list.title === title.replace(/^Marina · /, `${LEGACY_LABEL} · `));
  if (!remote) {
    remote = await googleApi<GoogleTaskList>(accessToken, `${GOOGLE_TASKS_BASE}/users/@me/lists`, {
      method: 'POST', body: JSON.stringify({ title }),
    });
    remoteLists.push(remote);
    stats.task_lists_created += 1;
  } else if (remote.title !== title) {
    remote = await googleApi<GoogleTaskList>(accessToken, `${GOOGLE_TASKS_BASE}/users/@me/lists/${encodeURIComponent(remote.id)}`, {
      method: 'PATCH', body: JSON.stringify({ title }),
    });
  }
  const saved = await saveLink({ existing, entityType, entityId, remoteType: 'task_list', remoteId: remote.id,
    remoteEtag: remote.etag, remoteUpdatedAt: remote.updated, localUpdatedAt });
  links.set(key, saved);
  return remote;
}

async function syncTasks(accessToken: string, links: Map<string, LinkRow>, stats: GoogleSyncStats) {
  const [{ rows: goals }, { rows: tasks }] = await Promise.all([
    query<GoalRow>('SELECT id,title,updated_at FROM goals WHERE archived_at IS NULL ORDER BY created_at ASC'),
    query<TaskRow>(
      `SELECT t.id,t.goal_id,t.parent_task_id,t.title,t.description,t.due_date,t.start_date,
              t.estimated_minutes,t.completed,t.position,t.updated_at
       FROM tasks t LEFT JOIN goals g ON g.id=t.goal_id
       WHERE t.goal_id IS NULL OR g.archived_at IS NULL
       ORDER BY t.position ASC,t.created_at ASC`,
    ),
  ]);
  const goalsById = new Map(goals.map(goal => [goal.id, goal]));
  const tasksById = new Map(tasks.map(task => [task.id, task]));
  const remoteLists = await listAll<GoogleTaskList>(accessToken, `${GOOGLE_TASKS_BASE}/users/@me/lists?maxResults=100`);
  const listByGoal = new Map<string | null, GoogleTaskList>();
  for (const goal of goals) {
    listByGoal.set(goal.id, await ensureTaskList(accessToken, 'goal', goal.id, taskListTitle(goal), goal.updated_at, links, remoteLists, stats));
  }
  if (tasks.some(task => !task.goal_id)) {
    listByGoal.set(null, await ensureTaskList(accessToken, 'system', 'one-offs', 'Marina · One-offs', null, links, remoteLists, stats));
  }

  for (const [goalId, list] of listByGoal) {
    const localTasks = sortedTasks(tasks.filter(task => task.goal_id === goalId));
    let projections = buildGoogleTaskProjections(localTasks);
    const remoteTasks = await listAll<GoogleTask>(accessToken,
      `${GOOGLE_TASKS_BASE}/lists/${encodeURIComponent(list.id)}/tasks?maxResults=100&showCompleted=true&showHidden=true&showDeleted=true`);
    const remoteById = new Map(remoteTasks.map(task => [task.id, task]));
    const linkedRemoteIds = new Set<string>();

    // Restore a lost link from Marina's marker before treating a Google task as new.
    for (const remote of remoteTasks) {
      if (remote.deleted) continue;
      const markedId = markerTaskId(remote.notes);
      const local = markedId ? tasksById.get(markedId) : undefined;
      const key = markedId ? linkKey('task', 'task', markedId) : '';
      if (local && !links.has(key)) {
        const saved = await saveLink({ entityType: 'task', entityId: local.id, remoteType: 'task', remoteContainerId: list.id,
          remoteId: remote.id, remoteEtag: remote.etag, remoteUpdatedAt: remote.updated, localUpdatedAt: local.updated_at });
        links.set(key, saved);
      }
    }

    for (const task of localTasks) {
      const key = linkKey('task', 'task', task.id);
      const projection = projections.get(task.id) ?? {
        visible: true,
        root_task_id: task.id,
        google_parent_task_id: null,
        path_titles: [task.title],
      };
      let link = links.get(key);
      let remote = link ? remoteById.get(link.remote_id) : undefined;
      const parentRemoteId = projection.google_parent_task_id
        ? links.get(linkKey('task', 'task', projection.google_parent_task_id))?.remote_id
        : undefined;
      const payload = buildGoogleTaskPayload(task, goalId ? goalsById.get(goalId)?.title ?? null : null,
        task.parent_task_id ? tasksById.get(task.parent_task_id)?.title ?? null : null,
        projection.path_titles);
      let pulledRemoteChange = false;
      if (remote?.deleted && link) {
        if (!projection.visible) {
          await query('DELETE FROM google_sync_links WHERE id=$1', [link.id]);
          links.delete(key);
          linkedRemoteIds.add(remote.id);
          continue;
        }
        link = await saveLink({ existing: link, entityType: 'task', entityId: task.id, remoteType: 'task',
          remoteContainerId: list.id, remoteId: remote.id, remoteEtag: remote.etag,
          remoteUpdatedAt: remote.updated, localUpdatedAt: task.updated_at, status: 'remote_deleted',
          conflict: { message: 'Deleted in Google. The Marina task was kept and needs a decision.' } });
        links.set(key, link);
        linkedRemoteIds.add(remote.id);
        stats.conflicts += 1;
        continue;
      }
      if (!remote) {
        if (!projection.visible) {
          if (link) await query('DELETE FROM google_sync_links WHERE id=$1', [link.id]);
          links.delete(key);
          continue;
        }
        const url = new URL(`${GOOGLE_TASKS_BASE}/lists/${encodeURIComponent(list.id)}/tasks`);
        if (parentRemoteId) url.searchParams.set('parent', parentRemoteId);
        remote = await googleApi<GoogleTask>(accessToken, url.toString(), { method: 'POST', body: JSON.stringify(payload) });
        link = await saveLink({ existing: link, entityType: 'task', entityId: task.id, remoteType: 'task',
          remoteContainerId: list.id, remoteId: remote.id, remoteEtag: remote.etag,
          remoteUpdatedAt: remote.updated, localUpdatedAt: task.updated_at });
        links.set(key, link);
        stats.tasks_created += 1;
      } else {
        const localChanged = changedSince(task.updated_at, link?.local_updated_at);
        const remoteChanged = changedSince(remote.updated, link?.remote_updated_at);
        if (localChanged && remoteChanged) {
          link = await saveLink({ existing: link, entityType: 'task', entityId: task.id, remoteType: 'task', remoteContainerId: list.id,
            remoteId: remote.id, remoteEtag: remote.etag, remoteUpdatedAt: remote.updated, localUpdatedAt: task.updated_at,
            status: 'conflict', conflict: { fields: ['title', 'due_date', 'completed'], message: 'Changed in Marina and Google since the last sync.' } });
          links.set(key, link);
          stats.conflicts += 1;
        } else if (remoteChanged) {
          const completed = remote.status === 'completed';
          const remoteDate = isoDate(remote.due);
          const hierarchyConflict = await taskDeadlineHierarchyConflict(task, remoteDate);
          if (hierarchyConflict) {
            link = await saveLink({ existing: link, entityType: 'task', entityId: task.id, remoteType: 'task', remoteContainerId: list.id,
              remoteId: remote.id, remoteEtag: remote.etag, remoteUpdatedAt: remote.updated, localUpdatedAt: task.updated_at,
              status: 'conflict', conflict: { fields: ['due_date'], message: hierarchyConflict } });
            links.set(key, link);
            stats.conflicts += 1;
            linkedRemoteIds.add(remote.id);
            continue;
          }
          const nextStatus = completed ? 'done' : 'todo';
          const updatedAt = remote.updated ?? new Date().toISOString();
          const nextTitle = marinaTaskTitleFromGoogle(remote.title, task.title, projection.path_titles);
          await query(
            `UPDATE tasks SET title=$1,due_date=$2,target_date=$2,completed=$3,status=$4,updated_at=$5 WHERE id=$6`,
            [nextTitle, remoteDate, completed, nextStatus, updatedAt, task.id],
          );
          task.title = nextTitle;
          task.due_date = remoteDate;
          task.completed = completed;
          task.updated_at = updatedAt;
          pulledRemoteChange = true;
          link = await saveLink({ existing: link, entityType: 'task', entityId: task.id, remoteType: 'task', remoteContainerId: list.id,
            remoteId: remote.id, remoteEtag: remote.etag, remoteUpdatedAt: remote.updated, localUpdatedAt: updatedAt });
          links.set(key, link);
          stats.tasks_updated_in_marina += 1;
        } else if (localChanged) {
          remote = await googleApi<GoogleTask>(accessToken,
            `${GOOGLE_TASKS_BASE}/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(remote.id)}`,
            { method: 'PATCH', body: JSON.stringify(payload) });
          link = await saveLink({ existing: link, entityType: 'task', entityId: task.id, remoteType: 'task', remoteContainerId: list.id,
            remoteId: remote.id, remoteEtag: remote.etag, remoteUpdatedAt: remote.updated, localUpdatedAt: task.updated_at });
          links.set(key, link);
          stats.tasks_updated_in_google += 1;
        }
      }
      if (remote && !remote.deleted && (remote.parent ?? null) !== (parentRemoteId ?? null)) {
        const moveUrl = new URL(`${GOOGLE_TASKS_BASE}/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(remote.id)}/move`);
        if (parentRemoteId) moveUrl.searchParams.set('parent', parentRemoteId);
        await googleApi(accessToken, moveUrl.toString(), { method: 'POST' });
        remote.parent = parentRemoteId;
        stats.tasks_updated_in_google += 1;
      }
      const currentPathTitles = projection.path_titles.length > 0
        ? [...projection.path_titles.slice(0, -1), task.title]
        : [task.title];
      const currentPayload = buildGoogleTaskPayload(task, goalId ? goalsById.get(goalId)?.title ?? null : null,
        task.parent_task_id ? tasksById.get(task.parent_task_id)?.title ?? null : null,
        currentPathTitles);
      const titleNeedsProjection = !pulledRemoteChange && remote?.title !== currentPayload.title;
      const notesNeedProjection = remote?.notes !== currentPayload.notes;
      if (projection.visible && remote && !remote.deleted && link?.sync_status !== 'conflict'
          && (titleNeedsProjection || notesNeedProjection)) {
        const metadataPatch = {
          ...(titleNeedsProjection ? { title: currentPayload.title } : {}),
          ...(notesNeedProjection ? { notes: currentPayload.notes } : {}),
        };
        remote = await googleApi<GoogleTask>(accessToken,
          `${GOOGLE_TASKS_BASE}/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(remote.id)}`,
          { method: 'PATCH', body: JSON.stringify(metadataPatch) });
        link = await saveLink({ existing: link, entityType: 'task', entityId: task.id, remoteType: 'task', remoteContainerId: list.id,
          remoteId: remote.id, remoteEtag: remote.etag, remoteUpdatedAt: remote.updated, localUpdatedAt: task.updated_at });
        links.set(key, link);
        stats.tasks_updated_in_google += 1;
      }
      linkedRemoteIds.add(remote.id);
    }

    // A task typed directly into an Marina-owned Google list becomes an Marina
    // task. Google deletions are intentionally never allowed to delete Marina.
    for (const remote of remoteTasks) {
      if (remote.deleted || linkedRemoteIds.has(remote.id) || markerTaskId(remote.notes)) continue;
      const parentLink = remote.parent
        ? [...links.values()].find(item => item.remote_type === 'task' && item.remote_container_id === list.id && item.remote_id === remote.parent)
        : undefined;
      const id = crypto.randomUUID();
      const now = remote.updated ?? new Date().toISOString();
      const completed = remote.status === 'completed';
      const due = isoDate(remote.due);
      await query(
        `INSERT INTO tasks
          (id,goal_id,parent_task_id,title,description,status,priority,kind,tags_json,due_date,target_date,
           time_rollup_mode,completed,position,completion_note,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'',$5,'medium','manual','[]',$6,$6,'additive',$7,$8,'',$9,$9)`,
        [id, goalId, parentLink?.entity_id ?? null, (remote.title ?? 'Untitled Google task').trim() || 'Untitled Google task',
          completed ? 'done' : 'todo', due, completed, localTasks.length + stats.tasks_imported, now],
      );
      if (goalId) {
        await query(
          `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
           VALUES ($1,$2,'goal',$3,'task','contains',$4,$5) ON CONFLICT DO NOTHING`,
          [crypto.randomUUID(), goalId, id, JSON.stringify({ imported_from: 'google_tasks' }), now],
        );
      }
      if (parentLink?.entity_id) {
        await query(
          `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
           VALUES ($1,$2,'task',$3,'task','subtask_of',$4,$5) ON CONFLICT DO NOTHING`,
          [crypto.randomUUID(), id, parentLink.entity_id, JSON.stringify({ imported_from: 'google_tasks' }), now],
        );
      }
      const saved = await saveLink({ entityType: 'task', entityId: id, remoteType: 'task', remoteContainerId: list.id,
        remoteId: remote.id, remoteEtag: remote.etag, remoteUpdatedAt: remote.updated, localUpdatedAt: now });
      links.set(linkKey('task', 'task', id), saved);
      stats.tasks_imported += 1;
    }

    // Re-evaluate after Google completions were pulled into Marina. Hidden
    // intermediate tasks are removed only from Google's projection; their
    // Marina rows and full parent relationships remain untouched.
    projections = buildGoogleTaskProjections(localTasks);
    for (const task of [...localTasks].reverse()) {
      const projection = projections.get(task.id);
      if (!projection || projection.visible) continue;
      const key = linkKey('task', 'task', task.id);
      const link = links.get(key);
      if (link?.sync_status === 'conflict') continue;
      const remote = link
        ? remoteById.get(link.remote_id)
        : remoteTasks.find(item => !item.deleted && markerTaskId(item.notes) === task.id);
      if (remote && !remote.deleted) {
        await googleApi(accessToken,
          `${GOOGLE_TASKS_BASE}/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(remote.id)}`,
          { method: 'DELETE' });
        stats.tasks_hidden_in_google += 1;
      }
      if (link) {
        await query('DELETE FROM google_sync_links WHERE id=$1', [link.id]);
        links.delete(key);
      }
    }
  }

  // Google-originated completion and task creation bypass the normal task
  // route, so refresh each active goal's derived progress before returning.
  for (const goal of goals) {
    const { rows: goalTasks } = await query('SELECT * FROM tasks WHERE goal_id=$1', [goal.id]);
    const metrics = calculateGoalTaskMetrics(goalTasks as unknown as Parameters<typeof calculateGoalTaskMetrics>[0]);
    await query('UPDATE goals SET progress=$1,activity_level=$2,updated_at=$3 WHERE id=$4',
      [metrics.progress, metrics.activityLevel, new Date().toISOString(), goal.id]);
  }
}

async function ensureCalendar(accessToken: string, connection: ConnectionRow, timeZone: string): Promise<string> {
  if (connection.calendar_name === `${LEGACY_LABEL} Schedule`) {
    connection.calendar_name = 'Marina Schedule';
    await query('UPDATE google_sync_connections SET calendar_name=$1 WHERE id=$2', [connection.calendar_name, CONNECTION_ID]);
  }
  if (connection.calendar_id) {
    try {
      const url = `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(connection.calendar_id)}`;
      const remote = await googleApi<{ summary?: string }>(accessToken, url);
      if (remote.summary === `${LEGACY_LABEL} Schedule`) {
        await googleApi(accessToken, url, { method: 'PATCH', body: JSON.stringify({ summary: connection.calendar_name, description: 'Marina goals, tasks, meetings, and focus blocks.' }) });
      }
      return connection.calendar_id;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }
  const calendar = await googleApi<{ id: string }>(accessToken, `${GOOGLE_CALENDAR_BASE}/calendars`, {
    method: 'POST',
    body: JSON.stringify({ summary: connection.calendar_name, description: 'Marina goals, tasks, meetings, and focus blocks.', timeZone }),
  });
  await query('UPDATE google_sync_connections SET calendar_id=$1,updated_at=$2 WHERE id=$3',
    [calendar.id, new Date().toISOString(), CONNECTION_ID]);
  connection.calendar_id = calendar.id;
  return calendar.id;
}

async function importUnlinkedCalendarEvent(
  remote: GoogleCalendarEvent,
  calendarId: string,
  timeZone: string,
  links: Map<string, LinkRow>,
  stats: GoogleSyncStats,
) {
  if (remote.status === 'cancelled') return;
  const now = remote.updated ?? new Date().toISOString();
  if (remote.start?.date) {
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO tasks
        (id,title,description,status,priority,kind,tags_json,start_date,time_rollup_mode,completed,position,completion_note,created_at,updated_at)
       VALUES ($1,$2,'','todo','medium','manual','[]',$3,'additive',false,0,'',$4,$4)`,
      [id, (remote.summary ?? 'Untitled all-day task').trim() || 'Untitled all-day task', remote.start.date, now],
    );
    const link = await saveLink({ entityType: 'task_day', entityId: id, remoteType: 'calendar_event', remoteContainerId: calendarId,
      remoteId: remote.id, remoteEtag: remote.etag, remoteUpdatedAt: remote.updated, localUpdatedAt: now });
    links.set(linkKey('calendar_event', 'task_day', id), link);
  } else if (remote.start?.dateTime && remote.end?.dateTime) {
    const start = zonedParts(remote.start.dateTime, timeZone);
    const endMs = new Date(remote.end.dateTime).getTime();
    const startMs = new Date(remote.start.dateTime).getTime();
    const durationHours = Math.max(0.25, (endMs - startMs) / 3_600_000);
    const pos = dateToWeekPosition(start.date);
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO events
        (id,title,type,day_index,start_hour,duration_hours,time_str,description,week_start,locked,source,created_at,updated_at)
       VALUES ($1,$2,'google',$3,$4,$5,$6,$7,$8,false,'google',$9,$9)`,
      [id, (remote.summary ?? 'Untitled Google event').trim() || 'Untitled Google event', pos.day_index, start.hour,
        durationHours, timeRange(start.hour, durationHours), remote.description ?? '', pos.week_start, now],
    );
    const link = await saveLink({ entityType: 'event', entityId: id, remoteType: 'calendar_event', remoteContainerId: calendarId,
      remoteId: remote.id, remoteEtag: remote.etag, remoteUpdatedAt: remote.updated, localUpdatedAt: now });
    links.set(linkKey('calendar_event', 'event', id), link);
  } else {
    stats.skipped += 1;
    return;
  }
  stats.calendar_items_imported += 1;
}

async function syncCalendar(accessToken: string, connection: ConnectionRow, links: Map<string, LinkRow>, stats: GoogleSyncStats) {
  const { rows: prefRows } = await query<{ timezone: string }>("SELECT timezone FROM user_schedule_prefs WHERE id='default'");
  const timeZone = prefRows[0]?.timezone ?? 'Asia/Beirut';
  const calendarId = await ensureCalendar(accessToken, connection, timeZone);
  const remoteEvents = await listAll<GoogleCalendarEvent>(accessToken,
    `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?maxResults=2500&singleEvents=true&showDeleted=true`);
  const remoteById = new Map(remoteEvents.map(event => [event.id, event]));
  const linkedRemoteIds = new Set<string>();

  // Restore mappings from Calendar private metadata when possible.
  for (const remote of remoteEvents) {
    const meta = remote.extendedProperties?.private;
    const kind = (meta?.marinaKind ?? meta?.[`${LEGACY_BRAND}Kind`]) as EntityType | undefined;
    const id = meta?.marinaId ?? meta?.[`${LEGACY_BRAND}Id`];
    if (!id || !kind || !['event', 'meeting', 'task_day'].includes(kind)) continue;
    const key = linkKey('calendar_event', kind, id);
    if (!links.has(key)) {
      const saved = await saveLink({ entityType: kind, entityId: id, remoteType: 'calendar_event', remoteContainerId: calendarId,
        remoteId: remote.id, remoteEtag: remote.etag, remoteUpdatedAt: remote.updated, localUpdatedAt: null });
      links.set(key, saved);
    }
  }

  const [{ rows: events }, { rows: meetings }, { rows: taskDays }] = await Promise.all([
    query<EventRow>('SELECT id,title,type,day_index,start_hour,duration_hours,description,week_start,updated_at FROM events WHERE week_start IS NOT NULL'),
    query<MeetingRow>('SELECT id,goal_id,title,scheduled_at,duration_minutes,location,notes,updated_at FROM meetings'),
    query<TaskRow>(
      `SELECT t.id,t.goal_id,t.parent_task_id,t.title,t.description,t.due_date,t.start_date,t.estimated_minutes,
              t.completed,t.position,t.updated_at FROM tasks t
       WHERE t.start_date IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM event_task_links etl WHERE etl.task_id=t.id)`,
    ),
  ]);
  const items: Array<{ kind: 'event'; row: EventRow } | { kind: 'meeting'; row: MeetingRow } | { kind: 'task_day'; row: TaskRow }> = [
    ...events.map(row => ({ kind: 'event' as const, row })),
    ...meetings.map(row => ({ kind: 'meeting' as const, row })),
    ...taskDays.map(row => ({ kind: 'task_day' as const, row })),
  ];

  for (const item of items) {
    const key = linkKey('calendar_event', item.kind, item.row.id);
    let link = links.get(key);
    let remote = link ? remoteById.get(link.remote_id) : undefined;
    const payload = buildGoogleCalendarPayload(item, timeZone);
    if (remote?.status === 'cancelled' && link) {
      link = await saveLink({ existing: link, entityType: item.kind, entityId: item.row.id, remoteType: 'calendar_event',
        remoteContainerId: calendarId, remoteId: remote.id, remoteEtag: remote.etag,
        remoteUpdatedAt: remote.updated, localUpdatedAt: item.row.updated_at, status: 'remote_deleted',
        conflict: { message: 'Deleted in Google Calendar. The Marina item was kept and needs a decision.' } });
      links.set(key, link);
      linkedRemoteIds.add(remote.id);
      stats.conflicts += 1;
      continue;
    }
    if (!remote) {
      remote = await googleApi<GoogleCalendarEvent>(accessToken,
        `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
        { method: 'POST', body: JSON.stringify(payload) });
      link = await saveLink({ existing: link, entityType: item.kind, entityId: item.row.id, remoteType: 'calendar_event',
        remoteContainerId: calendarId, remoteId: remote.id, remoteEtag: remote.etag,
        remoteUpdatedAt: remote.updated, localUpdatedAt: item.row.updated_at });
      links.set(key, link);
      stats.calendar_events_created += 1;
    } else {
      const localChanged = changedSince(item.row.updated_at, link?.local_updated_at);
      const remoteChanged = changedSince(remote.updated, link?.remote_updated_at);
      if (localChanged && remoteChanged) {
        link = await saveLink({ existing: link, entityType: item.kind, entityId: item.row.id, remoteType: 'calendar_event',
          remoteContainerId: calendarId, remoteId: remote.id, remoteEtag: remote.etag,
          remoteUpdatedAt: remote.updated, localUpdatedAt: item.row.updated_at, status: 'conflict',
          conflict: { fields: ['title', 'date', 'time'], message: 'Changed in Marina and Google since the last sync.' } });
        links.set(key, link);
        stats.conflicts += 1;
      } else if (remoteChanged) {
        const updatedAt = remote.updated ?? new Date().toISOString();
        if (item.kind === 'task_day' && remote.start?.date) {
          await query('UPDATE tasks SET start_date=$1,updated_at=$2 WHERE id=$3', [remote.start.date, updatedAt, item.row.id]);
        } else if (item.kind === 'meeting' && remote.start?.dateTime && remote.end?.dateTime) {
          const start = zonedParts(remote.start.dateTime, timeZone);
          const duration = Math.max(1, Math.round((new Date(remote.end.dateTime).getTime() - new Date(remote.start.dateTime).getTime()) / 60_000));
          await query('UPDATE meetings SET title=$1,scheduled_at=$2,duration_minutes=$3,location=$4,notes=$5,updated_at=$6 WHERE id=$7',
            [(remote.summary ?? item.row.title).trim() || item.row.title, localDateTime(start.date, start.hour).slice(0, 16), duration,
              remote.location ?? '', remote.description ?? '', updatedAt, item.row.id]);
        } else if (item.kind === 'event' && remote.start?.dateTime && remote.end?.dateTime) {
          const start = zonedParts(remote.start.dateTime, timeZone);
          const durationHours = Math.max(0.25, (new Date(remote.end.dateTime).getTime() - new Date(remote.start.dateTime).getTime()) / 3_600_000);
          const pos = dateToWeekPosition(start.date);
          await query(
            'UPDATE events SET title=$1,week_start=$2,day_index=$3,start_hour=$4,duration_hours=$5,time_str=$6,description=$7,updated_at=$8 WHERE id=$9',
            [(remote.summary ?? item.row.title).trim() || item.row.title, pos.week_start, pos.day_index, start.hour, durationHours,
              timeRange(start.hour, durationHours), remote.description ?? '', updatedAt, item.row.id],
          );
        } else {
          stats.skipped += 1;
          continue;
        }
        link = await saveLink({ existing: link, entityType: item.kind, entityId: item.row.id, remoteType: 'calendar_event',
          remoteContainerId: calendarId, remoteId: remote.id, remoteEtag: remote.etag,
          remoteUpdatedAt: remote.updated, localUpdatedAt: updatedAt });
        links.set(key, link);
        stats.calendar_items_updated_in_marina += 1;
      } else if (localChanged) {
        remote = await googleApi<GoogleCalendarEvent>(accessToken,
          `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(remote.id)}`,
          { method: 'PATCH', body: JSON.stringify(payload) });
        link = await saveLink({ existing: link, entityType: item.kind, entityId: item.row.id, remoteType: 'calendar_event',
          remoteContainerId: calendarId, remoteId: remote.id, remoteEtag: remote.etag,
          remoteUpdatedAt: remote.updated, localUpdatedAt: item.row.updated_at });
        links.set(key, link);
        stats.calendar_events_updated_in_google += 1;
      }
    }
    linkedRemoteIds.add(remote.id);
  }

  for (const remote of remoteEvents) {
    if (remote.status === 'cancelled' || linkedRemoteIds.has(remote.id)) continue;
    const meta = remote.extendedProperties?.private;
    if (meta?.marinaManaged === '1' || meta?.[`${LEGACY_BRAND}Managed`] === '1') {
      stats.skipped += 1;
      continue;
    }
    await importUnlinkedCalendarEvent(remote, calendarId, timeZone, links, stats);
  }
}

export async function runGoogleWorkspaceSync(options: { confirmInitial?: boolean } = {}): Promise<GoogleSyncStats> {
  const connection = await getConnection();
  if (!connection) throw Object.assign(new Error('Connect a Google account first'), { status: 409 });
  if (!connection.initial_sync_complete && !options.confirmInitial) {
    throw Object.assign(new Error('Review the first-sync preview and confirm before copying anything to Google'), { status: 409 });
  }
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 4 * 60_000).toISOString();
  const { rows: leased } = await query<ConnectionRow>(
    `UPDATE google_sync_connections SET sync_lease_until=$1,updated_at=$2
     WHERE id=$3 AND (sync_lease_until IS NULL OR sync_lease_until < $2)
     RETURNING *`,
    [leaseUntil, now.toISOString(), CONNECTION_ID],
  );
  if (!leased.length) throw Object.assign(new Error('A Google sync is already running'), { status: 409 });

  const stats = emptyStats();
  try {
    const accessToken = await refreshGoogleAccessToken(connection.encrypted_refresh_token);
    const linkRows = await getLinks();
    const links = new Map(linkRows.map(link => [linkKey(link.remote_type, link.entity_type, link.entity_id), link]));
    await syncTasks(accessToken, links, stats);
    await syncCalendar(accessToken, connection, links, stats);
    const finished = new Date().toISOString();
    await query(
      `UPDATE google_sync_connections SET initial_sync_complete=true,last_synced_at=$1,last_error=NULL,
       sync_lease_until=NULL,updated_at=$1 WHERE id=$2`,
      [finished, CONNECTION_ID],
    );
    return stats;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Google sync failed';
    await query(
      'UPDATE google_sync_connections SET last_error=$1,sync_lease_until=NULL,updated_at=$2 WHERE id=$3',
      [message.slice(0, 2000), new Date().toISOString(), CONNECTION_ID],
    ).catch(() => undefined);
    throw error;
  }
}

export async function getGoogleSyncConnectionStatus() {
  const connection = await getConnection();
  if (!connection) return { connected: false as const };
  const { rows } = await query<{ conflicts: number; errors: number }>(
    `SELECT COUNT(*) FILTER (WHERE sync_status='conflict')::int AS conflicts,
            COUNT(*) FILTER (WHERE sync_status IN ('error','remote_deleted'))::int AS errors
     FROM google_sync_links WHERE connection_id=$1`,
    [CONNECTION_ID],
  );
  return {
    connected: true as const,
    account_email: connection.account_email,
    calendar_name: connection.calendar_name === `${LEGACY_LABEL} Schedule` ? 'Marina Schedule' : connection.calendar_name,
    initial_sync_complete: connection.initial_sync_complete,
    auto_sync_enabled: connection.auto_sync_enabled,
    last_synced_at: connection.last_synced_at,
    last_error: connection.last_error,
    sync_running: Boolean(connection.sync_lease_until && connection.sync_lease_until > new Date().toISOString()),
    conflicts: Number(rows[0]?.conflicts ?? 0),
    errors: Number(rows[0]?.errors ?? 0),
  };
}
