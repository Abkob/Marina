# Marina OS — To-Do Checklist

> Process: Break feature into sub-tasks with unit tests FIRST. Suggest workflow options. User picks. Then code.

---

## Done ✅

- [x] **Fix white-screen on load**
- [x] **Hardcoded week dates in ScheduleView** — fully dynamic
- [x] **Hardcoded `goal-1` target in BrainDumpView** — queries first active goal
- [x] **Atomic goal navigation after creation** — `navigateToGoal(goalId)` single Zustand action
- [x] **Section Journal — document / PDF attachment per journal entry**
  - [x] `task_note_files` table + server route `/api/task-note-files`
  - [x] `addNoteFile`, `getNoteFilesForNote`, `deleteNoteFile`
  - [x] `NoteArticle` — hover-revealed Attach button, multi-file upload, pending-file chips in new-entry form
  - [x] `NoteFileChip` — filename, size, View button for PDF/images, hover-delete
  - [x] `FileViewerModal` — streams via `file_url`, no broken blob approach
- [x] **Time rollup: sub-subtask hours bubble up**
  - [x] `getRolledUpTime()` — Σ prefix, ⚠ conflict badge
  - [x] Unit tests: `taskTime.test.ts` (50 tests), `goalTaskMetrics.test.ts` (19 tests)
- [x] **Deadline + dynamic time estimates throughout task tree**
  - [x] `DeadlinePill` — editable, proximity badges
  - [x] `InlineTimePill` — remaining/total, Done ✓ at 100%
- [x] **SQLite migration** — Dexie → better-sqlite3 + Express
- [x] **Dynamic goal health status** — `computeGoalStatus()` from deadlines + hours
- [x] **Actual time logging when completing a task**
  - [x] `actual_minutes` column, ALTER TABLE migration
  - [x] `ActualTimeModal` — Log Time / Skip on completion
  - [x] Actual time chip (green/amber vs estimate) in TaskFocusView + GoalDetail rows
- [x] **Goal Time Intelligence panel** — Spent / Remaining / Velocity / Est. Total + progress bar
- [x] **Quick-add task at goal level** — always-visible input, creates `kind:'manual'`
- [x] **Manual tasks section in GoalDetail** — previously orphaned tasks now rendered
- [x] **Rename Marina → Marina**

---

## Done (this session) ✅

### A — Actual time editing (click chip to edit) ✅
- [x] `ActualTimeChip` component — click chip → inline input, Enter/blur saves, Escape cancels
- [x] Replaced static chip in `TaskFocusView` header
- [x] Replaced static chip in `GoalDetail` `TaskTreeRow` + `MilestoneCard`

### B — Velocity-adjusted finish date ✅
- [x] `projectedFinishDate(stats, dailyHours=4)` in `goalTimeAnalytics.ts`
- [x] `formatProjectedDate(date)` — smart label: Today / Tomorrow / weekday / MMM D
- [x] "At your pace: done by {date}" row in `GoalTimePanel`
- [x] Projected date on `GoalsDashboard` `GoalCard` (only when confidence ≠ 'none')

### C — Quick-add with Tab-expanded time estimate ✅
- [x] Tab in title input → animated time field slides in (Framer Motion)
- [x] Shift+Tab → back to title; Escape → clears + hides time field
- [x] Submit sends `estimated_minutes` parsed from the time field
- [x] Hint text "Press Tab to add a time estimate" when field is hidden

### D — Week navigation in ScheduleView ✅
- [x] `getWeekRange(offset)` replaces `getWeekInfo()` — offset-aware, correct today highlight
- [x] `weekOffset` state; prev/next buttons; "Today" button resets offset
- [x] Time indicator (red line) only renders when `weekOffset === 0`

### E — Task drag-and-drop reordering ✅
- [x] `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` installed
- [x] `reorderPositions(ids, activeId, overId)` utility — only returns changed positions
- [x] `SortableTaskRow` wrapper — `GripVertical` handle, hover-revealed, touch-none
- [x] `DndContext + SortableContext` wrapping manual tasks list in `GoalDetail`
- [x] `handleManualTaskDragEnd` — batch `PATCH /api/tasks/:id` for changed positions

---

## Backlog 📋

### AI Scheduler (feeds from A–E data)
- [ ] `scheduleTasks(goals, tasks, dailyHours)` — deadline-pressure sort, velocity-adjusted durations, fit into day blocks
  - [ ] Unit: 3 tasks, 2 deadlines → correct priority order
  - [ ] Unit: task exceeding daily hours → spans multiple days
  - [ ] Unit: overdue task → appears on first available slot
- [ ] Hook into Gemini API for natural language scheduling suggestions
- [ ] ScheduleView wired to AI output instead of hardcoded events
- [ ] Reschedule toast when actual time deviates >20% from estimate

### Brain Dump / Capture
- [ ] Real AI subtask suggestions via Gemini API (heuristic fallback stays)
  - [ ] Unit: heuristic path independent of API
- [ ] Brain Dump NLP — extract real tasks from note text (regex action-verb + due-date detection)
  - [ ] Unit: "Finish the report by Friday" → `{ text: "Finish the report", due: "Friday" }`
- [ ] OO Classification Popup — finish classification → goal/task/event/resource action

### Resources & Graph
- [ ] Graph view — react-flow or D3; nodes = goals/tasks/notes/resources; edges = relationship type
  - [ ] Unit: edge builder from tasks array → correct source/target pairs

### Settings & Scoring
- [ ] "Available hours per day" in Settings → used by B projection + AI Scheduler
- [ ] Daily Score UI — end-of-day score entry, heatmap on dashboard
- [ ] Copilot Metadata & Diagnose Engine — real output from Gemini

### Quality
- [ ] Unit tests: `goalTimeAnalytics.ts` — velocity, spent, adjusted remaining, null cases
- [ ] Unit tests: `ActualTimeChip` (will be written as part of A above)
- [ ] Integration: create goal → add 3 tasks with estimates → complete 2 with actuals → verify velocity

---

## How to add a new item

1. Add `- [ ]` under **Backlog**
2. Tell me what you want — I'll break it down here with unit tests, suggest workflow options, then wait for you to pick before coding
