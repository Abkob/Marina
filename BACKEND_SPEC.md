# Marina OS — Backend Feature Spec

> Living document. Add a new section each time a backend feature is requested.  
> Every feature has: description, data contract, query/function signatures, and test cases.  
> **Legend:** ✅ Done | 🔜 Next | 💡 Planned | ⬜ Unstarted

---

## Status Dashboard

| # | Feature | Status | File(s) |
|---|---|---|---|
| BE-01 | Core DB Schema & Tables | ✅ | `db/schema.ts`, `db/db.ts` |
| BE-02 | Seed System (seedIfEmpty / resetAndSeed) | ✅ | `db/seed.ts` |
| BE-03 | Goals CRUD | ✅ | `db/queries/goals.ts` |
| BE-04 | Tasks CRUD + Subtask Hierarchy | ✅ | `db/queries/tasks.ts` |
| BE-05 | Notes CRUD + Suggested Action | ✅ | `db/queries/notes.ts` |
| BE-06 | Resources CRUD via Edge Traversal | ✅ | `db/queries/resources.ts` |
| BE-07 | Events CRUD + Reschedule + Fix My Week | ✅ | `db/queries/events.ts` |
| BE-08 | Daily Scores Upsert + History | ✅ | `db/queries/dailyScores.ts` |
| BE-09 | Graph Edge System (addEdge / BFS) | ✅ | `db/queries/edges.ts` |
| BE-10 | Graph Data Queries (full + ego-network) | ✅ | `db/queries/graph.ts` |
| BE-11 | Full-Text Search (cross-entity) | 🔜 | `db/queries/search.ts` |
| BE-12 | Analytics & Productivity Scoring | 🔜 | `db/queries/analytics.ts` |
| BE-13 | Recurring Tasks | 💡 | `db/queries/tasks.ts` |
| BE-14 | Due Date Tracker + Overdue Detection | 💡 | `db/queries/scheduler.ts` |
| BE-15 | Export (JSON / Markdown / CSV) | 💡 | `db/queries/export.ts` |
| BE-16 | Import + Restore | 💡 | `db/queries/import.ts` |
| BE-17 | Note Intelligence (Auto-link + Version History) | 💡 | `db/queries/notes.ts` |
| BE-18 | Tag System (create / apply / filter) | 💡 | `db/queries/tags.ts` |
| BE-19 | Goal Templates | 💡 | `db/queries/templates.ts` |
| BE-20 | Data Health + Orphan Cleanup | 💡 | `db/queries/health.ts` |
| BE-21 | Cloud Sync (Supabase) | ⬜ | `db/sync/` |
| BE-22 | AI Note Task Extraction | ⬜ | `db/ai/extract.ts` |
| BE-23 | AI OO Classification (real model) | ⬜ | `db/ai/classify.ts` |
| BE-24 | AI Smart Schedule Optimizer | ⬜ | `db/ai/schedule.ts` |
| BE-25 | AI Weekly Summary Generator | ⬜ | `db/ai/summary.ts` |

---

---

## BE-01 — Core DB Schema & Tables ✅

**10 tables in `MarinaDB extends Dexie`:**

| Table | Key fields | Purpose |
|---|---|---|
| `goals` | id, status, category, deadline, overdue, progress, activity_level | Strategic objectives |
| `tasks` | id, goal_id, parent_task_id, kind, status, priority, completed, position | All task variants |
| `task_notes` | id, task_id, content | Inline notes on individual tasks |
| `notes` | id, type, suggested_action_text, suggested_action_applied, extracted_tasks_json | Journal / brain dump entries |
| `resources` | id, type, title, url, info | Attached links and documents |
| `events` | id, type, day_index, start_hour, duration_hours, time_str, connected_resource_json | Calendar blocks |
| `daily_scores` | id, date (unique), score, tasks_completed, focus_minutes | One row per calendar day |
| `edges` | id, source_id, source_type, target_id, target_type, relationship, metadata | Graph relationships |
| `tags` | id, name (unique) | Global tag registry |
| `entity_tags` | id, entity_id, entity_type, tag_id | Many-to-many tag join |

**Tests**
- [x] T-BE01-01 All 10 tables open and accept typed writes
- [x] T-BE01-02 `db.daily_scores` unique constraint on `date` rejects duplicate dates
- [x] T-BE01-03 `db.edges` compound index `[source_id+target_id]` used for fast lookups
- [x] T-BE01-04 `db.tags` unique constraint on `name` rejects duplicate tag names
- [x] T-BE01-05 TypeScript types enforced on every table write (no runtime casts needed)

---

## BE-02 — Seed System ✅

**Functions:** `seedIfEmpty()`, `resetAndSeed()`, `runSeed()`

**`seedIfEmpty()`**
- Called in `main.tsx` before `createRoot()` — blocks render until complete
- Checks `db.goals.count() > 0` — no-ops if data already present
- Idempotent: safe to call on every app start

**`resetAndSeed()`**
- Clears all 10 tables in one transaction
- Re-runs `runSeed()` — used by Factory Refactor button and Reset Defaults

