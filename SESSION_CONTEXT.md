# Marina OS — Full Session Context

> **Purpose:** Read this before starting any new session. It captures the stack, architecture, every decision made across two major sessions, and the exact state of the codebase so you can continue without re-deriving anything.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 19 + Vite 6 + TypeScript |
| Styling | Tailwind CSS v4 (`border-[#4648d4]`, `bg-[#EEF2FF]`) |
| State | Zustand 5 with persist middleware |
| DB | better-sqlite3 (synchronous), file = `marina.db` |
| Server | Express.js on port 3001 |
| Data fetching | @tanstack/react-query v5, `refetchInterval: 800ms` |
| Animation | Framer Motion (`AnimatePresence`, `motion.div`) |

**Critical constraint:** `marina.db` must NEVER be deleted, reset, or destructively modified. The user has sensitive real data in it.

---

## Project Layout

```
src/
  api/hooks.ts              — useInvalidate(), useGoalTasks(), POLL=800ms
  components/
    Header.tsx
    Sidebar.tsx
    NeedsImplementationBadge.tsx
  db/
    db.ts
    schema.ts               — DBTask, DBGoal, DBTaskNote, etc.
    queries/
      goals.ts
      tasks.ts              — createTask, toggleTask, updateTask
  modals/
    ClassificationPopup.tsx
    NewGoalModal.tsx
    NewGoalWizard.tsx
  store/useAppStore.ts
  utils/
    goalFinishEstimate.ts   — getGoalFinishEstimate()
    goalTaskMetrics.ts      — calculateGoalTaskMetrics(), getCountableGoalTasks()
    goalTimeAnalytics.ts    — computeGoalTimeStats()
    subtaskSuggestions.ts
    taskTime.ts             — getRolledUpTime(), getTaskTimeProgress(), formatTaskTime()
    useNow.ts               — singleton 30s interval via useSyncExternalStore
    __tests__/
      taskTime.test.ts      — 102 tests, all passing
  views/
    BrainDumpView.tsx
    GoalDetail.tsx          — main goal page with milestone/task tree
    GoalsDashboard.tsx
    ScheduleView.tsx
    SettingsView.tsx
    TaskFocusView.tsx       — deep-dive focus for a single task/section
server/
  db.ts
  routes/
    goals.ts                — syncGoalMetrics() called on every mutation
    tasks.ts                — GET /api/tasks?goal_id=, POST /:id/toggle
```

---

## Session 1 Summary (Previous — ran out of context)

### Features shipped

| Feature | Where |
|---|---|
| File attachment via paste (Ctrl+V) and drag-and-drop | `TaskFocusView` Section Journal |
| Live image previews for pending (not-yet-uploaded) images | `TaskFocusView` |
| Show images inline as thumbnails after journal submission | `TaskFocusView` |
| Real-time deadline countdown ("4h 23m left") | `GoalDetail` DeadlinePill |
| `datetime-local` input (timestamp support, not just date) | `GoalDetail` DeadlinePill |
| Additive overhead time model (Option A) | `taskTime.ts` getRolledUpTime |
| Remove "Progress / AUTO %" card from SectionPlanningWidgets | `TaskFocusView` |
| Remove progress widget from InlineTimePill | `GoalDetail` |
| Fix stale velocity/time stats after task toggle | `GoalDetail`, `TaskFocusView` |

### Key architectural decisions from Session 1

**Additive overhead model (user explicitly chose "Option A"):**
- Parent's explicit `estimated_minutes` = overhead at that level (planning, coordination, etc.)
- Total = own overhead + Σ children
- NOT a conflict or override — they add
- Removed `conflict` field from `RolledUpTime`; added `ownMinutes` and `childrenSum`

**`useNow` singleton:**
- `src/utils/useNow.ts` — one module-level `setInterval` at 30s
- All `DeadlinePill` components share it via `useSyncExternalStore`
- Prevents N separate re-renders firing at different offsets

**Cache invalidation pattern:**
```typescript
await toggleTask(id);
invalidate.tasks(goalId);   // force immediate re-fetch
```
Every toggle now awaits + invalidates. Previously fire-and-forget caused stale displays.

**`PendingImageThumb`:**
- Creates `URL.createObjectURL` in `useEffect`, returns cleanup `URL.revokeObjectURL`
- Prevents memory leaks from blob URLs

