import fs from 'fs/promises';
import path from 'path';
import { canUseLocalPersistence } from '../runtime.js';
import { query } from '../db.js';

type MaybeString = string | null;

interface GoalRow extends Record<string, unknown> {
  id: string;
  title: string;
  description: string;
  category: string;
  status: string;
  progress: number;
  deadline: MaybeString;
  overdue: boolean;
  activity_level: number;
  archived_at: MaybeString;
  created_at: string;
  updated_at: string;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  goal_id: MaybeString;
  parent_task_id: MaybeString;
  milestone_id: MaybeString;
  deadline_id: MaybeString;
  title: string;
  description: string;
  status: string;
  priority: string;
  kind: string;
  tags_json: string;
  due_date: MaybeString;
  start_date: MaybeString;
  estimated_minutes: number | null;
  actual_minutes: number | null;
  time_rollup_mode: string;
  weight_percent: number | null;
  feel_score: number | null;
  last_activity_at: MaybeString;
  completion_note: string;
  completed: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

interface NoteRow extends Record<string, unknown> {
  id: string;
  title: string;
  content: string;
  type: string;
  date_str: string;
  suggested_action_text: MaybeString;
  extracted_tasks_json: string;
  relevant_docs_json: string;
  created_at: string;
  updated_at: string;
}

interface ResourceRow extends Record<string, unknown> {
  id: string;
  title: string;
  url: MaybeString;
  type: string;
  info: string;
  description: MaybeString;
  read_state: string;
  next_action: string;
  tags_json: string;
  estimated_minutes: number | null;
  actual_minutes: number | null;
  file_path: MaybeString;
  external_id: MaybeString;
  created_at: string;
  updated_at: MaybeString;
}

interface JournalRow extends Record<string, unknown> {
  id: string;
  entry_date: string;
  raw_text: string;
  summary: MaybeString;
  mood: MaybeString;
  energy_level: number | null;
  tags_json: string;
  ai_tags_json?: string | null;
  ingestion_status: string;
  created_at: string;
  updated_at: string;
}

interface DeadlineRow extends Record<string, unknown> {
  id: string;
  goal_id: string;
  title: string;
  date: string;
  color: string;
  created_at: string;
}

interface MilestoneRow extends Record<string, unknown> {
  id: string;
  goal_id: string;
  title: string;
  description: string;
  due_date: MaybeString;
  color: string;
  position: number;
  completed: boolean;
  created_at: string;
  updated_at: string;
}

interface MeetingRow extends Record<string, unknown> {
  id: string;
  goal_id: MaybeString;
  milestone_id: MaybeString;
  title: string;
  scheduled_at: string;
  duration_minutes: number | null;
  location: string;
  notes: string;
  summary: MaybeString;
  created_at: string;
  updated_at: string;
}

interface EventRow extends Record<string, unknown> {
  id: string;
  title: string;
  type: string;
  day_index: number;
  start_hour: number;
  duration_hours: number;
  time_str: string;
  description: string;
  week_start: MaybeString;
  locked: boolean;
  source: string;
  created_at: string;
  updated_at: string;
}

interface TaskNoteRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  content: string;
  created_at: string;
}

interface TaskNoteFileRow extends Record<string, unknown> {
  id: string;
  note_id: string;
  name: string;
  mime_type: string;
  size: number;
  file_path: string;
  created_at: string;
}

interface WorkSessionRow extends Record<string, unknown> {
  id: string;
  task_id: MaybeString;
  resource_id: MaybeString;
  goal_id: MaybeString;
  journal_entry_id?: MaybeString;
  started_at: string;
  ended_at: MaybeString;
  minutes: number | null;
  notes: string;
  source: string;
  created_at: string;
}

interface ResourceLogRow extends Record<string, unknown> {
  id: string;
  resource_id: string;
  content: string;
  is_insight: boolean;
  created_at: string;
}

interface ResourceChunkRow extends Record<string, unknown> {
  id: string;
  resource_id: string;
  chunk_index: number;
  heading: MaybeString;
  content: string;
  page_start: number | null;
  page_end: number | null;
  token_count: number | null;
  created_at: string;
}

interface JournalLinkRow extends Record<string, unknown> {
  id: string;
  journal_entry_id: string;
  target_type: string;
  target_id: string;
  relationship: string;
  confidence: number;
  created_by: string;
  created_at: string;
}

interface EdgeRow extends Record<string, unknown> {
  id: string;
  source_id: string;
  source_type: string;
  target_id: string;
  target_type: string;
  relationship: string;
  confidence: number;
  metadata: MaybeString;
  created_by: string;
  created_at: string;
}

interface AliasRow extends Record<string, unknown> {
  id: string;
  entity_type: string;
  entity_id: string;
  alias: string;
  created_by: string;
  created_at: string;
}

interface FactRow extends Record<string, unknown> {
  id: string;
  source_type: string;
  source_id: string;
  fact_type: string;
  fact_text: string;
  target_type: MaybeString;
  target_id: MaybeString;
  confidence: number;
  status: string;
  created_at: string;
}

interface EventTaskLinkRow extends Record<string, unknown> {
  id: string;
  event_id: string;
  task_id: string;
  planned_minutes: number | null;
  created_at: string;
}

interface AgentRunRow extends Record<string, unknown> {
  id: string; source: string; agent_kind: string; session_id: MaybeString;
  user_message: string; intent: MaybeString; intent_confidence: number | null;
  model: MaybeString; status: string; summary: MaybeString; error: MaybeString;
  started_at: string; finished_at: MaybeString; metadata_json: string;
}

interface AgentEventRow extends Record<string, unknown> {
  id: string; run_id: string; sequence: number; event_type: string;
  title: string; detail: MaybeString; status: string; data_json: string; created_at: string;
}

interface VaultManifest {
  version: 2;
  generated_at: string;
  files: string[];
}

export interface ObsidianVaultSyncResult {
  ok: boolean;
  queued?: boolean;
  enabled: boolean;
  vault_dir: string;
  files_written: number;
  removed_stale_files: number;
  generated_at: string;
  reason: string;
}

const MANIFEST_PATH = '.marina/obsidian-manifest.json';
const DEFAULT_DEBOUNCE_MS = 1500;
const SYNC_PATHS = [
  /^\/api\/goals(?:\/|$)/,
  /^\/api\/tasks(?:\/|$)/,
  /^\/api\/task-note-files(?:\/|$)/,
  /^\/api\/notes(?:\/|$)/,
  /^\/api\/resources(?:\/|$)/,
  /^\/api\/journal(?:\/|$)/,
  /^\/api\/meetings(?:\/|$)/,
  /^\/api\/events(?:\/|$)/,
  /^\/api\/edges(?:\/|$)/,
  /^\/api\/goal-deadlines(?:\/|$)/,
  /^\/api\/milestones(?:\/|$)/,
  /^\/api\/work-sessions(?:\/|$)/,
  /^\/api\/event-task-links(?:\/|$)/,
  /^\/api\/entity-aliases(?:\/|$)/,
  /^\/api\/ai\/(?:proposals|schedule)(?:\/|$)/,
  /^\/api\/agent-runs(?:\/|$)/,
];

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncRunning = false;
let syncPending = false;
let pendingReason = 'mutation';
let lastResult: ObsidianVaultSyncResult | null = null;
let lastError: string | null = null;

export function getObsidianVaultDir(): string {
  const configured = process.env.OBSIDIAN_VAULT_DIR || process.env.MARINA_OBSIDIAN_VAULT_DIR;
  return path.resolve(process.cwd(), configured || 'obsidian-vault');
}

export function isObsidianVaultSyncEnabled(): boolean {
  if (!canUseLocalPersistence()) return false;
  if (process.env.NODE_ENV === 'test' && process.env.OBSIDIAN_VAULT_SYNC !== 'true') return false;
  return process.env.OBSIDIAN_VAULT_SYNC !== 'false';
}

export function shouldSyncObsidianVaultForRequest(method: string, requestPath: string): boolean {
  if (!isObsidianVaultSyncEnabled()) return false;
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return false;
  return SYNC_PATHS.some(re => re.test(requestPath));
}

export function getObsidianVaultStatus() {
  return {
    enabled: isObsidianVaultSyncEnabled(),
    vault_dir: getObsidianVaultDir(),
    running: syncRunning,
    pending: syncPending || Boolean(syncTimer),
    last_result: lastResult,
    last_error: lastError,
  };
}