**Seeded entities:**
- 4 goals with distinct categories and statuses
- Per goal: 2 critical_path tasks, N ai_generated tasks, 1 next_action task
- 8 calendar events (Mon–Fri spread, different types)
- 3 notes with extracted_tasks_json and suggested_action_text populated
- Resources linked to goals via `attached_to` edges
- Edge records for every goal→task, event→goal, resource→goal relationship

**Tests**
- [x] T-BE02-01 `seedIfEmpty()` on empty DB → `db.goals.count()` = 4
- [x] T-BE02-02 `seedIfEmpty()` on populated DB → count unchanged (no-op)
- [x] T-BE02-03 `resetAndSeed()` wipes custom data → `db.goals.count()` = 4 again
- [x] T-BE02-04 After seed: `db.edges.count()` ≥ 30
- [x] T-BE02-05 After seed: every goal has at least 1 `kind='next_action'` task
- [x] T-BE02-06 Concurrent `seedIfEmpty()` calls do not cause duplicate rows

---

## BE-03 — Goals CRUD ✅

**File:** `src/db/queries/goals.ts`

| Function | Signature | Description |
|---|---|---|
| `getGoals` | `() → Promise<DBGoal[]>` | All goals |
| `getGoalById` | `(id) → Promise<DBGoal \| undefined>` | Single goal |
| `createGoal` | `(data: Omit<DBGoal, 'id'\|'created_at'>) → Promise<string>` | Insert + return id |
| `updateGoal` | `(id, Partial<DBGoal>) → Promise<void>` | Partial update |
| `updateGoalProgress` | `(id, progress: number) → Promise<void>` | Progress-only update |
| `deleteGoal` | `(id) → Promise<void>` | Cascade: tasks + edges |

**Cascade on deleteGoal:**
1. `db.tasks.where('goal_id').equals(id).delete()`
2. For each deleted task: `removeAllEdgesForNode(task.id)`
3. Fetch resources attached to goal via edges → `db.resources.bulkDelete(ids)`
4. `removeAllEdgesForNode(goal.id)`

**Tests**
- [x] T-BE03-01 `createGoal()` returns UUID string; retrievable by id
- [x] T-BE03-02 `updateGoal(id, { status: 'Risky' })` — only status changed
- [x] T-BE03-03 `updateGoalProgress(id, 80)` — only progress changed
- [x] T-BE03-04 `deleteGoal(id)` — goal record removed
- [x] T-BE03-05 `deleteGoal(id)` — all tasks with `goal_id=id` removed
- [x] T-BE03-06 `deleteGoal(id)` — all edges sourced from or targeting goal id removed
- [x] T-BE03-07 `deleteGoal(id)` — resources exclusively attached to this goal removed

---

## BE-04 — Tasks CRUD + Subtask Hierarchy ✅

**File:** `src/db/queries/tasks.ts`

| Function | Signature | Description |
|---|---|---|
| `getTasksByGoal` | `(goalId) → Promise<DBTask[]>` | All tasks under a goal |
| `getTasksByGoalAndKind` | `(goalId, kind) → Promise<DBTask[]>` | Filtered by kind |
| `getSubtasks` | `(parentTaskId) → Promise<DBTask[]>` | Direct children only |
| `getTaskById` | `(id) → Promise<DBTask \| undefined>` | Single task |
| `getTaskNotesForTask` | `(taskId) → Promise<DBTaskNote[]>` | Inline notes |
| `createTask` | `(data) → Promise<string>` | Insert + auto goal→task edge |
| `createSubtask` | `(parentId, data) → Promise<string>` | Inherits goal_id; creates subtask_of edge |
| `toggleTask` | `(id) → Promise<{ completed: boolean }>` | Flip completed |
| `updateTask` | `(id, Partial<DBTask>) → Promise<void>` | Partial update |
| `deleteTask` | `(id) → Promise<void>` | Recursive subtask deletion |
| `addTaskNote` | `(taskId, content) → Promise<string>` | Inline note |
| `deleteTaskNote` | `(noteId) → Promise<void>` | Remove note |
| `recalcGoalProgress` | `(goalId, baseline, kind) → Promise<number>` | Recompute progress |

**`recalcGoalProgress` formula:**
```
completedCount = tasks.filter(t => t.kind===kind && t.completed).length
totalCount     = tasks.filter(t => t.kind===kind).length
pctPerTask     = (100 - baseline) / totalCount
newProgress    = baseline + completedCount × pctPerTask
```

**Tests**
- [x] T-BE04-01 `createTask()` auto-creates `contains` edge (goal → task)
- [x] T-BE04-02 `createSubtask(parentId, data)` sets `parent_task_id = parentId`
- [x] T-BE04-03 `createSubtask()` creates `subtask_of` edge (child → parent)
- [x] T-BE04-04 `toggleTask(id)` on incomplete → `completed=true`
- [x] T-BE04-05 `toggleTask(id)` on complete → `completed=false`
- [x] T-BE04-06 `deleteTask(id)` with children: deletes subtasks recursively first
- [x] T-BE04-07 `recalcGoalProgress('goal-1', 75, 'ai_generated')` with 1/2 done = 87.5
- [x] T-BE04-08 `addTaskNote` → `getTaskNotesForTask` returns exactly 1 note
- [x] T-BE04-09 `getSubtasks(parentId)` returns only direct children (depth=1)
- [x] T-BE04-10 `getTasksByGoalAndKind('goal-1', 'critical_path')` returns only critical_path rows