**`getTaskTimeProgress`** (new function in `taskTime.ts`):
```typescript
export interface TaskTimeProgress {
  ratio: number;           // 0–1, time-weighted when estimates exist
  remainingMinutes: number | null;
  spentMinutes: number;
  isTimeWeighted: boolean;
}
```
Uses leaf descendant estimates for accurate remaining (not derived from ratio × total).

---

## Session 2 — This Session

### The core bug investigated

**Symptom:** Goal ring showed wrong percentage ("8%" from stale cache, then various wrong values). Header showed "1/5 done" but the user said it was inaccurate.

**Root cause investigation:** Queried the actual DB data:

```
Tasks for ECG&EEG goal:
  critical_path  "Section Papers"    est: null   parent: ROOT       (ID: ...906c9c)
  manual         "Section 2"         est: 900m   parent: 906c9c     (ID: ...6f9b39)
  manual         "Section 3"         est: 720m   parent: 906c9c
  manual         "Section 5"         est: 720m   parent: 906c9c
  manual         "Section 8"         est: 600m   parent: 906c9c
  manual         "Sections(MISC)"    est: 2400m  parent: 906c9c
  manual         "Electrocardiogram" est: 120m   parent: 6f9b39     (child of Section 2)
  DONE manual    "Computational"     est: 20m    parent: Electrocard (child of Electrocardiogram)
```

**The real hierarchy (4 levels deep):**
```
Section Papers (milestone, no time)
  └── Section 2 (900m own overhead)
        └── Electrocardiogram (120m own overhead)
              └── Computational ✓ DONE (20m)
  └── Section 3 (720m, leaf)
  └── Section 5 (720m, leaf)
  └── Section 8 (600m, leaf)
  └── Sections(MISC) (2400m, leaf)
```

**Total time across all tasks: 5480m ≈ 91h 20m** (matches Time Intelligence panel exactly).

### What `getCountableGoalTasks` returns

```typescript
// parentIds = {Section Papers ID, Section 2 ID, Electrocardiogram ID}
// (built from every task's parent_task_id)
// Excluded from countable: Section Papers, Section 2, Electrocardiogram
// Included (leaves): Section 3, Section 5, Section 8, Sections(MISC), Computational
```

Countable = 5 leaf tasks. Only Computational is done. → "1/5 done".

### Reasoning chain and decisions tried

**Attempt 1 (previous session):** Equal-weight counting → Computational done = 1/5 = 20% ring. User: "20% is wrong for a 20m task out of 91h."

**Attempt 2 (previous session):** Time-weight by `estimated_minutes` on leaves only:
- Leaf times: Section 3 (720) + Section 5 (720) + Section 8 (600) + MISC (2400) + Computational (20) = 4460m
- Progress = 20/4460 = 0.36% → `Math.round` → **0%**
- Ring showed "8%" from stale HMR cache. Real computation would be 0%.
- User: still showing wrong values.

**Attempt 3 (this session, wrong direction):** Section-level tracking:
- Treat direct children of milestones as progress units
- Use `getTaskTimeProgress(section).ratio` for completion fraction
- Use `getRolledUpTime(section).minutes` for weight
- Section 2: all leaves done (Computational) → ratio = 1.0, weight = 1040m
- Progress = 1040/5480 = 19%, "1/5 done" (Section 2 counted as done)
- **User rejected this:** "1/5 IS FLAWED UNTIL IT ITSELF IS CHECKED"
- User's point: Section 2 checkbox is NOT checked. A task should only count as done when explicitly checked by the user. My ratio ≥ 1.0 logic was wrong.

**Final solution (this session):**

**Key insight:** In the additive overhead model, each task's `estimated_minutes` is its OWN work at that level (not a sum of children). So summing ALL non-milestone tasks' `estimated_minutes` gives the TRUE total WITHOUT double-counting:

```
Section 2 own: 900m (planning/coordination at Section 2 level)
Electrocardiogram own: 120m (work at Electrocardiogram level)  
Computational: 20m (the leaf task)
Total for this branch: 1040m (additive, no double-counting)
```

This means using all non-milestone `estimated_minutes` for the ring % is mathematically correct.

**For "X/Y done" count:** Keep using `getCountableGoalTasks` (leaf tasks) with `isDone` (explicit checkbox). This means:
- Section 2 is NEVER counted as done unless the user explicitly checks Section 2's checkbox
- "1/5 done" = Computational (explicitly done) out of 5 leaf tasks
- Section 2, Electrocardiogram are parents and not in the leaf count