export function scheduleObsidianVaultSync(reason = 'mutation') {
  if (!isObsidianVaultSyncEnabled()) {
    return { queued: false, enabled: false, vault_dir: getObsidianVaultDir() };
  }
  pendingReason = reason;
  if (syncRunning) {
    syncPending = true;
    return { queued: true, enabled: true, vault_dir: getObsidianVaultDir() };
  }
  if (syncTimer) clearTimeout(syncTimer);
  const delay = Number(process.env.OBSIDIAN_VAULT_SYNC_DEBOUNCE_MS ?? DEFAULT_DEBOUNCE_MS);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncObsidianVault(pendingReason);
  }, Number.isFinite(delay) ? Math.max(0, delay) : DEFAULT_DEBOUNCE_MS);
  syncTimer.unref?.();
  return { queued: true, enabled: true, vault_dir: getObsidianVaultDir() };
}

export async function syncObsidianVault(reason = 'manual'): Promise<ObsidianVaultSyncResult> {
  if (!isObsidianVaultSyncEnabled()) {
    const result: ObsidianVaultSyncResult = {
      ok: true,
      enabled: false,
      vault_dir: getObsidianVaultDir(),
      files_written: 0,
      removed_stale_files: 0,
      generated_at: new Date().toISOString(),
      reason,
    };
    lastResult = result;
    return result;
  }

  if (syncRunning) {
    syncPending = true;
    return {
      ok: true,
      queued: true,
      enabled: true,
      vault_dir: getObsidianVaultDir(),
      files_written: 0,
      removed_stale_files: 0,
      generated_at: new Date().toISOString(),
      reason,
    };
  }

  syncRunning = true;
  syncPending = false;
  try {
    const result = await writeVaultSnapshot(reason);
    lastResult = result;
    lastError = null;
    return result;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    syncRunning = false;
    if (syncPending) {
      syncPending = false;
      scheduleObsidianVaultSync('pending mutation');
    }
  }
}

export function makeVaultSafeName(title: string | null | undefined, fallback: string, id?: string): string {
  const source = (title ?? '').trim() || fallback;
  let cleaned = source
    .normalize('NFKD')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!cleaned) cleaned = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) cleaned = `${cleaned}-item`;
  const suffix = id ? `__${id.slice(0, 8)}` : '';
  const maxBase = Math.max(12, 96 - suffix.length);
  if (cleaned.length > maxBase) cleaned = cleaned.slice(0, maxBase).trim().replace(/[. ]+$/g, '');
  return `${cleaned}${suffix}`;
}

export function makeVaultAttachmentName(name: string, id: string): string {
  const originalExt = path.extname(name);
  const ext = originalExt.toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 16);
  const base = path.basename(name, originalExt);
  return `${makeVaultSafeName(base, 'Attachment')}__${id.slice(0, 8)}${ext}`;
}

export function minutesLabel(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return '?';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  if (!m) return `${h}h`;
  return `${h}h ${m}m`;
}