---

## BE-05 — Notes CRUD + Suggested Action ✅

**File:** `src/db/queries/notes.ts`

| Function | Signature | Description |
|---|---|---|
| `getNotes` | `(type?) → Promise<DBNote[]>` | All notes, ordered DESC |
| `getNoteById` | `(id) → Promise<DBNote \| undefined>` | Single note |
| `createNote` | `(data) → Promise<string>` | Insert |
| `updateNoteContent` | `(id, content) → Promise<void>` | Content-only update |
| `updateNote` | `(id, Partial<DBNote>) → Promise<void>` | General update |
| `deleteNote` | `(id) → Promise<void>` | Delete + edges |
| `applyNoteSuggestedAction` | `(noteId, goalId) → Promise<void>` | Sets applied=true + mentioned_in edge |
| `ignoreNoteSuggestedAction` | `(noteId) → Promise<void>` | Sets ignored=true |
| `linkNoteToGoal` | `(noteId, goalId, confidence) → Promise<void>` | OO classification edge |
| `recordNoteTaskExtraction` | `(noteId, taskId) → Promise<void>` | extracted_to edge |

**Tests**
- [x] T-BE05-01 `createNote()` + `getNoteById()` round-trip matches
- [x] T-BE05-02 `updateNoteContent()` changes only content field
- [x] T-BE05-03 `deleteNote()` removes edges where `source_id = noteId`
- [x] T-BE05-04 `applyNoteSuggestedAction()` sets `suggested_action_applied = true`
- [x] T-BE05-05 `applyNoteSuggestedAction()` creates `mentioned_in` edge (note → goal)
- [x] T-BE05-06 `ignoreNoteSuggestedAction()` sets `suggested_action_ignored = true`
- [x] T-BE05-07 `linkNoteToGoal(nid, gid, 92)` stores `{ confidence: 92 }` in edge metadata
- [x] T-BE05-08 Calling `linkNoteToGoal` twice on same pair does not duplicate the edge

---

## BE-06 — Resources CRUD via Edge Traversal ✅

**File:** `src/db/queries/resources.ts`

| Function | Signature | Description |
|---|---|---|
| `getResourcesForGoal` | `(goalId) → Promise<DBResource[]>` | Traverses edges (attached_to) |
| `getAllResources` | `() → Promise<DBResource[]>` | Flat list |
| `createResource` | `(data, goalId) → Promise<string>` | Insert + attached_to edge |
| `deleteResource` | `(id) → Promise<void>` | Delete + edges |
| `detectResourceType` | `(input: string) → ResourceType` | 'figma' / 'link' / 'document' |

**Tests**
- [x] T-BE06-01 `createResource(data, goalId)` creates `attached_to` edge (resource → goal)
- [x] T-BE06-02 `getResourcesForGoal(goalId)` returns only resources attached to that goal
- [x] T-BE06-03 `getResourcesForGoal` returns `[]` for goal with no attachments
- [x] T-BE06-04 `deleteResource(id)` removes the `attached_to` edge
- [x] T-BE06-05 `detectResourceType('https://figma.com/file/x')` → `'figma'`
- [x] T-BE06-06 `detectResourceType('https://github.com/repo')` → `'link'`
- [x] T-BE06-07 `detectResourceType('spec.pdf')` → `'document'`

---

## BE-07 — Events CRUD + Reschedule + Fix My Week ✅

**File:** `src/db/queries/events.ts`

| Function | Signature | Description |
|---|---|---|
| `getEvents` | `() → Promise<DBEvent[]>` | All events |
| `getEventById` | `(id) → Promise<DBEvent \| undefined>` | Single event |
| `createEvent` | `(data, goalId?, taskId?) → Promise<string>` | Insert + optional schedules edge |
| `rescheduleEvent` | `(id, newStartHour) → Promise<void>` | Updates start_hour + time_str |
| `deleteEvent` | `(id) → Promise<void>` | Delete + edges |
| `fixMyWeek` | `() → Promise<void>` | Hardcoded rebalance of evt-3 and evt-6 |

**Tests**
- [x] T-BE07-01 `createEvent(data, 'goal-1')` creates `schedules` edge (event → goal)
- [x] T-BE07-02 `createEvent(data)` with no goalId creates no edge
- [x] T-BE07-03 `rescheduleEvent('evt-1', 13)` sets `start_hour = 13`
- [x] T-BE07-04 `rescheduleEvent` updates `time_str` to match new hour
- [x] T-BE07-05 `fixMyWeek()` sets `evt-3.start_hour = 11.5`
- [x] T-BE07-06 `fixMyWeek()` sets `evt-6.start_hour = 14.0`
- [x] T-BE07-07 `deleteEvent(id)` removes the event and its `schedules` edge

---

## BE-08 — Daily Scores ✅

**File:** `src/db/queries/dailyScores.ts`

| Function | Signature | Description |
|---|---|---|
| `getTodayScore` | `() → Promise<DBDailyScore \| undefined>` | Today's row by ISO date |
| `upsertDailyScore` | `(data) → Promise<string>` | Insert or update |
| `getScoreHistory` | `(days?: number) → Promise<DBDailyScore[]>` | Last N days DESC |
| `recordTasksCompleted` | `(count: number) → Promise<void>` | Increment today's task count |

