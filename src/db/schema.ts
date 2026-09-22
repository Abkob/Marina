// ─── Node types for the graph view ─────────────────────────────────────────
export type NodeType =
  | 'goal'
  | 'task'
  | 'note'
  | 'resource'
  | 'event'
  | 'daily_score';

export type EdgeRelationship =
  | 'contains'       // goal → task
  | 'subtask_of'     // task → parent task
  | 'mentioned_in'   // note mentions goal / task
  | 'extracted_to'   // note's parsed task → task record
  | 'attached_to'    // resource → goal or task
  | 'schedules'      // event → task or goal
  | 'references'     // note → note, or note → resource
  | 'linked_to'      // generic bidirectional
  | 'blocks';        // prerequisite task -> dependent task

// ─── Goals ──────────────────────────────────────────────────────────────────
export type PlanStatus = 'not_started' | 'planned' | 'in_progress' | 'paused' | 'blocked' | 'completed';

export interface DBGoal {
  id: string;
  title: string;
  description: string;
  category: string;
  status: 'Safe' | 'Watch' | 'Risky';
  progress: number;                    // 0–100
  deadline: string | null;             // LEGACY (may hold vague strings) — use target_date
  overdue: boolean;
  activity_level: number;              // 1–5
  archived_at: string | null;          // null = visible, ISO date = archived
  created_at: string;
  updated_at: string;
  // M-021 real date planning
  start_date?: string | null;          // when work may begin
  target_date?: string | null;         // when the user would like to finish
  hard_deadline?: string | null;       // when it MUST be done
  deadline_type?: 'soft' | 'hard' | 'estimated' | null;
  deadline_confidence?: 'low' | 'medium' | 'high' | null;
  scheduling_enabled?: boolean;        // may Amina place this on the calendar
  estimated_minutes?: number | null;
  plan_status?: PlanStatus;
}

// ─── Tasks (with subtask hierarchy) ─────────────────────────────────────────
// 'todo' is the legacy synonym of 'not_started'.
export type TaskStatus = 'todo' | 'not_started' | 'planned' | 'in_progress' | 'paused' | 'inactive' | 'done' | 'blocked';
export type TaskPriority = 'low' | 'medium' | 'high';
export type TaskKind = 'next_action' | 'critical_path' | 'ai_generated' | 'manual';
export type CriticalPathStatus = 'Completed' | 'In Progress' | 'Future';
export type TaskTimeRollupMode = 'additive' | 'inclusive';

export interface DBTask {
  id: string;
  goal_id: string | null;              // null = standalone task
  parent_task_id: string | null;       // null = top-level task
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  kind: TaskKind;
  critical_path_status: CriticalPathStatus | null; // only for kind='critical_path'
  tags_json: string;                   // JSON: string[]
  due_date: string | null;             // ISO date ("YYYY-MM-DD") or datetime ("YYYY-MM-DDTHH:MM")
  estimated_duration: string | null;   // e.g. "Est. 2 hrs"
  estimated_minutes?: number | null;   // normalized time needed for scheduling
  time_rollup_mode?: TaskTimeRollupMode; // additive = extra in parent, inclusive = inside parent estimate
  actual_minutes?: number | null;      // logged after task is completed
  weight_percent?: number | null;      // optional explicit progress weight, 0-100
  feel_score?: number | null;          // subjective sense of how much this task needs attention, 0-100
  completed: boolean;
  position: number;                    // ordering within sibling tasks
  last_activity_at?: string | null;
  completion_note?: string;
  start_date?: string | null;
  deadline_id?: string | null;
  milestone_id?: string | null;
  created_at: string;
  updated_at: string;
  // M-021 real date planning
  target_date?: string | null;
  hard_deadline?: string | null;
  deadline_type?: 'soft' | 'hard' | 'estimated' | null;
  deadline_confidence?: 'low' | 'medium' | 'high' | null;
  scheduling_enabled?: boolean;
  flexibility?: 'flexible' | 'fixed' | 'urgent' | null;
  can_split?: boolean;
  min_session_minutes?: number | null;
}

// ─── Goal Deadlines ──────────────────────────────────────────────────────────
export interface DBDeadline {
  id: string;
  goal_id: string;
  title: string;
  date: string;
  color: string;
  created_at: string;
}