export function yamlFrontmatter(fields: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

async function writeVaultSnapshot(reason: string): Promise<ObsidianVaultSyncResult> {
  const vaultDir = getObsidianVaultDir();
  await fs.mkdir(vaultDir, { recursive: true });

  const data = await loadVaultData();
  const paths = buildEntityPaths(data);
  const files = new Map<string, string>();

  addFile(files, '00 Home.md', renderIndex(data, paths));
  addFile(files, 'README.md', renderReadme());

  for (const goal of data.goals) {
    addFile(files, paths.get(entityKey('goal', goal.id))!, renderGoal(goal, data, paths));
  }
  for (const task of data.tasks) {
    addFile(files, paths.get(entityKey('task', task.id))!, renderTask(task, data, paths));
  }
  for (const milestone of data.milestones) {
    addFile(files, paths.get(entityKey('milestone', milestone.id))!, renderMilestone(milestone, data, paths));
  }
  for (const deadline of data.deadlines) {
    addFile(files, paths.get(entityKey('deadline', deadline.id))!, renderDeadline(deadline, data, paths));
  }
  for (const note of data.notes) {
    addFile(files, paths.get(entityKey('note', note.id))!, renderNote(note));
  }
  for (const resource of data.resources) {
    addFile(files, paths.get(entityKey('resource', resource.id))!, renderResource(resource, data, paths));
  }
  for (const chunk of data.resourceChunks) {
    addFile(files, paths.get(entityKey('resource_chunk', chunk.id))!, renderResourceChunk(chunk, data, paths));
  }
  for (const entry of data.journals) {
    addFile(files, paths.get(entityKey('journal_entry', entry.id))!, renderJournal(entry, data, paths));
  }
  for (const meeting of data.meetings) {
    addFile(files, paths.get(entityKey('meeting', meeting.id))!, renderMeeting(meeting, data, paths));
  }
  for (const event of data.events) {
    addFile(files, paths.get(entityKey('event', event.id))!, renderEvent(event, data, paths));
  }
  for (const run of data.agentRuns) {
    addFile(files, paths.get(entityKey('agent_run', run.id))!, renderAgentRun(run, data));
  }

  const binaryFiles = new Map<string, string>();
  for (const file of data.taskNoteFiles) {
    const relPath = paths.get(entityKey('task_note_file', file.id));
    if (!relPath) continue;
    try {
      await fs.access(file.file_path);
      binaryFiles.set(relPath, file.file_path);
    } catch {
      // The note renderer will mark this attachment as missing.
    }
  }
  for (const resource of data.resources) {
    if (!resource.file_path) continue;
    const relPath = paths.get(entityKey('resource_file', resource.id));
    if (!relPath) continue;
    try {
      await fs.access(resource.file_path);
      binaryFiles.set(relPath, resource.file_path);
    } catch {
      // Preserve the resource note even when a legacy source file is missing.
    }
  }

  const manifest = await readManifest(vaultDir);
  const nextFiles = new Set([...files.keys(), ...binaryFiles.keys()]);
  let removed = 0;
  for (const oldFile of manifest?.files ?? []) {
    if (nextFiles.has(oldFile)) continue;
    try {
      await fs.rm(safeJoin(vaultDir, oldFile), { force: true });
      removed++;
    } catch {
      // Ignore stale deletion failures. The next sync can try again.
    }
  }

  for (const [relPath, content] of files) {
    const abs = safeJoin(vaultDir, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  for (const [relPath, sourcePath] of binaryFiles) {
    const abs = safeJoin(vaultDir, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.copyFile(sourcePath, abs);
  }

  await repairObsidianWorkspace(vaultDir, manifest, nextFiles);

  const generatedAt = new Date().toISOString();
  await writeManifest(vaultDir, {
    version: 2,
    generated_at: generatedAt,
    files: [...nextFiles].sort(),
  });
  await pruneEmptyVaultDirectories(vaultDir, vaultDir);

  return {
    ok: true,
    enabled: true,
    vault_dir: vaultDir,
    files_written: files.size + binaryFiles.size,
    removed_stale_files: removed,
    generated_at: generatedAt,
    reason,
  };
}

async function repairObsidianWorkspace(
  vaultDir: string,
  previousManifest: VaultManifest | null,
  nextFiles: Set<string>,
): Promise<void> {
  const staleGenerated = new Set((previousManifest?.files ?? []).filter(file => !nextFiles.has(file)));
  const workspacePath = safeJoin(vaultDir, '.obsidian/workspace.json');
  try {
    const raw = await fs.readFile(workspacePath, 'utf8');
    const workspace = JSON.parse(raw) as unknown;
    const legacyRefs = new Set<string>();
    collectLegacyWorkspaceRefs(workspace, legacyRefs);
    for (const ref of legacyRefs) {
      try {
        await fs.access(safeJoin(vaultDir, ref));
      } catch {
        staleGenerated.add(ref);
      }
    }
    if (!replaceStaleWorkspaceFiles(workspace, staleGenerated, '00 Home.md')) return;
    await fs.writeFile(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');
  } catch {
    // Missing or user-customized workspace files are left untouched.
  }
}

export function replaceStaleWorkspaceFiles(value: unknown, staleFiles: Set<string>, homePath: string): boolean {
  if (!value || typeof value !== 'object') return false;
  let changed = false;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      if (typeof item === 'string' && staleFiles.has(normalizeRelPath(item))) {
        value[index] = homePath;
        changed = true;
      } else {
        changed = replaceStaleWorkspaceFiles(item, staleFiles, homePath) || changed;
      }
    }
    if (changed) {
      const seenStrings = new Set<string>();
      for (let index = value.length - 1; index >= 0; index--) {
        const item = value[index];
        if (typeof item !== 'string') continue;
        if (seenStrings.has(item)) value.splice(index, 1);
        else seenStrings.add(item);
      }
    }
    return changed;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.file === 'string' && staleFiles.has(normalizeRelPath(record.file))) {
    record.file = homePath;
    changed = true;
  }
  for (const child of Object.values(record)) {
    changed = replaceStaleWorkspaceFiles(child, staleFiles, homePath) || changed;
  }
  return changed;
}

function collectLegacyWorkspaceRefs(value: unknown, refs: Set<string>): void {
  if (typeof value === 'string') {
    const normalized = normalizeRelPath(value);
    if (/^(Goals|Tasks|Calendar|Meetings|Notes|Resources|Journal|Agent Runs)(\/|$)/.test(normalized) || normalized === 'Marina Index.md') {
      refs.add(normalized);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectLegacyWorkspaceRefs(item, refs);
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) collectLegacyWorkspaceRefs(child, refs);
}

async function pruneEmptyVaultDirectories(currentDir: string, vaultRoot: string): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || (currentDir === vaultRoot && entry.name === '.marina')) continue;
    await pruneEmptyVaultDirectories(path.join(currentDir, entry.name), vaultRoot);
  }
  if (currentDir === vaultRoot) return;
  try {
    if ((await fs.readdir(currentDir)).length === 0) await fs.rmdir(currentDir);
  } catch {
    // Only empty generated directories are removed; any user file keeps its folder.
  }
}

async function loadVaultData() {
  const [
    goals,
    tasks,
    notes,
    resources,
    journals,
    deadlines,
    milestones,
    meetings,
    events,
    taskNotes,
    taskNoteFiles,
    workSessions,
    resourceLogs,
    resourceChunks,
    journalLinks,
    edges,
    aliases,
    facts,
    eventTaskLinks,
    agentRuns,
    agentEvents,
  ] = await Promise.all([
    query<GoalRow>('SELECT * FROM goals ORDER BY title ASC, created_at ASC'),
    query<TaskRow>('SELECT * FROM tasks ORDER BY position ASC, due_date NULLS LAST, title ASC'),
    query<NoteRow>('SELECT * FROM notes ORDER BY created_at DESC'),
    query<ResourceRow>('SELECT * FROM resources ORDER BY type ASC, title ASC'),
    query<JournalRow>('SELECT * FROM journal_entries ORDER BY entry_date DESC, created_at DESC'),
    query<DeadlineRow>('SELECT * FROM goal_deadlines ORDER BY date ASC, title ASC'),
    query<MilestoneRow>('SELECT * FROM goal_milestones ORDER BY position ASC, due_date NULLS LAST, title ASC'),
    query<MeetingRow>('SELECT * FROM meetings ORDER BY scheduled_at DESC'),
    query<EventRow>('SELECT * FROM events ORDER BY week_start DESC NULLS LAST, day_index ASC, start_hour ASC'),
    query<TaskNoteRow>('SELECT * FROM task_notes ORDER BY created_at ASC'),
    query<TaskNoteFileRow>('SELECT * FROM task_note_files ORDER BY created_at ASC'),
    query<WorkSessionRow>('SELECT * FROM work_sessions ORDER BY started_at DESC'),
    query<ResourceLogRow>('SELECT * FROM resource_logs ORDER BY created_at ASC'),
    query<ResourceChunkRow>('SELECT * FROM resource_chunks ORDER BY resource_id ASC, chunk_index ASC'),
    query<JournalLinkRow>('SELECT * FROM journal_links ORDER BY created_at ASC'),
    query<EdgeRow>('SELECT * FROM edges ORDER BY created_at ASC'),
    query<AliasRow>('SELECT * FROM entity_aliases ORDER BY alias ASC'),
    query<FactRow>('SELECT * FROM extracted_facts ORDER BY created_at ASC'),
    query<EventTaskLinkRow>('SELECT * FROM event_task_links ORDER BY created_at ASC'),
    query<AgentRunRow>('SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT 1000'),
    query<AgentEventRow>('SELECT * FROM agent_events ORDER BY run_id ASC, sequence ASC'),
  ]);

  return {
    goals: goals.rows,
    tasks: tasks.rows,
    notes: notes.rows,
    resources: resources.rows,
    journals: journals.rows,
    deadlines: deadlines.rows,
    milestones: milestones.rows,
    meetings: meetings.rows,
    events: events.rows,
    taskNotes: taskNotes.rows,
    taskNoteFiles: taskNoteFiles.rows,
    workSessions: workSessions.rows,
    resourceLogs: resourceLogs.rows,
    resourceChunks: resourceChunks.rows,
    journalLinks: journalLinks.rows,
    edges: edges.rows,
    aliases: aliases.rows,
    facts: facts.rows,
    eventTaskLinks: eventTaskLinks.rows,
    agentRuns: agentRuns.rows,
    agentEvents: agentEvents.rows,
  };
}

type VaultData = Awaited<ReturnType<typeof loadVaultData>>;

function buildEntityPaths(data: VaultData): Map<string, string> {
  const paths = new Map<string, string>();
  const goalFolderById = new Map<string, string>();

  for (const goal of data.goals) {
    const folder = `01 Goals/${makeVaultSafeName(goal.title, 'Untitled Goal', goal.id)}`;
    goalFolderById.set(goal.id, folder);
    paths.set(entityKey('goal', goal.id), `${folder}/Overview.md`);
  }

  for (const task of data.tasks) {
    const goalFolder = task.goal_id ? goalFolderById.get(task.goal_id) : null;
    paths.set(entityKey('task', task.id), taskVaultPath(task.title, task.id, goalFolder));
  }

  for (const milestone of data.milestones) {
    const root = goalFolderById.get(milestone.goal_id) ?? '02 Standalone Tasks/_Milestones';
    paths.set(entityKey('milestone', milestone.id), `${root}/Milestones/${makeVaultSafeName(milestone.title, 'Milestone', milestone.id)}.md`);
  }

  for (const deadline of data.deadlines) {
    const root = goalFolderById.get(deadline.goal_id) ?? '02 Standalone Tasks/_Deadlines';
    paths.set(entityKey('deadline', deadline.id), `${root}/Deadlines/${deadline.date} ${makeVaultSafeName(deadline.title, 'Deadline', deadline.id)}.md`);
  }

  for (const note of data.notes) {
    const { year, month } = dateFolders(note.created_at || note.date_str);
    paths.set(entityKey('note', note.id), `05 Notes/${year}/${month}/${makeVaultSafeName(note.title || note.date_str, 'Capture Note', note.id)}.md`);
  }

  for (const note of data.taskNotes) {
    const task = data.tasks.find(candidate => candidate.id === note.task_id);
    const taskPath = task ? paths.get(entityKey('task', task.id)) : null;
    if (!taskPath) continue;
    // Task notes are rendered inside the task note in layout v2. Point legacy
    // note references at the owning task so graph links never become raw UUIDs.
    paths.set(entityKey('task_note', note.id), taskPath);
    if (!paths.has(entityKey('note', note.id))) paths.set(entityKey('note', note.id), taskPath);
  }

  for (const file of data.taskNoteFiles) {
    const note = data.taskNotes.find(candidate => candidate.id === file.note_id);
    const taskPath = note ? paths.get(entityKey('task', note.task_id)) : null;
    if (!taskPath || !note) continue;
    const root = `${path.posix.dirname(taskPath)}/_Files/${note.task_id.slice(0, 8)}`;
    paths.set(
      entityKey('task_note_file', file.id),
      `${root}/${makeVaultAttachmentName(file.name, file.id)}`,
    );
  }

  for (const resource of data.resources) {
    const type = makeVaultSafeName(resource.type || 'other', 'other').toLowerCase();
    const resourceName = makeVaultSafeName(resource.title, 'Untitled Resource', resource.id);
    const root = `06 Resources/${type}`;
    paths.set(entityKey('resource', resource.id), `${root}/${resourceName}.md`);
    if (resource.file_path) {
      const ext = path.extname(resource.file_path);
      paths.set(
        entityKey('resource_file', resource.id),
        `${root}/_Files/${resource.id.slice(0, 8)}/${makeVaultAttachmentName(`${resource.title || 'Resource'}${ext}`, resource.id)}`,
      );
    }
  }

  for (const chunk of data.resourceChunks) {
    const resource = data.resources.find(candidate => candidate.id === chunk.resource_id);
    const resourceFolder = resource
      ? makeVaultSafeName(resource.title, 'Untitled Resource', resource.id)
      : `Orphaned__${chunk.resource_id.slice(0, 8)}`;
    const idx = String(chunk.chunk_index + 1).padStart(3, '0');
    paths.set(entityKey('resource_chunk', chunk.id), `90 System/Resource Text/${resourceFolder}/${idx} ${makeVaultSafeName(chunk.heading, 'Chunk', chunk.id)}.md`);
  }

  for (const entry of data.journals) {
    const { year, month } = dateFolders(entry.entry_date);
    paths.set(entityKey('journal_entry', entry.id), `04 Journal/${year}/${month}/${entry.entry_date}__${entry.id.slice(0, 8)}.md`);
  }

  for (const meeting of data.meetings) {
    const day = datePart(meeting.scheduled_at) || 'unscheduled';
    const { year, month } = dateFolders(day);
    paths.set(entityKey('meeting', meeting.id), `03 Calendar/Meetings/${year}/${month}/${day} ${makeVaultSafeName(meeting.title, 'Meeting', meeting.id)}.md`);
  }

  for (const event of data.events) {
    const { year, month } = dateFolders(event.week_start);
    const root = event.week_start ? `03 Calendar/Events/${year}/${month}` : '03 Calendar/Events/Undated';
    paths.set(entityKey('event', event.id), `${root}/${makeVaultSafeName(event.title, 'Event', event.id)}.md`);
  }

  for (const run of data.agentRuns) {
    const day = datePart(run.started_at) || 'undated';
    const { year, month } = dateFolders(day);
    paths.set(
      entityKey('agent_run', run.id),
      `90 System/AI Runs/${year}/${month}/${day}/${makeVaultSafeName(run.intent || run.agent_kind, 'Agent Run', run.id)}.md`,
    );
  }

  return paths;
}

export function taskVaultPath(title: string, id: string, goalFolder?: string | null): string {
  const root = goalFolder ? `${goalFolder}/Tasks` : '02 Standalone Tasks';
  return `${root}/${makeVaultSafeName(title, 'Untitled Task', id)}.md`;
}

function renderIndex(data: VaultData, paths: Map<string, string>): string {
  const activeGoals = data.goals.filter(g => !g.archived_at);
  const openTasks = data.tasks.filter(t => !t.completed);
  const standaloneTasks = openTasks.filter(task => !task.goal_id);
  const upcomingTasks = openTasks
    .filter(task => task.due_date)
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))
    .slice(0, 20);
  const recentJournals = data.journals.slice(0, 20);
  return [
    yamlFrontmatter({
      id: 'marina-index',
      type: 'marina_index',
      layout_version: 2,
      generated: true,
      tags: ['marina/index'],
    }),
    '# Marina Home',
    '',
    'This vault is generated from the Marina database. Edit in Marina, then let the sync rewrite these files.',
    '',
    '## Snapshot',
    '',
    `- Goals: ${data.goals.length} (${activeGoals.length} active)`,
    `- Tasks: ${data.tasks.length} (${openTasks.length} open)`,
    `- Resources: ${data.resources.length}`,
    `- Notes: ${data.notes.length}`,
    `- Journal entries: ${data.journals.length}`,
    `- Agent runs: ${data.agentRuns.length}`,
    '',
    '## Active Goals',
    '',
    ...activeGoals.map(g => `- ${linkTo(paths, 'goal', g.id, g.title)}${g.deadline ? ` - deadline ${g.deadline}` : ''}`),
    '',
    '## Upcoming Tasks',
    '',
    ...(upcomingTasks.length
      ? upcomingTasks.map(task => `- [${task.completed ? 'x' : ' '}] ${linkTo(paths, 'task', task.id, task.title)} - ${task.due_date}`)
      : ['- No dated open tasks.']),
    '',
    '## Standalone Tasks',
    '',
    ...(standaloneTasks.length
      ? standaloneTasks.map(task => `- [ ] ${linkTo(paths, 'task', task.id, task.title)}${task.due_date ? ` - due ${task.due_date}` : ''}`)
      : ['- No open standalone tasks.']),
    '',
    '## Recent Journal',
    '',
    ...recentJournals.map(j => `- ${linkTo(paths, 'journal_entry', j.id, j.entry_date)}${j.summary ? ` - ${j.summary}` : ''}`),
    '',
  ].join('\n');
}