**Tests**
- [x] T-BE08-01 `upsertDailyScore` for new date → creates row
- [x] T-BE08-02 `upsertDailyScore` for existing date → updates, no duplicate
- [x] T-BE08-03 `getTodayScore()` returns row matching today's ISO date
- [x] T-BE08-04 `getScoreHistory(7)` returns ≤ 7 records
- [x] T-BE08-05 `recordTasksCompleted(3)` increments `tasks_completed += 3` on today

---

## BE-09 — Graph Edge System ✅

**File:** `src/db/queries/edges.ts`

**Edge relationships in use:**

| Relationship | Direction | Created by |
|---|---|---|
| `contains` | goal → task | `createTask`, `createGoal` |
| `subtask_of` | task → task | `createSubtask` |
| `mentioned_in` | note → goal | `linkNoteToGoal`, `applyNoteSuggestedAction` |
| `extracted_to` | note → task | `recordNoteTaskExtraction` |
| `attached_to` | resource → goal | `createResource` |
| `schedules` | event → goal / task | `createEvent` |
| `linked_to` | note → note | future note linking |
| `references` | task → resource | future task-resource link |

**Tests**
- [x] T-BE09-01 `addEdge()` inserts and returns UUID
- [x] T-BE09-02 `removeEdge(sid, tid)` deletes only that pair
- [x] T-BE09-03 `removeAllEdgesForNode(id)` deletes all edges where node is source OR target
- [x] T-BE09-04 `getOutgoingEdges('goal-1')` returns only edges with `source_id='goal-1'`
- [x] T-BE09-05 `getNeighborIds` returns both incoming and outgoing directions
- [x] T-BE09-06 Compound index `[source_id+target_id]` prevents duplicate edge pair

---

## BE-10 — Graph Data Queries ✅

**File:** `src/db/queries/graph.ts`

**`getFullGraphData() → Promise<GraphData>`**
- Fetches all entities from goals, tasks, notes, resources, events tables
- Maps each to a `GraphNode` with `{ id, type, label, data }`
- Fetches all edges → maps to `GraphEdge` with `{ id, source, target, relationship }`
- Returns `{ nodes: GraphNode[]; edges: GraphEdge[] }`

**`getNodeNeighborhood(nodeId, nodeType, depth=1) → Promise<GraphData>`**
- BFS starting from `nodeId`, up to `depth` hops via `getNeighborIds()`
- Collects visited node IDs, resolves full records by type
- Returns sub-graph with only the ego-network

**Tests**
- [x] T-BE10-01 `getFullGraphData()` node count = total entity count across 5 tables
- [x] T-BE10-02 `getFullGraphData()` edge count = `db.edges.count()`
- [x] T-BE10-03 `getNodeNeighborhood('goal-1', 'goal', 1)` includes goal + its direct tasks + resources
- [x] T-BE10-04 `getNodeNeighborhood('goal-1', 'goal', 2)` includes subtasks of goal's tasks
- [x] T-BE10-05 BFS never revisits same node id (no infinite loop on cycles)
- [x] T-BE10-06 `GraphNode.label` set to entity's `title` field

---

---

## BE-11 — Full-Text Search ⬜ → 🔜

**File:** `src/db/queries/search.ts`

**Problem:** Dexie doesn't have native full-text search. Strategy: fetch all records, run client-side filter using a scored match function. Fast enough for personal-scale IndexedDB (< 10k records).

**`searchAll(query: string, types?: NodeType[]) → Promise<SearchResult[]>`**

```typescript
interface SearchResult {
  id:         string;
  type:       NodeType;        // 'goal' | 'task' | 'note' | 'resource' | 'event'
  label:      string;          // entity title
  excerpt:    string;          // matched snippet with query highlighted
  score:      number;          // 0–100 relevance
  created_at: string;
}
```

**Scoring rules:**
| Match location | Score boost |
|---|---|
| Title exact match | +60 |
| Title contains query | +40 |
| Content/description contains query | +20 |
| Tags contain query | +15 |
| Category matches | +10 |

**`searchGoals(query) → Promise<DBGoal[]>`**  
**`searchTasks(query) → Promise<DBTask[]>`**  
**`searchNotes(query) → Promise<DBNote[]>`**

**Tests**
- [ ] T-BE11-01 `searchAll('design')` returns goals/tasks/notes containing "design" (case-insensitive)
- [ ] T-BE11-02 `searchAll('design', ['goal'])` returns only goals
- [ ] T-BE11-03 Title match scores higher than content match
- [ ] T-BE11-04 Empty query returns `[]`
- [ ] T-BE11-05 `searchAll` result includes `excerpt` string with matched portion
- [ ] T-BE11-06 Results sorted by score DESC
- [ ] T-BE11-07 `searchNotes('OO')` does not match mid-word occurrences like "cool" (word-boundary filter)

---

## BE-12 — Analytics & Productivity Scoring ⬜ → 🔜

**File:** `src/db/queries/analytics.ts`

**Purpose:** Compute productivity metrics from existing DB data. No new tables needed — derives from `tasks`, `daily_scores`, `events`, `goals`.

**Functions:**