**For the ring %:** Use ALL non-milestone timed tasks:
```typescript
const allTimed = tasks.filter(t => t.kind !== 'critical_path' && (t.estimated_minutes ?? 0) > 0);
const totalMinutes = allTimed.reduce((s, t) => s + t.estimated_minutes!, 0); // = 5480m
const doneMinutes = allTimed.filter(isDone).reduce((s, t) => s + t.estimated_minutes!, 0); // = 20m
// raw = 0.365% → show 1% minimum when any work is done
progress = doneMinutes > 0 && raw < 1 ? 1 : Math.round(raw);
```

**For SPENT in Time Intelligence:** Changed `computeGoalTimeStats` to use `estimated_minutes` as fallback when `actual_minutes` is null:
```typescript
const spentMinutes = completed.reduce(
  (s, t) => s + (t.actual_minutes ?? t.estimated_minutes ?? 0), 0
);
// Now shows "20m" instead of "—" after Computational is toggled done
```
Velocity still requires explicit `actual_minutes` logging (can't fake velocity = actual/estimated always = 1.0).

---

## Files Changed This Session

### `src/utils/goalTaskMetrics.ts`

**Final logic:**
```typescript
export function calculateGoalTaskMetrics(tasks: DBTask[], now = new Date()): GoalTaskMetrics {
  // X/Y done: leaf tasks only, explicitly checked
  const countableTasks = getCountableGoalTasks(tasks);
  const totalTasks = countableTasks.length;
  const completedTasks = countableTasks.filter(isDone).length;

  if (usesExplicitWeights) {
    // weight_percent path (unchanged)
  } else {
    // Ring %: ALL non-milestone tasks' own estimated_minutes (additive model = no double-count)
    const allTimed = tasks.filter(t => t.kind !== 'critical_path' && (t.estimated_minutes ?? 0) > 0);
    const totalMinutes = allTimed.reduce(...);
    const doneMinutes = allTimed.filter(isDone).reduce(...);
    // Show at least 1% when work done (avoids stuck-at-zero UX)
    progress = doneMinutes > 0 && raw < 1 ? 1 : Math.round(raw);
  }
}
```

**Key invariant:** `getCountableGoalTasks` returns leaf tasks only (tasks not referenced as `parent_task_id` by any other task). Section 2, Electrocardiogram are parents and are EXCLUDED. A section is NEVER counted as done unless its OWN checkbox is checked.

### `src/utils/goalTimeAnalytics.ts`

Changed `spentMinutes` to use `actual_minutes ?? estimated_minutes ?? 0` so SPENT shows time immediately on task toggle, even without explicit time logging. Velocity still needs real `actual_minutes`.

---

## Current Expected Behavior (ECG&EEG Goal)

| Metric | Value | Reasoning |
|---|---|---|
| Ring % | 1% | 20m done / 5480m total = 0.36% → min 1% |
| X/Y done | 1/5 | Computational (explicitly done) out of 5 leaf tasks |
| SPENT | 20m | Computational.estimated_minutes used as fallback |
| REMAINING | 91h | 5460m (all incomplete tasks with estimates) |
| VELOCITY | "complete tasks to see" | needs actual_minutes logged |

---

## Server-Side: `syncGoalMetrics`

`server/routes/goals.ts` calls `calculateGoalTaskMetrics` on every mutation to update `goal.progress` in DB. Uses the SAME client-side utility file (imported directly from `../../src/utils/goalTaskMetrics.js`). So both GoalDetail (live computed) and GoalsDashboard (computed from `tasksByGoal`) use the same logic.

Toggle endpoint (`POST /api/tasks/:id/toggle`) does NOT cascade completion to parents. A parent task is NEVER auto-completed when its children are done — the user must explicitly check it.

---

## Key Utility Reference

### `getCountableGoalTasks(tasks)` — `goalTaskMetrics.ts`
Returns only leaf tasks (tasks whose `id` is not any other task's `parent_task_id`). Parents are always excluded from the count. This prevents a section being "done" just because its children are done.

### `getRolledUpTime(task, allTasks)` — `taskTime.ts`
Additive overhead: `total = ownMinutes + childrenSum`. Parent's own time is overhead, NOT replaced by children.
```typescript
interface RolledUpTime {
  minutes: number | null;   // total including overhead
  isRollup: boolean;        // true when children contributed
  ownMinutes: number | null;
  childrenSum: number | null;
}
```

### `getTaskTimeProgress(task, allTasks)` — `taskTime.ts`
Time-weighted leaf progress for a task. Descends to leaf descendants, weights by `estimated_minutes`.
```typescript
interface TaskTimeProgress {
  ratio: number;              // 0–1
  remainingMinutes: number | null;
  spentMinutes: number;       // from actual_minutes on done leaves
  isTimeWeighted: boolean;
}
```

### `computeGoalTimeStats(tasks)` — `goalTimeAnalytics.ts`
All-tasks time intelligence. Uses `actual_minutes ?? estimated_minutes` for spent. Velocity only from tasks with both values.

### `useInvalidate()` — `api/hooks.ts`
```typescript
const invalidate = useInvalidate();
await toggleTask(id);
invalidate.tasks(goalId);   // always call after mutations
```

### `useNow()` — `utils/useNow.ts`
Module-level singleton `setInterval` at 30s. All DeadlinePills share one timer via `useSyncExternalStore`.

---

## Test Suite

`src/utils/__tests__/taskTime.test.ts` — **102 tests, all passing**

Covers: `parseTaskTimeInput`, `formatTaskTime`, `formatTaskTimeLong`, `normalizeTaskMinutes`, `getTaskEstimatedMinutes`, `getTaskLeafProgress`, `getRolledUpTime` (including additive overhead cases).

Run: `npx vitest run src/utils/__tests__/`

---

## Known Remaining Issues / Not Yet Done

1. **Velocity** requires explicit `actual_minutes` logging. The ActualTimeModal appears in TaskFocusView but may not trigger on deep subtask toggles in GoalDetail. If the user says velocity never updates, check whether the toggle flow calls ActualTimeModal for nested tasks.

2. **GoalsDashboard ring vs GoalDetail ring** — both now compute live from `calculateGoalTaskMetrics`. The `goal.progress` stored in DB is updated by `syncGoalMetrics` only on mutations, so it may lag slightly. The ring in GoalDetail always uses the live value.

3. **"1/5 done" label** — the denominator "5" happens to equal the number of visible top-level sections (Section 2, 3, 5, 8, MISC), but the actual meaning is "5 leaf tasks" not "5 sections". This can feel confusing when leaf tasks are buried deep. A tooltip or label clarification might help.

4. **Section Papers milestone has `estimated_minutes = null`** — its own time is not counted in totals. If the user ever sets a time on it, it would be included in `allTimed` and affect the ring %.

---

## Conversation Prompts (Verbatim User Messages This Session)

1. *(Session continuation from previous context)*

2. "no look only the subchildtask of 20m how is it 1/5 its inaccurate also what about spent and velcotuy its all worng"

3. "NO ITS NOT 1/5 THERE ARE 5 TASKS AND ONE OF THE 5 HAS ONE CHILD TASK THTA SI FINSHED ITS LIEK FROM TEH 1/5 ONE CHILD TASK WAS DONE EVEN IF OTEHR HILREN ATSKS WHER NOT DELCARED RHE LOGIC O DYAING 1/5 IS FLAWED UNTIL IT ITSEF IS CHECKE"

4. "EXPORT THIS WHOLE CONVERSATION WITH THE PORMPRS AND YOUR THINKING TO AN MD IN THE PROJECT STURETURESO ANOTHER CHAT SESSION CAN UNDERSTANF THE WHOE WOKRFLOW"

---

## My Reasoning Trail (Key Thinking Documented)

### Why "1/5 done" confused the user

The user has 5 visible sections under Section Papers: Section 2, 3, 5, 8, MISC. None of those 5 checkboxes are checked. Yet the system said "1/5 done."

- With **equal-weight leaf counting**: "5" = 5 leaf tasks (Section 3, 5, 8, MISC, Computational). Computational is done. This IS accurate, but the ring showed 20% (too high).
- With **section-level tracking** (my wrong attempt): "5" = 5 sections, "1" = Section 2 counted as done via `ratio >= 1.0`. User correctly rejected this: "it should only count when it ITSELF is checked."
- With **final fix**: "5" = 5 leaf tasks. "1" = Computational (explicitly checked). Section 2 is NOT a leaf and NOT counted.

### Why the ring was showing 20% originally

Old code: `getCountableGoalTasks` → 5 leaves → equal weights → 100/5=20% each → 1 done = 20%. The weight said nothing about time.

### Why naive time-weighting on leaves gives 0%

Leaf times: Section 3(720) + Section 5(720) + Section 8(600) + MISC(2400) + Computational(20) = 4460m.
Done: 20m. Progress = 20/4460 = 0.36% → 0%.

This is "correct" mathematically, but the total (4460m) is misleadingly low because Section 2's 900m overhead and Electrocardiogram's 120m are excluded (they're parents).

### Why using ALL tasks' `estimated_minutes` is correct (no double-counting)

In the additive overhead model:
- Section 2's 900m = its own work (overhead) at Section 2 level
- Electrocardiogram's 120m = its own work at Electrocardiogram level
- Computational's 20m = the actual task

These are SEPARATE amounts of work. They don't overlap. Summing them = 1040m = Section 2 branch total. This matches `getRolledUpTime(Section2)`. No double-counting.

Total across all tasks = 5480m ≈ 91h 20m = exactly what Time Intelligence shows.

### Why "minimum 1% when work done" is a UX choice, not math

`Math.round(0.365) = 0`. Showing 0% in the ring after completing a real task feels broken. Showing 1% (the smallest visible increment) is a reasonable UX concession. It communicates "some work has been done" without overstating.

### Why spent now uses `estimated_minutes` as fallback

`actual_minutes` is only set when the user explicitly logs time via the ActualTimeModal. Just toggling a task done leaves `actual_minutes = null`. Showing "— | 0 Logged" after completing a task feels like the system didn't register the work. Using `estimated_minutes` as a proxy shows "~20m" which at least confirms the system knows the task is done.

Velocity still needs real `actual_minutes` because velocity = actual/estimated. Using estimated as both numerator and denominator always gives 1.0 (meaningless).

---

## Update: Merged Goal Tasks and Critical Path UI

Date: 2026-06-25

### User Request

The user shared a screenshot of the goal detail page showing a separate top `Tasks` block and a separate `Critical Path` block below it. They said this did not make sense and wanted tasks and critical path merged. They also reiterated that UI changes should be visually inspected before and after.

### Files Changed

- `src/views/GoalDetail.tsx`

### Changes Made

1. Removed the standalone quick-add task section above the goal content.

2. Replaced the old separate manual `Tasks` section and separate `Critical Path` section with one unified `Tasks` section.

3. Added `rootWorkItems`, which combines root critical-path milestones and root manual tasks:
   - `critical_path` root tasks render as `MilestoneCard`.
   - `manual` root tasks render as `SortableTaskRow`.
   - Critical-path milestones are grouped first, then manual root tasks, with position/title sorting as fallback.

4. Removed the rendered `Critical Path` heading entirely. Browser verification found:
   - `taskHeadingCount: 1`
   - `criticalPathTextCount: 0`
   - rendered headings: `ECG&EEG`, `Tasks3/10`

5. Moved the root task quick-add widget into the right side of the `Tasks` header:
   - placeholder: `New root task`
   - compact text input
   - compact optional time input
   - icon-only plus button with title `Add root task`

6. Changed quick-add task positioning so a newly added root task is placed after the current unified root work list:
   - old behavior used `manualTasks.length`
   - new behavior computes `nextPosition` from `rootWorkItems`

7. Made manual root task rows more visually like siblings of critical-path cards:
   - `rounded-xl`
   - border
   - white background
   - padding
   - subtle shadow

8. Removed the now-unused `Target` icon import after deleting the separate Critical Path heading.

### Important Implementation Notes

- Drag sorting still uses `manualTasks.map(t => t.id)` inside `SortableContext`, so normal manual tasks remain sortable without turning critical-path milestones into sortable manual rows.
- The unified list still uses the existing `MilestoneCard` and `SortableTaskRow` components, so milestone behavior and manual task behavior remain mostly unchanged.
- The milestone jump bar remains inside the unified `Tasks` section when more than one milestone exists.
- Empty state now says: `No tasks yet. Add a root task to start shaping this goal.`

### Visual Verification

Before changing, the provided screenshot showed:

- top `Tasks` section with manual tasks
- separate `Critical Path` heading below
- `SECTION PAPERS` milestone card under that separate heading

After changing, I opened the app in the in-app browser at `http://127.0.0.1:3000/`, navigated to the `ECG&EEG` goal, and verified:

- one `Tasks` heading only
- no rendered `Critical Path` heading
- quick-add widget is tucked to the right of the `Tasks` heading
- `SECTION PAPERS` renders inside `Tasks`
- manual task `PowerPoints For Section Papers...` renders directly below the milestone card as a sibling in the same Tasks list

### Validation

Ran:

```powershell
npm run lint
```

Result:

```text
tsc --noEmit
```

No TypeScript errors.