function renderAgentRun(run: AgentRunRow, data: VaultData): string {
  const events = data.agentEvents.filter(event => event.run_id === run.id);
  const confidence = run.intent_confidence === null ? null : `${Math.round(run.intent_confidence * 100)}%`;
  return [
    yamlFrontmatter({
      id: run.id,
      type: 'agent_run',
      source: run.source,
      agent_kind: run.agent_kind,
      session_id: run.session_id,
      intent: run.intent,
      intent_confidence: run.intent_confidence,
      model: run.model,
      status: run.status,
      started_at: run.started_at,
      finished_at: run.finished_at,
      tags: ['marina/agent-run', `marina/agent/${tagFor(run.agent_kind)}`],
    }),
    `# ${run.intent || run.agent_kind}`,
    '',
    compactMeta([
      ['Status', run.status],
      ['Agent', run.agent_kind],
      ['Model', run.model],
      ['Confidence', confidence],
      ['Started', run.started_at],
      ['Finished', run.finished_at],
    ]),
    section('Request', run.user_message),
    section('Outcome', run.summary || run.error || 'Run still in progress.'),
    '## Event trail',
    '',
    ...(events.length ? events.map(event => {
      const detail = event.detail ? ` — ${event.detail}` : '';
      return `- **${event.sequence}. ${event.title}** (${event.created_at})${detail}`;
    }) : ['- No events recorded.']),
    '',
  ].join('\n');
}

function renderReadme(): string {
  return [
    '# Marina Obsidian Vault',
    '',
    'This folder is generated from Marina.',
    '',
    '- Marina remains the source of truth.',
    '- Generated files are tracked in `.marina/obsidian-manifest.json`.',
    '- Files that are not in the manifest are left alone.',
    '- To change the vault location, set `OBSIDIAN_VAULT_DIR` before starting the server.',
    '',
    '## Layout',
    '',
    '```text',
    '00 Home.md',
    '01 Goals/<goal>/',
    '  Overview.md',
    '  Tasks/<task>.md',
    '  Milestones/',
    '  Deadlines/',
    '02 Standalone Tasks/<task>.md',
    '03 Calendar/{Events,Meetings}/YYYY/MM/',
    '04 Journal/YYYY/MM/',
    '05 Notes/YYYY/MM/',
    '06 Resources/<type>/',
    '90 System/{AI Runs,Resource Text}/',
    '```',
    '',
    'Each task is one complete note containing its status, progress, subtasks, notes, files, resources, work sessions, scheduled blocks, journal links, and graph links.',
    '',
    'Technical records are kept under `90 System` so they do not crowd normal navigation.',
    '',
    'Use the generated files for browsing in Obsidian; make edits in Marina so the database and vault stay consistent.',
    '',
  ].join('\n');
}

function renderGoal(goal: GoalRow, data: VaultData, paths: Map<string, string>): string {
  const tasks = data.tasks.filter(t => t.goal_id === goal.id);
  const milestones = data.milestones.filter(m => m.goal_id === goal.id);
  const deadlines = data.deadlines.filter(d => d.goal_id === goal.id);
  const meetings = data.meetings.filter(m => m.goal_id === goal.id);
  const journalRefs = refsForTarget(data, 'goal', goal.id, paths);
  const aliases = aliasesFor(data, 'goal', goal.id);
  const facts = factsForTarget(data, 'goal', goal.id);
  return [
    yamlFrontmatter({
      id: goal.id,
      type: 'goal',
      status: goal.status,
      category: goal.category,
      progress: goal.progress,
      deadline: goal.deadline,
      archived_at: goal.archived_at,
      created_at: goal.created_at,
      updated_at: goal.updated_at,
      aliases,
      tags: ['marina/goal', tagFor(goal.category)],
    }),
    `# ${goal.title || 'Untitled Goal'}`,
    '',
    compactMeta([
      ['Status', goal.status],
      ['Progress', `${Math.round(Number(goal.progress ?? 0))}%`],
      ['Deadline', goal.deadline],
      ['Activity', String(goal.activity_level ?? '')],
    ]),
    section('Description', goal.description),
    section('Task Tree', renderTaskTree(tasks, paths)),
    section('Milestones', bullets(milestones.map(m => `${linkTo(paths, 'milestone', m.id, m.title)}${m.due_date ? ` - due ${m.due_date}` : ''}${m.completed ? ' - done' : ''}`))),
    section('Deadlines', bullets(deadlines.map(d => `${linkTo(paths, 'deadline', d.id, d.title)} - ${d.date}`))),
    section('Meetings', bullets(meetings.map(m => `${linkTo(paths, 'meeting', m.id, m.title)} - ${m.scheduled_at}`))),
    section('Journal Mentions', bullets(journalRefs)),
    section('Facts', bullets(facts.map(f => `${f.fact_type}: ${f.fact_text}`))),
    section('Graph Links', bullets(graphLinksFor(data, paths, 'goal', goal.id))),
  ].join('\n');
}