**`getTaskCompletionRate(days?: number) → Promise<{ rate: number; total: number; completed: number }>`**
- Looks at tasks with `due_date` in the last N days
- Returns percentage completed on time

**`getGoalVelocity(goalId) → Promise<{ pointsPerWeek: number; estimatedDone: string }>`**
- Progress gained per week (progress delta / weeks active)
- Projects completion date based on current velocity

**`getStreakData() → Promise<{ currentStreak: number; longestStreak: number; lastActive: string }>`**
- Reads `daily_scores.tasks_completed > 0` per day
- Counts consecutive active days

**`getFocusTimeThisWeek() → Promise<number>`**
- Sums `duration_hours` for all `type='Focus'` events this week
- Returns hours as number

**`getWeeklySnapshot() → Promise<WeeklySnapshot>`**
```typescript
interface WeeklySnapshot {
  goalsActive:     number;
  tasksCompleted:  number;
  focusHours:      number;
  notesCreated:    number;
  topGoal:         { id: string; title: string; progress: number };
  overdueTasks:    DBTask[];
}
```

**`getDailyScoreForDate(date: string) → Promise<number>`**
- Composite score: tasks_completed × 10 + focus_minutes / 6 (capped at 100)

**Tests**
- [ ] T-BE12-01 `getTaskCompletionRate(7)` with 3/5 tasks done → `{ rate: 60, total: 5, completed: 3 }`
- [ ] T-BE12-02 `getGoalVelocity(goalId)` returns positive `pointsPerWeek` for active goal
- [ ] T-BE12-03 `getStreakData()` with 3 consecutive active days → `currentStreak = 3`
- [ ] T-BE12-04 `getStreakData()` with gap yesterday → `currentStreak = 0` (or 1 if today has entries)
- [ ] T-BE12-05 `getFocusTimeThisWeek()` sums only Focus-type event durations
- [ ] T-BE12-06 `getWeeklySnapshot()` returns all 6 fields with correct types
- [ ] T-BE12-07 `getDailyScoreForDate` returns value between 0–100

---

## BE-13 — Recurring Tasks 💡

**File:** `src/db/queries/tasks.ts` (extension)

**New fields on `DBTask`:**

```typescript
recurrence:         'none' | 'daily' | 'weekly' | 'monthly' | null;
recurrence_day:     number | null;   // 0-6 for weekly, 1-28 for monthly
next_occurrence:    string | null;   // ISO date
```

**`spawnRecurringTasks() → Promise<number>`**
- Called on app open after `seedIfEmpty()`
- Finds all tasks where `recurrence != 'none'` and `next_occurrence <= today`
- Clones each task as a new incomplete task with updated `next_occurrence`
- Returns count of tasks spawned

**`setTaskRecurrence(taskId, recurrence, day?) → Promise<void>`**
- Updates task recurrence fields
- Computes first `next_occurrence`

**Tests**
- [ ] T-BE13-01 Task with `recurrence='daily'` and `next_occurrence=yesterday` → `spawnRecurringTasks` creates 1 new task
- [ ] T-BE13-02 Spawned task has same title/goal but fresh `completed=false`
- [ ] T-BE13-03 `next_occurrence` on spawned task = original next_occurrence + 1 day
- [ ] T-BE13-04 Task with `recurrence='none'` → never spawned
- [ ] T-BE13-05 `spawnRecurringTasks` called twice on same day → no duplicate spawn (checks existing incomplete tasks with same title+goal+due_date)

---

## BE-14 — Due Date Tracker + Overdue Detection 💡

**File:** `src/db/queries/scheduler.ts`

**`getOverdueTasks() → Promise<DBTask[]>`**
- Returns tasks where `due_date < today` and `completed = false`

**`getTasksDueToday() → Promise<DBTask[]>`**
- Returns tasks where `due_date = today` and `completed = false`

**`getTasksDueThisWeek() → Promise<DBTask[]>`**
- Returns tasks where `due_date` is within the next 7 days

**`markGoalsOverdue() → Promise<void>`**
- For each goal: if `deadline < today` and `progress < 100` → `updateGoal(id, { overdue: true })`
- Called on app open after seed

**`getUpcomingDeadlines(days = 14) → Promise<{ entity: 'goal'|'task'; id: string; title: string; due: string; daysLeft: number }[]>`**
- Combines overdue goals + tasks due soon into unified sorted list

**Tests**
- [ ] T-BE14-01 `getOverdueTasks()` returns only tasks where `due_date < today && !completed`
- [ ] T-BE14-02 `getTasksDueToday()` returns only tasks due today
- [ ] T-BE14-03 `markGoalsOverdue()` sets `overdue=true` for goal with past deadline + progress < 100
- [ ] T-BE14-04 `markGoalsOverdue()` does NOT mark completed goal (progress=100) as overdue
- [ ] T-BE14-05 `getUpcomingDeadlines(7)` includes both goals and tasks sorted by soonest first
- [ ] T-BE14-06 `daysLeft` is negative for overdue items

---

## BE-15 — Export (JSON / Markdown / CSV) 💡

**File:** `src/db/queries/export.ts`

**`exportAllAsJSON() → Promise<string>`**
- Dumps all 10 tables as a single JSON string
- Format: `{ exportedAt, version, goals[], tasks[], notes[], resources[], events[], daily_scores[], edges[] }`