// ─── Meetings ────────────────────────────────────────────────────────────────
export interface DBMeeting {
  id: string;
  goal_id: string | null;
  milestone_id: string | null;
  title: string;
  scheduled_at: string;         // "YYYY-MM-DDTHH:MM"
  duration_minutes: number;
  location: string;
  notes: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Goal Milestones ─────────────────────────────────────────────────────────
export interface DBMilestone {
  id: string;
  goal_id: string;
  title: string;
  description: string;
  due_date: string | null;
  color: string;
  position: number;
  completed: boolean;
  created_at: string;
  updated_at: string;
}

// ─── User Schedule Preferences (single row, id = 'default') ──────────────────
export interface DBSchedulePrefs {
  id: string;
  work_days: string;              // JSON: number[] e.g. [1,2,3,4,5] (Mon=1..Sun=7)
  work_start: number;             // e.g. 9.0 = 9:00am
  work_end: number;               // e.g. 18.0 = 6:00pm
  daily_capacity_minutes: number; // e.g. 480 = 8 hours
  deep_work_start: number;        // e.g. 9.0
  deep_work_end: number;          // e.g. 12.0
  buffer_ratio: number;           // e.g. 0.15 = 15% time buffers
  timezone: string;               // IANA timezone e.g. 'Asia/Beirut'
  updated_at: string;
}

// ─── Event ↔ Task Links ───────────────────────────────────────────────────────
export interface DBEventTaskLink {
  id: string;
  event_id: string;
  task_id: string;
  planned_minutes: number | null;
  created_at: string;
}

// ─── Work Sessions ────────────────────────────────────────────────────────────
export interface DBWorkSession {
  id: string;
  task_id: string | null;
  routine_id?: string | null;          // routine focus is logged separately from one-off task estimates
  resource_id: string | null;
  goal_id: string | null;
  started_at: string;
  ended_at: string | null;
  minutes: number | null;
  notes: string;
  source: 'manual' | 'timer' | 'auto' | 'completion' | 'journal' | 'legacy';
  created_at: string;
}

// ─── Notes on tasks (inline comments / thread) ───────────────────────────────
export interface DBTaskNote {
  id: string;
  task_id: string;
  content: string;
  created_at: string;
}

// ─── Files attached to task-note journal entries ──────────────────────────────
export interface DBTaskNoteFile {
  id: string;
  note_id: string;
  name: string;
  mime_type: string;
  size: number;
  blob: Blob;        // kept for type compatibility; null in API mode, use file_url instead
  file_url?: string; // URL to stream the file from the server
  created_at: string;
}

// ─── Notes / Journals / Capture ──────────────────────────────────────────────
export type NoteType = 'journal' | 'capture' | 'session' | 'task_note';

export interface DBNote {
  id: string;
  title: string;
  content: string;
  type: NoteType;
  date_str: string;                    // human-readable "Today, Oct 24 • 09:41 AM"
  suggested_action_text: string | null;
  suggested_action_applied: boolean;
  suggested_action_ignored: boolean;
  // Embedded JSON arrays (seeded; will migrate to edge-based queries in graph view)
  extracted_tasks_json: string;        // JSON: { text: string; due: string }[]
  relevant_docs_json: string;          // JSON: { title: string; edited: string }[]
  created_at: string;
  updated_at: string;
}

// ─── Resources ───────────────────────────────────────────────────────────────
export type ResourceType      = 'figma' | 'document' | 'link' | 'paper' | 'person' | 'dataset' | 'concept' | 'other';
export type ResourceReadState = 'Unread' | 'Reading' | 'Done' | 'Shelved';

export interface DBResource {
  id: string;
  title: string;
  url: string | null;
  type: ResourceType;
  info: string;
  description: string | null;
  read_state: ResourceReadState;
  next_action: string;
  tags_json: string;           // JSON: string[]
  estimated_minutes: number | null;
  actual_minutes: number | null;
  file_path: string | null;
  external_id: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface DBResourceMention {
  id: string;          // edge id
  resource_id: string;
  source_id: string;
  source_type: string; // 'note' | 'task' | 'braindump' | 'goal'
  created_at: string;
}

export interface ResourceLog {
  id: string;
  resource_id: string;
  content: string;
  is_insight: number;  // 0 = progress note, 1 = key insight
  created_at: string;
}

export interface ResourceStats {
  total_minutes: number;
  reference_count: number;
  goals_count: number;
  last_engaged: string | null;
}

// ─── Calendar Events ─────────────────────────────────────────────────────────
export type EventType = 'Focus' | 'Buffer' | 'Review' | 'Admin';

export interface DBEvent {
  id: string;
  title: string;
  type: EventType;
  day_index: number;                   // 0=Mon … 6=Sun
  start_hour: number;                  // e.g. 10.5 = 10:30
  duration_hours: number;
  time_str: string;
  description: string;
  week_start: string | null;           // ISO date of Monday of the week
  connected_resource_json: string | null; // JSON: { title: string; source: string }
  locked: boolean;
  source: string;                      // 'manual' | 'ai' | 'import' etc.
  created_at: string;
  updated_at: string;
}

// ─── Daily Scores ─────────────────────────────────────────────────────────────
export interface DBDailyScore {
  id: string;
  date: string;                        // ISO date YYYY-MM-DD — unique per day
  score: number;                       // 0–100 overall composite
  mood: number;                        // 1–5
  energy: number;                      // 1–5
  focus: number;                       // 1–5
  tasks_completed: number;
  notes: string;
  created_at: string;
}

// ─── Graph Edges ──────────────────────────────────────────────────────────────
export interface DBEdge {
  id: string;
  source_id: string;
  source_type: NodeType;
  target_id: string;
  target_type: NodeType;
  relationship: EdgeRelationship;
  metadata: string | null;             // JSON string (confidence %, context, etc.)
  created_at: string;
}

// ─── Tags ─────────────────────────────────────────────────────────────────────
export interface DBTag {
  id: string;
  name: string;
  color: string;
}

export interface DBEntityTag {
  id: string;
  entity_id: string;
  entity_type: NodeType;
  tag_id: string;
}

// ─── Graph snapshot (for rendering) ──────────────────────────────────────────
export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  meta: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relationship: EdgeRelationship;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ─── Journal system ──────────────────────────────────────────────────────────
export type IngestionStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'needs_review';

export interface DBJournalEntry {
  id: string;
  entry_date: string;              // YYYY-MM-DD
  raw_text: string;
  summary: string | null;
  mood: string | null;             // positive|neutral|negative|stressed|energized|tired
  energy_level: number | null;     // 1–10
  tags_json: string;               // JSON: string[] — MANUAL tags, never overwritten by AI
  ai_tags_json?: string;           // JSON: string[] — AI-extracted tags (M-017), kept separate
  ingestion_status: IngestionStatus;
  ingestion_attempts: number;
  ingestion_error: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface DBJournalLink {
  id: string;
  journal_entry_id: string;
  target_type: string;             // goal|task|resource|milestone|note
  target_id: string;
  relationship: string;            // progress_update|discusses|created_task|mentions|contributes_to|risk_update|decision|blocker
  confidence: number;              // 0–1
  created_by: string;              // ai|manual
  created_at: string;
}

export interface DBExtractedFact {
  id: string;
  source_type: string;             // journal_entry|meeting|resource|work_session
  source_id: string;
  fact_type: string;               // progress|risk|blocker|decision|deadline|task_candidate|meeting_candidate
  fact_text: string;
  target_type: string | null;
  target_id: string | null;
  confidence: number;
  status: string;                  // active|confirmed|rejected|stale
  created_at: string;
  updated_at: string;
}

export interface DBEntityAlias {
  id: string;
  entity_type: string;
  entity_id: string;
  alias: string;
  created_by: string;
  created_at: string;
}

// ─── Vector memory ───────────────────────────────────────────────────────────
export interface DBEmbedding {
  id: string;
  entity_type: string;
  entity_id: string;
  chunk_id: string | null;
  embedding_scope: string;         // title|summary|full_text|chunk|planning_summary
  embedding_text: string;
  embedding_model: string;
  content_hash: string;
  is_stale: boolean;
  created_at: string;
  updated_at: string;
}

export interface DBEmbeddingJob {
  id: string;
  entity_type: string;
  entity_id: string;
  chunk_id: string | null;
  action: string;                  // upsert|delete|refresh
  priority: number;
  status: string;                  // pending|processing|done|failed
  attempts: number;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface DBEntitySummary {
  id: string;
  entity_type: string;
  entity_id: string;
  summary_type: string;            // planning|semantic|graph|journal_digest
  summary_text: string;
  source_hash: string | null;
  created_at: string;
  updated_at: string;
}

// ─── AI proposals ─────────────────────────────────────────────────────────────
export interface DBAIActionProposal {
  id: string;
  source_type: string | null;
  source_id: string | null;
  action_type: string;
  action_payload: string;          // JSON (column was renamed from 'payload' via M-001)
  confidence: number;
  status: string;                  // pending|applied|rejected
  explanation: string | null;
  created_at: string;
  applied_at: string | null;
  idempotency_key: string | null;
}

// ─── Resource chunks ─────────────────────────────────────────────────────────
export interface DBResourceChunk {
  id: string;
  resource_id: string;
  chunk_index: number;
  heading: string | null;
  content: string;
  page_start: number | null;
  page_end: number | null;
  token_count: number | null;
  content_hash: string | null;
  created_at: string;
}

// ─── Schedule day overrides ───────────────────────────────────────────────────
export interface DBScheduleDayOverride {
  id: string;
  date: string;                    // YYYY-MM-DD
  available_minutes: number | null;
  unavailable_blocks: string;      // JSON: {start: number, end: number}[]
  note: string | null;
  created_at: string;
}

// ─── Parsed embedded JSON helpers ────────────────────────────────────────────
export type ExtractedTask = { text: string; due: string };
export type RelevantDoc   = { title: string; edited: string };
export type ConnectedResource = { title: string; source: string };

export function parseExtractedTasks(json: string): ExtractedTask[] {
  try { return JSON.parse(json); } catch { return []; }
}
export function parseRelevantDocs(json: string): RelevantDoc[] {
  try { return JSON.parse(json); } catch { return []; }
}
export function parseConnectedResource(json: string | null): ConnectedResource | null {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}
export function parseTags(json: string): string[] {
  try { return JSON.parse(json); } catch { return []; }
}