function resourcesForTask(taskId: string, data: VaultData): { direct: ResourceRow[]; mentioned: ResourceRow[]; all: ResourceRow[] } {
  const directIds = new Set(
    data.edges
      .filter(edge => edge.source_type === 'resource' && edge.target_type === 'task' && edge.target_id === taskId && edge.relationship === 'attached_to')
      .map(edge => edge.source_id),
  );
  const noteIds = new Set(data.taskNotes.filter(note => note.task_id === taskId).map(note => note.id));
  const mentionedIds = new Set(
    data.edges
      .filter(edge => edge.source_type === 'note' && noteIds.has(edge.source_id) && edge.target_type === 'resource' && edge.relationship === 'mentions')
      .map(edge => edge.target_id),
  );
  const direct = data.resources.filter(resource => directIds.has(resource.id));
  const mentioned = data.resources.filter(resource => mentionedIds.has(resource.id) && !directIds.has(resource.id));
  return { direct, mentioned, all: [...direct, ...mentioned] };
}

function renderTask(task: TaskRow, data: VaultData, paths: Map<string, string>): string {
  const notes = data.taskNotes
    .filter(n => n.task_id === task.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const sessions = data.workSessions
    .filter(ws => ws.task_id === task.id)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
  const subtasks = sortTasks(data.tasks.filter(t => t.parent_task_id === task.id));
  const eventLinks = data.eventTaskLinks.filter(link => link.task_id === task.id);
  const tags = parseJsonArray(task.tags_json).map(tagFor).filter(Boolean);
  const resources = resourcesForTask(task.id, data);
  const taskPath = paths.get(entityKey('task', task.id))!;
  const noteIds = new Set(notes.map(note => note.id));
  const attachments = data.taskNoteFiles.filter(file => noteIds.has(file.note_id));
  const attachmentLink = (file: TaskNoteFileRow) => {
    const attachmentPath = paths.get(entityKey('task_note_file', file.id));
    if (!attachmentPath) return `${file.name} (source file missing)`;
    const relative = path.posix.relative(path.posix.dirname(taskPath), attachmentPath);
    return `[${file.name}](<${relative}>) - ${file.mime_type}, ${file.size} bytes`;
  };
  const loggedMinutes = sessions.reduce((sum, session) => sum + Number(session.minutes ?? 0), 0);
  const completedSubtasks = subtasks.filter(candidate => candidate.completed || candidate.status === 'done').length;
  const estimate = Number(task.estimated_minutes ?? 0);
  const variance = estimate > 0 && (task.completed || task.status === 'done') ? loggedMinutes - estimate : null;
  const progressRows = [
    subtasks.length ? `${completedSubtasks}/${subtasks.length} direct subtasks completed` : null,
    `Estimated work: ${minutesLabel(task.estimated_minutes)}`,
    `Logged work: ${minutesLabel(loggedMinutes || task.actual_minutes)}`,
    variance === null ? null : variance === 0 ? 'Finished on estimate' : variance > 0
      ? `${minutesLabel(variance)} over estimate`
      : `${minutesLabel(Math.abs(variance))} under estimate`,
    task.feel_score != null ? `Feel score: ${task.feel_score}/100` : null,
    task.last_activity_at ? `Last activity: ${task.last_activity_at}` : null,
  ];
  const renderedNotes = notes.map(note => {
    const noteFiles = attachments.filter(file => file.note_id === note.id);
    return [
      `### ${note.created_at}`,
      '',
      note.content || '_Empty note_',
      noteFiles.length ? `\n**Attachments**\n\n${bullets(noteFiles.map(attachmentLink))}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  return [
    yamlFrontmatter({
      id: task.id,
      type: 'task',
      layout_version: 2,
      goal: task.goal_id,
      parent_task: task.parent_task_id,
      milestone: task.milestone_id,
      deadline: task.deadline_id,
      status: task.status,
      priority: task.priority,
      completed: task.completed,
      start_date: task.start_date,
      due_date: task.due_date,
      estimated_minutes: task.estimated_minutes,
      actual_minutes: task.actual_minutes,
      created_at: task.created_at,
      updated_at: task.updated_at,
      aliases: aliasesFor(data, 'task', task.id),
      tags: ['marina/task', ...tags],
    }),
    `# ${task.title || 'Untitled Task'}`,
    '',
    compactMeta([
      ['Goal', task.goal_id ? linkTo(paths, 'goal', task.goal_id, titleFor(data, 'goal', task.goal_id)) : 'Standalone / no goal'],
      ['Parent', task.parent_task_id ? linkTo(paths, 'task', task.parent_task_id, titleFor(data, 'task', task.parent_task_id)) : null],
      ['Status', `${task.completed ? 'done' : task.status} / ${task.priority}`],
      ['Estimate', minutesLabel(task.estimated_minutes)],
      ['Actual', minutesLabel(task.actual_minutes)],
      ['Start', task.start_date],
      ['Due', task.due_date],
    ]),
    section('Description', task.description),
    section('Progress', bullets(progressRows)),
    section('Completion Report', task.completion_note),
    section('Subtasks', bullets(subtasks.map(t => `${t.completed ? '[x]' : '[ ]'} ${linkTo(paths, 'task', t.id, t.title)} - ${minutesLabel(t.estimated_minutes)}`))),
    section('Notes', renderedNotes),
    section('Files', bullets(attachments.map(attachmentLink))),
    section('Resources', bullets([
      ...resources.direct.map(resource => `${linkTo(paths, 'resource', resource.id, resource.title)} - attached`),
      ...resources.mentioned.map(resource => `${linkTo(paths, 'resource', resource.id, resource.title)} - mentioned in notes`),
    ])),
    section('Work Sessions', bullets(sessions.map(s => `${s.started_at} - ${minutesLabel(s.minutes)}${s.notes ? ` - ${s.notes}` : ''}`))),
    section('Scheduled Blocks', bullets(eventLinks.map(link => {
      const event = data.events.find(ev => ev.id === link.event_id);
      return event ? `${linkTo(paths, 'event', event.id, event.title)} - ${minutesLabel(link.planned_minutes)}` : link.id;
    }))),
    section('Journal Mentions', bullets(refsForTarget(data, 'task', task.id, paths))),
    section('Facts', bullets(factsForTarget(data, 'task', task.id).map(f => `${f.fact_type}: ${f.fact_text}`))),
    section('Graph Links', bullets(graphLinksFor(data, paths, 'task', task.id))),
  ].join('\n');
}

function renderTaskProgress(task: TaskRow, data: VaultData, paths: Map<string, string>): string {
  const subtasks = data.tasks.filter(candidate => candidate.parent_task_id === task.id);
  const completedSubtasks = subtasks.filter(candidate => candidate.completed || candidate.status === 'done').length;
  const sessions = data.workSessions.filter(session => session.task_id === task.id && session.minutes != null);
  const loggedMinutes = sessions.reduce((sum, session) => sum + Number(session.minutes ?? 0), 0);
  const estimate = Number(task.estimated_minutes ?? 0);
  const variance = estimate > 0 && (task.completed || task.status === 'done')
    ? loggedMinutes - estimate
    : null;
  const varianceLabel = variance === null
    ? null
    : variance === 0
      ? 'On estimate'
      : variance > 0
        ? `${minutesLabel(variance)} over estimate`
        : `${minutesLabel(Math.abs(variance))} under estimate`;
  const recentSessions = sessions
    .slice()
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, 10);

  return [
    yamlFrontmatter({
      id: `${task.id}:progress`,
      type: 'task_progress',
      task: task.id,
      status: task.completed ? 'done' : task.status,
      generated_from: 'marina_database',
      updated_at: task.updated_at,
      tags: ['marina/task-progress'],
    }),
    `# Current progress - ${task.title || 'Untitled Task'}`,
    '',
    compactMeta([
      ['Task', linkTo(paths, 'task', task.id, task.title)],
      ['State', task.completed ? 'done' : task.status],
      ['Priority', task.priority],
      ['Due', task.due_date],
      ['Last activity', task.last_activity_at],
    ]),
    section('Progress Summary', bullets([
      subtasks.length ? `${completedSubtasks}/${subtasks.length} direct subtasks completed` : 'No direct subtasks',
      `Estimated work: ${minutesLabel(task.estimated_minutes)}`,
      `Logged work: ${minutesLabel(loggedMinutes || task.actual_minutes)}`,
      varianceLabel,
      task.feel_score != null ? `Current feel score: ${task.feel_score}/100` : null,
    ])),
    section('Completion Report', task.completion_note),
    section('Recent Work Sessions', bullets(recentSessions.map(session =>
      `${session.started_at} - ${minutesLabel(session.minutes)}${session.notes ? ` - ${session.notes}` : ''}`,
    ))),
    section('Subtasks', bullets(subtasks.map(child =>
      `${child.completed ? '[x]' : '[ ]'} ${linkTo(paths, 'task', child.id, child.title)} - ${child.status}`,
    ))),
    section('Activity Timeline', linkTo(paths, 'task_timeline', task.id, 'Open the complete timeline')),
  ].join('\n');
}

function renderTaskTimeline(task: TaskRow, data: VaultData, paths: Map<string, string>): string {
  const notes = data.taskNotes.filter(note => note.task_id === task.id);
  const sessions = data.workSessions.filter(session => session.task_id === task.id);
  const entries = [
    ...notes.map(note => ({
      at: note.created_at,
      text: `Note: ${linkTo(paths, 'task_note', note.id, note.content.trim().slice(0, 80) || 'Task note')}`,
    })),
    ...sessions.map(session => ({
      at: session.started_at,
      text: `Work session: ${minutesLabel(session.minutes)}${session.notes ? ` - ${session.notes}` : ''}`,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return [
    yamlFrontmatter({
      id: `${task.id}:timeline`,
      type: 'task_timeline',
      task: task.id,
      generated_from: 'marina_database',
      updated_at: task.updated_at,
      tags: ['marina/task-timeline'],
    }),
    `# Activity timeline - ${task.title || 'Untitled Task'}`,
    '',
    compactMeta([['Task', linkTo(paths, 'task', task.id, task.title)]]),
    entries.length
      ? entries.map(entry => `## ${entry.at}\n\n${entry.text}`).join('\n\n')
      : 'No notes or work sessions yet.',
  ].join('\n');
}

function renderTaskResources(task: TaskRow, data: VaultData, paths: Map<string, string>): string {
  const resources = resourcesForTask(task.id, data);
  return [
    yamlFrontmatter({
      id: `${task.id}:resources`,
      type: 'task_resources',
      task: task.id,
      generated_from: 'marina_database',
      updated_at: task.updated_at,
      tags: ['marina/task-resources'],
    }),
    `# Resources - ${task.title || 'Untitled Task'}`,
    '',
    compactMeta([['Task', linkTo(paths, 'task', task.id, task.title)]]),
    section('Attached Resources', bullets(resources.direct.map(resource =>
      `${linkTo(paths, 'resource', resource.id, resource.title)} - ${resource.type} / ${resource.read_state}`,
    ))),
    section('Mentioned in Task Notes', bullets(resources.mentioned.map(resource =>
      `${linkTo(paths, 'resource', resource.id, resource.title)} - ${resource.type} / ${resource.read_state}`,
    ))),
    resources.all.length ? '' : 'No resources attached or mentioned yet.',
  ].join('\n');
}

function renderTaskNotesIndex(task: TaskRow, data: VaultData, paths: Map<string, string>): string {
  const notes = data.taskNotes
    .filter(note => note.task_id === task.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return [
    yamlFrontmatter({
      id: `${task.id}:notes`,
      type: 'task_notes_index',
      task: task.id,
      generated_from: 'marina_database',
      updated_at: task.updated_at,
      tags: ['marina/task-notes'],
    }),
    `# Notes - ${task.title || 'Untitled Task'}`,
    '',
    compactMeta([['Task', linkTo(paths, 'task', task.id, task.title)]]),
    notes.length
      ? notes.map(note => `- ${linkTo(paths, 'task_note', note.id, note.created_at)} - ${note.content.trim().replace(/\s+/g, ' ').slice(0, 120) || 'Empty note'}`).join('\n')
      : 'No notes yet.',
  ].join('\n');
}

function renderTaskFilesIndex(task: TaskRow, data: VaultData, paths: Map<string, string>): string {
  const notes = data.taskNotes.filter(note => note.task_id === task.id);
  const noteById = new Map(notes.map(note => [note.id, note]));
  const indexPath = paths.get(entityKey('task_files_index', task.id))!;
  const files = data.taskNoteFiles.filter(file => noteById.has(file.note_id));
  const fileRows = files.map(file => {
    const attachmentPath = paths.get(entityKey('task_note_file', file.id));
    const note = noteById.get(file.note_id)!;
    const fileLink = attachmentPath
      ? `[${file.name}](<${path.posix.relative(path.posix.dirname(indexPath), attachmentPath)}>)`
      : file.name;
    return `${fileLink} - ${file.mime_type}, ${file.size} bytes - from ${linkTo(paths, 'task_note', note.id, note.created_at)}`;
  });
  return [
    yamlFrontmatter({
      id: `${task.id}:files`,
      type: 'task_files_index',
      task: task.id,
      generated_from: 'marina_database',
      updated_at: task.updated_at,
      tags: ['marina/task-files'],
    }),
    `# Files - ${task.title || 'Untitled Task'}`,
    '',
    compactMeta([['Task', linkTo(paths, 'task', task.id, task.title)]]),
    fileRows.length ? bullets(fileRows) : 'No task-note files yet.',
    '',
    `Uploaded resources are indexed separately in ${linkTo(paths, 'task_resources', task.id, 'Resources')}.`,
  ].join('\n');
}

function renderTaskNote(note: TaskNoteRow, data: VaultData, paths: Map<string, string>): string {
  const task = data.tasks.find(candidate => candidate.id === note.task_id);
  const files = data.taskNoteFiles.filter(file => file.note_id === note.id);
  const mentionedResources = data.edges
    .filter(edge => edge.source_type === 'note' && edge.source_id === note.id && edge.target_type === 'resource' && edge.relationship === 'mentions')
    .map(edge => data.resources.find(resource => resource.id === edge.target_id))
    .filter((resource): resource is ResourceRow => Boolean(resource));
  const notePath = paths.get(entityKey('task_note', note.id))!;
  const attachmentLinks = files.map(file => {
    const attachmentPath = paths.get(entityKey('task_note_file', file.id));
    if (!attachmentPath) return `${file.name} - missing attachment path`;
    const relative = path.posix.relative(path.posix.dirname(notePath), attachmentPath);
    return `[${file.name}](<${relative}>) - ${file.mime_type}, ${file.size} bytes`;
  });

  return [
    yamlFrontmatter({
      id: note.id,
      type: 'task_note',
      task: note.task_id,
      goal: task?.goal_id,
      created_at: note.created_at,
      resources: mentionedResources.map(resource => resource.id),
      tags: ['marina/task-note'],
    }),
    `# Task note - ${task?.title || 'Unassigned task'}`,
    '',
    compactMeta([
      ['Task', task ? linkTo(paths, 'task', task.id, task.title) : note.task_id],
      ['Created', note.created_at],
    ]),
    note.content || '',
    section('Mentioned Resources', bullets(mentionedResources.map(resource => linkTo(paths, 'resource', resource.id, resource.title)))),
    section('Attachments', bullets(attachmentLinks)),
    section('Graph Links', bullets(graphLinksFor(data, paths, 'note', note.id))),
  ].join('\n');
}

function renderMilestone(milestone: MilestoneRow, data: VaultData, paths: Map<string, string>): string {
  const tasks = data.tasks.filter(t => t.milestone_id === milestone.id);
  return [
    yamlFrontmatter({
      id: milestone.id,
      type: 'milestone',
      goal: milestone.goal_id,
      due_date: milestone.due_date,
      completed: milestone.completed,
      created_at: milestone.created_at,
      updated_at: milestone.updated_at,
      tags: ['marina/milestone'],
    }),
    `# ${milestone.title || 'Milestone'}`,
    '',
    compactMeta([
      ['Goal', linkTo(paths, 'goal', milestone.goal_id, titleFor(data, 'goal', milestone.goal_id))],
      ['Due', milestone.due_date],
      ['Done', milestone.completed ? 'yes' : 'no'],
    ]),
    section('Description', milestone.description),
    section('Tasks', bullets(tasks.map(t => `${t.completed ? '[x]' : '[ ]'} ${linkTo(paths, 'task', t.id, t.title)}`))),
  ].join('\n');
}

function renderDeadline(deadline: DeadlineRow, data: VaultData, paths: Map<string, string>): string {
  const tasks = data.tasks.filter(t => t.deadline_id === deadline.id || t.due_date === deadline.date);
  return [
    yamlFrontmatter({
      id: deadline.id,
      type: 'deadline',
      goal: deadline.goal_id,
      date: deadline.date,
      color: deadline.color,
      created_at: deadline.created_at,
      tags: ['marina/deadline'],
    }),
    `# ${deadline.title || 'Deadline'}`,
    '',
    compactMeta([
      ['Goal', linkTo(paths, 'goal', deadline.goal_id, titleFor(data, 'goal', deadline.goal_id))],
      ['Date', deadline.date],
    ]),
    section('Related Tasks', bullets(tasks.map(t => `${t.completed ? '[x]' : '[ ]'} ${linkTo(paths, 'task', t.id, t.title)} - ${minutesLabel(t.estimated_minutes)}`))),
  ].join('\n');
}

function renderNote(note: NoteRow): string {
  return [
    yamlFrontmatter({
      id: note.id,
      type: 'note',
      note_type: note.type,
      date: note.date_str,
      created_at: note.created_at,
      updated_at: note.updated_at,
      tags: ['marina/note', tagFor(note.type)],
    }),
    `# ${note.title || 'Capture Note'}`,
    '',
    note.content || '',
    section('Suggested Action', note.suggested_action_text),
    section('Extracted Tasks JSON', codeBlock(note.extracted_tasks_json, 'json')),
    section('Relevant Docs JSON', codeBlock(note.relevant_docs_json, 'json')),
  ].join('\n');
}

function renderResource(resource: ResourceRow, data: VaultData, paths: Map<string, string>): string {
  const logs = data.resourceLogs.filter(l => l.resource_id === resource.id);
  const chunks = data.resourceChunks.filter(c => c.resource_id === resource.id);
  const sessions = data.workSessions.filter(ws => ws.resource_id === resource.id);
  const tags = parseJsonArray(resource.tags_json).map(tagFor).filter(Boolean);
  const resourcePath = paths.get(entityKey('resource', resource.id))!;
  const copiedFilePath = paths.get(entityKey('resource_file', resource.id));
  const copiedFileLink = copiedFilePath
    ? `[Open vault copy](<${path.posix.relative(path.posix.dirname(resourcePath), copiedFilePath)}>)`
    : null;
  return [
    yamlFrontmatter({
      id: resource.id,
      type: 'resource',
      resource_type: resource.type,
      read_state: resource.read_state,
      url: resource.url,
      file_path: resource.file_path,
      external_id: resource.external_id,
      estimated_minutes: resource.estimated_minutes,
      actual_minutes: resource.actual_minutes,
      created_at: resource.created_at,
      updated_at: resource.updated_at,
      aliases: aliasesFor(data, 'resource', resource.id),
      tags: ['marina/resource', tagFor(resource.type), ...tags],
    }),
    `# ${resource.title || 'Untitled Resource'}`,
    '',
    compactMeta([
      ['Type', resource.type],
      ['Read State', resource.read_state],
      ['Estimate', minutesLabel(resource.estimated_minutes)],
      ['Actual', minutesLabel(resource.actual_minutes)],
      ['URL', resource.url ? `[Open link](${resource.url})` : null],
      ['File', resource.file_path ? (copiedFileLink ?? 'Source file missing') : null],
    ]),
    section('Description', resource.description),
    section('Info', resource.info),
    section('Next Action', resource.next_action),
    section('Logs', logs.map(log => `### ${log.is_insight ? 'Insight' : 'Log'} - ${log.created_at}\n\n${log.content}`).join('\n\n')),
    section('Chunks', bullets(chunks.map(c => linkTo(paths, 'resource_chunk', c.id, c.heading || `Chunk ${c.chunk_index + 1}`)))),
    section('Work Sessions', bullets(sessions.map(s => `${datePart(s.started_at)} - ${minutesLabel(s.minutes)}${s.notes ? ` - ${s.notes}` : ''}`))),
    section('Journal Mentions', bullets(refsForTarget(data, 'resource', resource.id, paths))),
    section('Facts', bullets(factsForTarget(data, 'resource', resource.id).map(f => `${f.fact_type}: ${f.fact_text}`))),
    section('Graph Links', bullets(graphLinksFor(data, paths, 'resource', resource.id))),
  ].join('\n');
}

function renderResourceChunk(chunk: ResourceChunkRow, data: VaultData, paths: Map<string, string>): string {
  const resource = data.resources.find(r => r.id === chunk.resource_id);
  return [
    yamlFrontmatter({
      id: chunk.id,
      type: 'resource_chunk',
      resource: chunk.resource_id,
      chunk_index: chunk.chunk_index,
      page_start: chunk.page_start,
      page_end: chunk.page_end,
      token_count: chunk.token_count,
      created_at: chunk.created_at,
      tags: ['marina/resource-chunk'],
    }),
    `# ${chunk.heading || `Chunk ${chunk.chunk_index + 1}`}`,
    '',
    compactMeta([
      ['Resource', resource ? linkTo(paths, 'resource', resource.id, resource.title) : chunk.resource_id],
      ['Pages', chunk.page_start || chunk.page_end ? `${chunk.page_start ?? '?'}-${chunk.page_end ?? '?'}` : null],
    ]),
    chunk.content,
    '',
  ].join('\n');
}

function renderJournal(entry: JournalRow, data: VaultData, paths: Map<string, string>): string {
  const links = data.journalLinks.filter(l => l.journal_entry_id === entry.id);
  const facts = data.facts.filter(f => f.source_type === 'journal_entry' && f.source_id === entry.id);
  const sessions = data.workSessions.filter(ws => ws.journal_entry_id === entry.id);
  const tags = [...parseJsonArray(entry.tags_json), ...parseJsonArray(entry.ai_tags_json)].map(tagFor).filter(Boolean);
  return [
    yamlFrontmatter({
      id: entry.id,
      type: 'journal_entry',
      entry_date: entry.entry_date,
      mood: entry.mood,
      energy_level: entry.energy_level,
      ingestion_status: entry.ingestion_status,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
      tags: ['marina/journal', ...tags],
    }),
    `# ${entry.entry_date} Journal`,
    '',
    compactMeta([
      ['Mood', entry.mood],
      ['Energy', entry.energy_level === null ? null : String(entry.energy_level)],
      ['Ingestion', entry.ingestion_status],
    ]),
    section('Summary', entry.summary),
    section('Entry', entry.raw_text),
    section('Linked Entities', bullets(links.map(link => {
      const label = titleFor(data, link.target_type, link.target_id);
      return `${linkTo(paths, link.target_type, link.target_id, label)} - ${link.relationship} (${Math.round(Number(link.confidence ?? 0) * 100)}%, ${link.created_by})`;
    }))),
    section('Work Sessions', bullets(sessions.map(s => `${minutesLabel(s.minutes)}${s.task_id ? ` on ${linkTo(paths, 'task', s.task_id, titleFor(data, 'task', s.task_id))}` : ''}${s.resource_id ? ` with ${linkTo(paths, 'resource', s.resource_id, titleFor(data, 'resource', s.resource_id))}` : ''}`))),
    section('Extracted Facts', bullets(facts.map(f => `${f.fact_type}: ${f.fact_text}${f.target_id && f.target_type ? ` -> ${linkTo(paths, f.target_type, f.target_id, titleFor(data, f.target_type, f.target_id))}` : ''}`))),
  ].join('\n');
}

function renderMeeting(meeting: MeetingRow, data: VaultData, paths: Map<string, string>): string {
  return [
    yamlFrontmatter({
      id: meeting.id,
      type: 'meeting',
      goal: meeting.goal_id,
      milestone: meeting.milestone_id,
      scheduled_at: meeting.scheduled_at,
      duration_minutes: meeting.duration_minutes,
      location: meeting.location,
      created_at: meeting.created_at,
      updated_at: meeting.updated_at,
      aliases: aliasesFor(data, 'meeting', meeting.id),
      tags: ['marina/meeting'],
    }),
    `# ${meeting.title || 'Meeting'}`,
    '',
    compactMeta([
      ['Goal', meeting.goal_id ? linkTo(paths, 'goal', meeting.goal_id, titleFor(data, 'goal', meeting.goal_id)) : null],
      ['When', meeting.scheduled_at],
      ['Duration', minutesLabel(meeting.duration_minutes)],
      ['Location', meeting.location],
    ]),
    section('Notes', meeting.notes),
    section('Summary', meeting.summary),
    section('Journal Mentions', bullets(refsForTarget(data, 'meeting', meeting.id, paths))),
    section('Graph Links', bullets(graphLinksFor(data, paths, 'meeting', meeting.id))),
  ].join('\n');
}

function renderEvent(event: EventRow, data: VaultData, paths: Map<string, string>): string {
  const linkedTasks = data.eventTaskLinks.filter(link => link.event_id === event.id);
  return [
    yamlFrontmatter({
      id: event.id,
      type: 'calendar_event',
      event_type: event.type,
      week_start: event.week_start,
      day_index: event.day_index,
      start_hour: event.start_hour,
      duration_hours: event.duration_hours,
      locked: event.locked,
      source: event.source,
      created_at: event.created_at,
      updated_at: event.updated_at,
      tags: ['marina/event'],
    }),
    `# ${event.title || 'Event'}`,
    '',
    compactMeta([
      ['Type', event.type],
      ['Time', event.time_str || `${event.start_hour}`],
      ['Week', event.week_start],
      ['Day Index', String(event.day_index)],
      ['Duration', `${event.duration_hours}h`],
      ['Source', event.source],
    ]),
    section('Description', event.description),
    section('Linked Tasks', bullets(linkedTasks.map(link => `${linkTo(paths, 'task', link.task_id, titleFor(data, 'task', link.task_id))} - ${minutesLabel(link.planned_minutes)}`))),
  ].join('\n');
}

function renderTaskTree(tasks: TaskRow[], paths: Map<string, string>): string {
  if (!tasks.length) return '';
  const taskIds = new Set(tasks.map(t => t.id));
  const children = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    if (!task.parent_task_id || !taskIds.has(task.parent_task_id)) continue;
    const bucket = children.get(task.parent_task_id) ?? [];
    bucket.push(task);
    children.set(task.parent_task_id, bucket);
  }
  const roots = sortTasks(tasks.filter(t => !t.parent_task_id || !taskIds.has(t.parent_task_id)));
  const lines: string[] = [];
  const visit = (task: TaskRow, depth: number) => {
    const indent = '  '.repeat(depth);
    const meta = [
      task.due_date ? `due ${task.due_date}` : null,
      minutesLabel(task.estimated_minutes),
      task.priority,
    ].filter(Boolean).join(', ');
    lines.push(`${indent}- [${task.completed ? 'x' : ' '}] ${linkTo(paths, 'task', task.id, task.title)}${meta ? ` (${meta})` : ''}`);
    for (const child of sortTasks(children.get(task.id) ?? [])) visit(child, depth + 1);
  };
  roots.forEach(root => visit(root, 0));
  return lines.join('\n');
}

function sortTasks(tasks: TaskRow[]): TaskRow[] {
  return [...tasks].sort((a, b) =>
    Number(a.position ?? 0) - Number(b.position ?? 0) ||
    String(a.due_date ?? '9999-99-99').localeCompare(String(b.due_date ?? '9999-99-99')) ||
    a.title.localeCompare(b.title),
  );
}

function compactMeta(rows: Array<[string, string | null | undefined]>): string {
  const lines = rows
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `- ${key}: ${value}`);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function section(title: string, body: string | null | undefined): string {
  const clean = (body ?? '').trim();
  if (!clean) return '';
  return `## ${title}\n\n${clean}\n`;
}

function bullets(items: Array<string | null | undefined>): string {
  const clean = items.filter((item): item is string => Boolean(item && item.trim()));
  return clean.length ? clean.map(item => `- ${item}`).join('\n') : '';
}

function codeBlock(value: string | null | undefined, lang = ''): string {
  if (!value || value === '[]' || value === '{}') return '';
  return `\`\`\`${lang}\n${value}\n\`\`\``;
}

function refsForTarget(data: VaultData, targetType: string, targetId: string, paths: Map<string, string>): string[] {
  return data.journalLinks
    .filter(link => link.target_type === targetType && link.target_id === targetId)
    .map(link => {
      const entry = data.journals.find(j => j.id === link.journal_entry_id);
      if (!entry) return null;
      return `${linkTo(paths, 'journal_entry', entry.id, entry.entry_date)} - ${link.relationship} (${Math.round(Number(link.confidence ?? 0) * 100)}%)`;
    })
    .filter((item): item is string => Boolean(item));
}

function factsForTarget(data: VaultData, targetType: string, targetId: string): FactRow[] {
  return data.facts.filter(f => f.target_type === targetType && f.target_id === targetId && f.status !== 'deleted');
}

function aliasesFor(data: VaultData, entityType: string, entityId: string): string[] {
  return data.aliases
    .filter(a => a.entity_type === entityType && a.entity_id === entityId)
    .map(a => a.alias);
}

function graphLinksFor(data: VaultData, paths: Map<string, string>, entityType: string, entityId: string): string[] {
  return data.edges
    .filter(edge =>
      (edge.source_type === entityType && edge.source_id === entityId) ||
      (edge.target_type === entityType && edge.target_id === entityId),
    )
    .map(edge => {
      const isSource = edge.source_type === entityType && edge.source_id === entityId;
      const otherType = isSource ? edge.target_type : edge.source_type;
      const otherId = isSource ? edge.target_id : edge.source_id;
      return `${edge.relationship} ${isSource ? 'to' : 'from'} ${linkTo(paths, otherType, otherId, titleFor(data, otherType, otherId))}`;
    });
}

function titleFor(data: VaultData, entityType: string, entityId: string): string {
  if (entityType === 'goal') return data.goals.find(row => row.id === entityId)?.title ?? entityId;
  if (entityType === 'task') return data.tasks.find(row => row.id === entityId)?.title ?? entityId;
  if (entityType === 'resource') return data.resources.find(row => row.id === entityId)?.title ?? entityId;
  if (entityType === 'milestone') return data.milestones.find(row => row.id === entityId)?.title ?? entityId;
  if (entityType === 'deadline') return data.deadlines.find(row => row.id === entityId)?.title ?? entityId;
  if (entityType === 'meeting') return data.meetings.find(row => row.id === entityId)?.title ?? entityId;
  if (entityType === 'note') {
    const capture = data.notes.find(row => row.id === entityId);
    if (capture) return capture.title;
    const taskNote = data.taskNotes.find(row => row.id === entityId);
    if (taskNote) {
      const task = data.tasks.find(row => row.id === taskNote.task_id);
      return `Task note - ${task?.title ?? taskNote.created_at}`;
    }
    return entityId;
  }
  if (entityType === 'task_note') {
    const taskNote = data.taskNotes.find(row => row.id === entityId);
    const task = taskNote ? data.tasks.find(row => row.id === taskNote.task_id) : null;
    return taskNote ? `Task note - ${task?.title ?? taskNote.created_at}` : entityId;
  }
  if (entityType === 'journal_entry') return data.journals.find(row => row.id === entityId)?.entry_date ?? entityId;
  if (entityType === 'event') return data.events.find(row => row.id === entityId)?.title ?? entityId;
  if (entityType === 'resource_chunk') return data.resourceChunks.find(row => row.id === entityId)?.heading ?? entityId;
  return entityId;
}

function linkTo(paths: Map<string, string>, entityType: string, entityId: string, label: string): string {
  const rel = paths.get(entityKey(entityType, entityId));
  if (!rel) return label || entityId;
  const target = rel.replace(/\.md$/i, '');
  const cleanLabel = (label || path.basename(rel, '.md')).replace(/\|/g, '/');
  return `[[${target}|${cleanLabel}]]`;
}

function entityKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function tagFor(value: unknown): string {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9/_ -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function parseJsonArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function yearFrom(value: string | null | undefined): string {
  const match = String(value ?? '').match(/^(\d{4})/);
  return match?.[1] ?? 'Undated';
}

function dateFolders(value: string | null | undefined): { year: string; month: string } {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})/);
  return match ? { year: match[1], month: match[2] } : { year: 'Undated', month: 'Undated' };
}

function datePart(value: string | null | undefined): string {
  return String(value ?? '').slice(0, 10);
}

function yamlScalar(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value));
}

function addFile(files: Map<string, string>, relPath: string, content: string) {
  files.set(normalizeRelPath(relPath), content.replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n');
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

function safeJoin(root: string, relPath: string): string {
  const clean = normalizeRelPath(relPath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...clean.split('/'));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing to write outside vault: ${relPath}`);
  }
  return resolved;
}

async function readManifest(vaultDir: string): Promise<VaultManifest | null> {
  try {
    const raw = await fs.readFile(safeJoin(vaultDir, MANIFEST_PATH), 'utf8');
    const parsed = JSON.parse(raw) as VaultManifest;
    return Array.isArray(parsed.files) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeManifest(vaultDir: string, manifest: VaultManifest) {
  const abs = safeJoin(vaultDir, MANIFEST_PATH);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