**`exportGoalAsMarkdown(goalId) → Promise<string>`**
- Exports one goal with its tasks, resources as a Markdown document
- Critical path as `## Critical Path` with `- [ ]` / `- [x]` checkboxes
- AI tasks as `## AI Tasks`
- Resources as `## Resources` with links

**`exportNotesAsMarkdown(noteIds?: string[]) → Promise<string>`**
- Each note becomes a Markdown section: `## Title\n\n_Date_\n\nContent`
- If noteIds omitted, exports all notes

**`exportTasksAsCSV(goalId?) → Promise<string>`**
- Columns: title, kind, status, completed, priority, due_date, goal_title
- Optionally filtered by goalId

**`downloadFile(content, filename, mime) → void`**
- Creates Blob + Object URL → triggers browser download

**Tests**
- [ ] T-BE15-01 `exportAllAsJSON()` output parses as valid JSON
- [ ] T-BE15-02 Exported JSON contains all 4 seeded goals
- [ ] T-BE15-03 `exportGoalAsMarkdown(goalId)` contains `# Goal Title` header
- [ ] T-BE15-04 Completed critical path step exported as `- [x]`
- [ ] T-BE15-05 `exportTasksAsCSV()` first row contains correct headers
- [ ] T-BE15-06 CSV has one data row per task
- [ ] T-BE15-07 `exportNotesAsMarkdown()` with no args exports all notes

---

## BE-16 — Import + Restore 💡

**File:** `src/db/queries/import.ts`

**`importFromJSON(json: string) → Promise<ImportResult>`**
```typescript
interface ImportResult {
  imported: { goals: number; tasks: number; notes: number; resources: number; events: number };
  skipped:  number;   // duplicate ids
  errors:   string[]; // parse/validation failures
}
```
- Validates JSON structure before writing
- Uses `db.transaction('rw', ...)` for atomic import
- Skips records whose `id` already exists (non-destructive merge)

**`importFromJSONOverwrite(json: string) → Promise<ImportResult>`**
- Like `importFromJSON` but calls `resetAndSeed()` first (full replace)

**`validateImportJSON(json: string) → { valid: boolean; errors: string[] }`**
- Pre-flight check: verifies required fields per entity type
- Does not write anything

**Tests**
- [ ] T-BE16-01 `validateImportJSON(malformed)` → `{ valid: false, errors: [...] }`
- [ ] T-BE16-02 `importFromJSON(validJson)` → all entities appear in DB
- [ ] T-BE16-03 Importing record with existing id → skipped (count in `result.skipped`)
- [ ] T-BE16-04 `importFromJSONOverwrite` → DB cleared then fully re-populated from JSON
- [ ] T-BE16-05 Import is atomic: if one record fails validation, none are written
- [ ] T-BE16-06 Round-trip: `exportAllAsJSON()` → `importFromJSONOverwrite()` → DB identical

---

## BE-17 — Note Intelligence 💡

**File:** `src/db/queries/notes.ts` (extension)

**Auto-link notes to goals:**
`autoClassifyNote(noteId) → Promise<{ goalId: string; confidence: number }[]>`
- Runs word-overlap scoring against all goals (same as OO popup logic)
- If top match confidence > 70, automatically creates `mentioned_in` edge
- Returns top 3 matches regardless

**Note version history:**

New table: `note_versions`

```typescript
interface DBNoteVersion {
  id:         string;
  note_id:    string;
  content:    string;
  saved_at:   string;  // ISO datetime
}
```

`saveNoteVersion(noteId) → Promise<void>`
- Called when user leaves the note or after 60s of inactivity
- Stores snapshot of current content

`getNoteVersions(noteId) → Promise<DBNoteVersion[]>`
- Returns history ordered by `saved_at DESC`

`restoreNoteVersion(noteId, versionId) → Promise<void>`
- Sets `note.content = version.content`

**Bi-directional linking:**

`linkNotesToEachOther(noteId1, noteId2) → Promise<void>`
- Creates `linked_to` edge both ways (A→B and B→A)

`getNoteBacklinks(noteId) → Promise<DBNote[]>`
- Returns all notes that link TO this note via `linked_to` edges

**Tests**
- [ ] T-BE17-01 `autoClassifyNote(noteId)` returns array of `{ goalId, confidence }` sorted by confidence DESC
- [ ] T-BE17-02 Top confidence > 70 → `mentioned_in` edge created automatically
- [ ] T-BE17-03 `saveNoteVersion(noteId)` inserts row in `note_versions`
- [ ] T-BE17-04 `getNoteVersions(noteId)` returns versions in reverse chronological order
- [ ] T-BE17-05 `restoreNoteVersion(noteId, vid)` sets note content to that version's content
- [ ] T-BE17-06 `linkNotesToEachOther(a, b)` creates 2 edges (a→b and b→a)
- [ ] T-BE17-07 `getNoteBacklinks(b)` returns note A after linking

---

## BE-18 — Tag System 💡

**File:** `src/db/queries/tags.ts`

**Tables:** `tags` (name unique) + `entity_tags` (many-to-many join)

**Functions:**

| Function | Signature | Description |
|---|---|---|
| `createTag` | `(name) → Promise<string>` | Insert tag, return id |
| `getOrCreateTag` | `(name) → Promise<string>` | Idempotent — returns existing or creates |
| `getAllTags` | `() → Promise<DBTag[]>` | Tag registry |
| `applyTag` | `(entityId, entityType, tagName) → Promise<void>` | getOrCreate + entity_tag row |
| `removeTag` | `(entityId, entityType, tagName) → Promise<void>` | Delete entity_tag row |
| `getTagsForEntity` | `(entityId, entityType) → Promise<DBTag[]>` | Tags on one entity |
| `getEntitiesByTag` | `(tagName, type?) → Promise<string[]>` | All entity ids with this tag |
| `getTagCloud` | `() → Promise<{ name: string; count: number }[]>` | Usage frequency sorted |

**`tags_json` field on tasks** remains for fast display without join. `applyTag` also updates `tags_json`.

**Tests**
- [ ] T-BE18-01 `createTag('productivity')` → retrievable by name
- [ ] T-BE18-02 `getOrCreateTag('productivity')` called twice → same id, no duplicate row
- [ ] T-BE18-03 `applyTag(taskId, 'task', 'urgent')` → entity_tag row created
- [ ] T-BE18-04 `applyTag` also updates `task.tags_json` to include 'urgent'
- [ ] T-BE18-05 `getTagsForEntity(taskId, 'task')` returns tags for that task
- [ ] T-BE18-06 `getEntitiesByTag('urgent', 'task')` returns all task ids tagged urgent
- [ ] T-BE18-07 `removeTag(taskId, 'task', 'urgent')` removes entity_tag row
- [ ] T-BE18-08 `getTagCloud()` returns tags sorted by `count DESC`

---

## BE-19 — Goal Templates 💡

**File:** `src/db/queries/templates.ts`

**Template structure:**
```typescript
interface GoalTemplate {
  id:          string;
  name:        string;           // "30-Day Language Sprint"
  category:    string;
  description: string;
  criticalPath: { title: string; description: string; status: CriticalPathStatus }[];
  aiTasks:      { title: string; estimated_duration: string }[];
  resources:    { title: string; type: ResourceType; url: string | null }[];
}
```

**`BUILT_IN_TEMPLATES: GoalTemplate[]`** — static array in module (no DB table needed)

**`applyTemplate(templateId, overrides?) → Promise<string>`**
- Creates a goal + all tasks + resources from the template
- `overrides` can set title, deadline, category
- Returns new goalId

**Built-in templates:**
- "30-Day Language Sprint" (Languages)
- "Ship a Side Project" (Product Development)
- "12-Week Fitness Block" (Health & Fitness)
- "Infrastructure Migration" (DevOps & Storage)

**Tests**
- [ ] T-BE19-01 `BUILT_IN_TEMPLATES.length` ≥ 4
- [ ] T-BE19-02 `applyTemplate('language-sprint')` → goal + criticalPath tasks in DB
- [ ] T-BE19-03 Applied template goal has `progress = 10` (same as new goal default)
- [ ] T-BE19-04 `applyTemplate` with `overrides.title = 'My Arabic Goal'` → goal title is 'My Arabic Goal'
- [ ] T-BE19-05 Each template task has a `contains` edge back to the new goal

---

## BE-20 — Data Health + Orphan Cleanup 💡

**File:** `src/db/queries/health.ts`

**`runHealthCheck() → Promise<HealthReport>`**
```typescript
interface HealthReport {
  orphanedTasks:     DBTask[];     // tasks whose goal_id references a deleted goal
  orphanedResources: DBResource[]; // resources with no attached_to edge
  missingEdges:      { entity: string; id: string; issue: string }[];  // tasks with no contains edge
  duplicateEdges:    DBEdge[][];   // pairs with the same source+target+relationship
  notesMissingDate:  DBNote[];     // notes with null/empty date_str
}
```

**`repairOrphans() → Promise<number>`**
- Deletes orphaned tasks (goal no longer exists)
- Deletes orphaned resources (no edge)
- Removes duplicate edges (keeps first by created_at)
- Returns count of records repaired

**`getDBStats() → Promise<DBStats>`**
```typescript
interface DBStats {
  goals:       number;
  tasks:       number;
  notes:       number;
  resources:   number;
  events:      number;
  edges:       number;
  tags:        number;
  daily_scores:number;
  sizeEstimate: string;  // rough estimate like "~420 KB"
}
```

**Tests**
- [ ] T-BE20-01 After deleting a goal without cascade, `runHealthCheck()` surfaces orphaned tasks
- [ ] T-BE20-02 `repairOrphans()` deletes those orphaned tasks
- [ ] T-BE20-03 `runHealthCheck()` on clean seeded DB returns all empty arrays
- [ ] T-BE20-04 `getDBStats()` returns correct counts matching individual table queries
- [ ] T-BE20-05 `repairOrphans()` returns 0 on a healthy DB

---

## BE-21 — Cloud Sync (Supabase) ⬜

**File:** `src/db/sync/supabase.ts`

**Strategy:** Mirror structure of IndexedDB tables in Supabase. Local-first: all writes go to Dexie first, then sync queue pushes to Supabase.

**`syncToCloud() → Promise<SyncResult>`**
- Reads `sync_queue` (new local table) for pending changes
- Batches upserts to Supabase per table
- On success: clears queue entries

**`pullFromCloud() → Promise<SyncResult>`**
- Fetches rows updated since last `last_synced_at` timestamp
- Merges into local Dexie (LWW — last write wins by `updated_at`)

**Conflict strategy:** Last-writer-wins on `updated_at`. No merge/diff logic.

**Tests**
- [ ] T-BE21-01 Creating a goal locally adds it to `sync_queue`
- [ ] T-BE21-02 `syncToCloud()` clears queue entries after successful Supabase upsert
- [ ] T-BE21-03 `pullFromCloud()` with newer remote version overwrites local record
- [ ] T-BE21-04 `pullFromCloud()` with older remote version does not overwrite newer local
- [ ] T-BE21-05 Offline writes accumulate in queue; sync on reconnect sends all

---

## BE-22 — AI Note Task Extraction ⬜

**File:** `src/db/ai/extract.ts`

**`extractTasksFromNote(noteId) → Promise<ExtractedTask[]>`**
- Sends note content to `claude-haiku-4-5`
- Prompt: "Extract actionable tasks from the following note. Return JSON array: [{task: string, due: string|null}]"
- Writes result to `note.extracted_tasks_json`
- Creates `extracted_to` edges for tasks that match existing DB tasks by title similarity

**`extractTasksFromAllNotes() → Promise<void>`**
- Batch process all notes where `extracted_tasks_json = '[]'`

**Tests**
- [ ] T-BE22-01 `extractTasksFromNote` with actionable content returns non-empty array
- [ ] T-BE22-02 Result written to `note.extracted_tasks_json`
- [ ] T-BE22-03 Extracted task with title matching existing DB task → `extracted_to` edge created
- [ ] T-BE22-04 Called on note with no actions → `[]` (does not hallucinate)
- [ ] T-BE22-05 API error → graceful fallback, `extracted_tasks_json` unchanged

---

## BE-23 — AI OO Classification (Real Model) ⬜

**File:** `src/db/ai/classify.ts`

**Replaces** the current `scoreGoal()` word-overlap function in `ClassificationPopup.tsx`

**`classifyNoteToGoals(contextText, goalIds) → Promise<{ goalId: string; confidence: number; reasoning: string }[]>`**
- Sends context + goal titles/descriptions to `claude-haiku-4-5`
- Returns ranked matches with reasoning
- Falls back to word-overlap if API unavailable

**Tests**
- [ ] T-BE23-01 Returns confidence scores sorted DESC
- [ ] T-BE23-02 Returns reasoning string for top match
- [ ] T-BE23-03 API unavailable → falls back to word-overlap scorer
- [ ] T-BE23-04 Empty context → returns empty array

---

## BE-24 — AI Smart Schedule Optimizer ⬜

**File:** `src/db/ai/schedule.ts`

**Replaces** `fixMyWeek()` hardcode

**`optimizeWeek(events, goals) → Promise<OptimizedEvent[]>`**
- Sends current week events + overdue/urgent tasks to model
- Returns reordered/reschedule suggestions
- Writes changes back to `db.events` if user confirms

**`suggestTimeBlock(task) → Promise<{ day_index: number; start_hour: number; duration: number }>`**
- Given a task, suggest the best open slot in the current week
- Avoids conflicts with existing events

**Tests**
- [ ] T-BE24-01 `suggestTimeBlock` returns slot not conflicting with existing events
- [ ] T-BE24-02 `optimizeWeek` returns same number of events (no deletions)
- [ ] T-BE24-03 API unavailable → falls back to original `fixMyWeek` hardcode

---

## BE-25 — AI Weekly Summary Generator ⬜

**File:** `src/db/ai/summary.ts`

**`generateWeeklySummary() → Promise<WeeklySummary>`**
```typescript
interface WeeklySummary {
  narrative:         string;    // 2-3 sentence prose summary
  topWin:            string;    // biggest accomplishment
  biggestBlocker:    string;    // most overdue / incomplete thing
  nextWeekFocus:     string[];  // 3 suggested priorities
  generatedAt:       string;
}
```
- Pulls `getWeeklySnapshot()` data
- Sends to model with structured prompt
- Saves result to a new `weekly_summaries` table (or as a `DBNote` of type `'reflection'`)

**Tests**
- [ ] T-BE25-01 `generateWeeklySummary()` returns all 5 fields populated
- [ ] T-BE25-02 `nextWeekFocus` array has exactly 3 items
- [ ] T-BE25-03 Summary saved as `DBNote` with `type='reflection'` and today's date
- [ ] T-BE25-04 API unavailable → graceful error, no partial write

---

---

## How to Add a New Feature

1. Add a row to the **Status Dashboard** table with next BE number and `⬜` status
2. Create a new `## BE-XX — Feature Name ⬜` section following the format:
   - **Problem / purpose** (1 sentence)
   - **Function signatures** (table)
   - **Data contract** (TypeScript interface if new shape)
   - **Tests** (T-BE-XX-NN format, all starting as `[ ]`)
3. Implement the feature in the relevant `src/db/queries/*.ts` file
4. Change status to `✅` in the dashboard when all tests pass
5. Update the checklist items from `[ ]` to `[x]`
