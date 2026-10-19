# Marina — complete editor handoff

Prepared **19 October 2026**, timezone **Asia/Beirut**. This is a source, requirements, release, and operational handoff. It does not contain credentials or export the user's private application data. Historical verification below is dated evidence; inspect the current tree and deployment before acting.

## 1. Paste this into the next editor

> Work on Marina in `C:\Users\Salam\Documents\ChatGPT\marina\implementation`. Read `AGENTS.md`, `docs/EDITOR-HANDOFF.md`, and the linked checklists before modifying anything. The production cloud application is authoritative. Preserve all existing data and unrelated work, especially the dirty original checkout at `C:\Users\Salam\Music\Amina`. First inspect Git status, branches, remote main and current release evidence. Do not reset or clean either checkout. The Home Screen task launcher, two Lock Screen widget configurations, native hold/swipe picker, and independent calendar attendance/work switching already exist; verify and extend them rather than rebuilding them. Prioritize remaining physical-iPhone acceptance and any user-reported defects. The broader time-metric redesign and reopened Copilot P03.2 repairs are separate unfinished workstreams. Follow their existing checkpoints, fixing one bounded section at a time. Reuse stable task identities, shared accounting, guarded timer commands and durable retries. Before any production schema/data change, create and verify a fresh private cloud backup and local recovery restore. Use the user's own configured authentication without printing or copying secrets. Complete appropriate checks, commit only this task's files with the configured human identity, and push main without force. Report source push, web deployment, native IPA verification and physical-device verification separately. Continue autonomously within the user's requested scope; this handoff does not authorize unrelated destructive actions or spending money.

The current request is to prepare this handoff. It is **not** an instruction to implement every unchecked item immediately. The next editor should follow the user's next chosen slice, using the priorities below when asked to continue.

## 2. Locations, versions and access

| Item | Location / verified baseline |
| --- | --- |
| Working checkout | `C:\Users\Salam\Documents\ChatGPT\marina\implementation` |
| Current local branch | `codex/proposed-actual-schedule` |
| Application baseline before this document | `5f8fe8e8531587fc6fe5118d531b0a20f2c5197d` |
| GitHub | [Abkob/Marina](https://github.com/Abkob/Marina), remote `origin`, public repository |
| Delivery branch | Remote `main`; local branch is pushed with `git push origin HEAD:main` after checking remote movement |
| Production | [marina-demol1sin.vercel.app](https://marina-demol1sin.vercel.app) |
| Last verified runtime deployment | Backend/web `5f8fe8e`; [Vercel success](https://vercel.com/demol1sin/marina/GZDzmXTxdAgKhNWYS2JgatBZiSjD) |
| Latest verified native source | `993366e2389b6f9d0dfe7d583ddafdd8dfcb835b`; native source unchanged through `5f8fe8e` |
| Older original checkout | `C:\Users\Salam\Music\Amina` — unrelated unfinished changes; preserve |
| Local research / chat maps | `C:\Users\Salam\Documents\ChatGPT\marina\study` — outside repository, not available in a fresh clone |
| User identity configured here | Abdulrahman Kobeissi, `ask47@mail.aub.edu`; verify `git config` before committing |

### Authorization and credentials

- Existing project instructions authorize completing requested fixes, committing task changes and pushing main. Preserve the user's author/committer identity; no bot co-author or fabricated history.
- Git push through Windows Git Credential Manager and GitHub workflow read/dispatch/artifact download have worked on this laptop. This does **not** establish repository-admin or organization-owner privileges. `gh` was installed but not authenticated at the last check; a failed `gh auth status` does not mean Git push lacks credentials.
- Another editor on this laptop can use the user's existing configured login where its own sandbox permits. A document cannot transfer authentication, bypass tool approval, or grant new permissions. A different machine needs the user's own GitHub and Vercel authentication and authorized environment setup. Do not send tokens to another editor/chat or embed them in prompts.
- Local production configuration is in ignored `.vercel/.env.schedule-production.local`; `.vercel/project.json` is also local. Never print the whole environment, copy it into the handoff, commit it, or use it as test-fixture data. Some redacted placeholders are not usable credentials.
- Git credentials, Vercel login, the application's cookie session, scoped widget credentials, Google OAuth and provider credentials are different access layers. Do not replace one with another or weaken the application gate to get a test working.
- No authorization here for force pushes, deleting repositories/data, discarding unrelated work, paid Apple enrollment, new external data transfers, or sending messages to people. Existing approval for NVIDIA content transfer was specific to that earlier workstream, not blanket approval for additional providers.
- Do not commit secrets, backups, restored databases, uploaded originals, local chat transcripts, private diagnostics or generated IPAs. The repository is public.

## 3. Product intent and chat history

Marina, previously named Amina, is a personal time-management workspace: hierarchical goals/tasks, calendar, routines, focus tracking, notes/journals, document resources, retrieval and a conversational planning copilot. The Music/Amina folder name is historical; do not create a separate application because of the rename.

The user asked for a deep study of earlier chats, laptop code, GitHub and Vercel before changes. The external `study` directory records that investigation. It inventories the whole codebase but does not claim every runtime branch was executed. Earlier dates, source SHAs and cloud counts inside those files are historical.

The user's durable requirements, in sequence:

1. Understand all timing metrics together: contribution, uploads, study sessions, estimates, remaining work, velocity, Feel, commitments, progress, finish forecasts and lateness. Uploads should both identify study work needed and provide evidence of submitted/completed outcomes.
2. Keep previous-evening **Proposed** schedule separate from current accepted schedule and actual execution. Editing today's plan must not rewrite yesterday's intention.
3. Make explicit start/end check-ins extremely fast. If an event passed without confirmation, leave its actual end unknown until corrected later. Never infer attendance from a planned event alone.
4. Handle overlapping calendar events and overlapping representations of work without counting the same personal minutes twice.
5. Give iPhone users clean, native widgets and the full app, with no paid developer enrollment required for this delivery. A PWA or Shortcuts page alone cannot install WidgetKit extensions.
6. Provide a chosen **Tasks for today** work queue, including eligible child tasks/CP branches with parent context. One tap from Home Screen starts the selected task; a small × stops work without completing it.
7. Provide a separate **Schedule now** attendance widget. Switching work tasks must leave calendar attendance open.
8. Hold, slide vertically through daily tasks, release to start/switch; sideways cancellation. Put this rich interaction in an app-owned native sheet; do not promise an arbitrary custom wheel inside a system widget or unexpanded notification.
9. Research competitors and maintain a build/test checklist, test before repeated AltStore installation, preserve bundle IDs and avoid unnecessary App ID consumption.
10. Preserve cloud data. The user explicitly asked whether anything was erased; source deployment is never proof of a database backup.

“T4TX” was an uncertain user label; the user said they do not know its meaning. Do not invent a metric or assume a validated formula. Trace actual time-to-finish and UI labels in code.

Earlier chat requirements also remain relevant: unfinished stickies carry forward; section journals are separate dated task notes with multiple entries/day; tasks and critical-path cards share a visual section but retain distinct domain concepts; children schedule independently; undated parents remain undated while showing descendant cutoffs; missed work remains visible for recovery; routines must remain easy to find. Historical keyword routers were superseded by model-led conversation. Calendar data must stay independently available when changing chat.

### Interface preferences

Clean restrained controls, discreet secondary icons, compact mobile layouts and minimal labels. Keep usable touch targets, accessible names, keyboard focus and touch access without hover. “Nearly hidden Finish” must not turn into inaccessible functionality. Preserve drafts and avoid refreshes that discard forms.

## 4. What exists now

### Web and backend

- Proposed/current/actual schedule review and later time correction exist. The check-in card is non-blocking.
- Scoped schedule connection keys, optional explicit focus-control capability, revocation, durable command protocol, selected daily tasks and derived calendar membership exist.
- There is one canonical focus timer. Native/widget start/switch/stop use guarded atomic commands rather than a second stopwatch.
- New web/native event starts use independent attendance. Event End preserves focused work; focused work switches preserve attendance.
- Switching/stopping a running older combined event timer lazily saves its focus segment and keeps its attendance open. Migrations do not bulk-invent historical ends.
- Reconciliation credits confirmed attendance only over uncovered clock intervals. Running focus provisionally owns its observed span; reduced credited work minutes stay reduced.
- `/api/work-timer` includes an attendance revision signal so other clients refresh contribution/task/goal/schedule totals even when the focus timer ID is unchanged.

### Native iPhone app

- Persistent full-app `WKWebView`, native check-in and day-work sheets, shared extension storage, notification content extension and scoped pairing exist.
- Home Screen small/medium task widgets: suggested task, up to three task choices, paging, direct start, elapsed clock and stop.
- Two rectangular Lock Screen configurations in the existing widget extension: **Tasks for today** and **Schedule now**.
- Native UIKit hold/swipe/release task picker: 0.3-second hold, 48-point vertical increments, horizontal movement beyond 90 points cancels. Selection freezes stable IDs, date and expected timer at gesture start. Refresh/reorder cannot silently select a different row.
- Ordinary selection and VoiceOver browse/activate alternatives exist.
- Uncertain commands retain their original UUID/time for explicit retry. Shared mutation serialization prevents a second surface from overriding an unresolved command.

**Not established by these deliveries:** actual SpringBoard/Lock Screen hosting, free-signing App Groups, physical-device authentication/background behavior, every WebKit feature, complete forecasting redesign or repaired Copilot answer quality. Simulator layout galleries are not actual hosted widget tests.

## 5. Architecture and source map

React/Vite/TypeScript frontend → React Query/API wrappers → Express API → PostgreSQL. Vercel exports the Express application through `api/index.ts`. Native Swift clients call narrow scoped APIs against the same cloud records. Storage includes private Blob/Google Drive references and durable extraction/indexing jobs. Copilot reads typed evidence and prepares proposals; generated prose is not an applied mutation or proof of completion.

`server/index.ts` is the local process entry and can initialize schema/seed/start workers. Starting `npm run dev` against a production URL is not read-only. `server/app.ts` builds the application without starting its listener. Dexie/UI persistence is not the cloud source of truth.

| Area | Start here |
| --- | --- |
| Bootstrap, navigation, invalidation | `src/main.tsx`, `src/App.tsx`, `src/store/useAppStore.ts`, `src/utils/apiFetch.ts` |
| Server/db/schema | `server/app.ts`, `api/index.ts`, `server/db.ts`, `server/schema.sql`, `server/migrations/` |
| Task identity, descendants, archive/CP eligibility | `src/utils/taskTree.ts`, `src/components/TaskTree.tsx`, `shared/workHierarchy.ts` |
| Shared remaining work / rollups | `shared/workAccounting.ts`, `server/services/workAccounting.ts` |
| Actual-time integration | `src/utils/timeHeatmap.ts`, `shared/scheduleReview.ts`, `server/services/scheduleReview.ts` |
| Daily queue and atomic widget commands | `server/services/dayWork.ts` |
| Canonical focus timer / legacy detach | `server/services/workTimer.ts`, `server/routes/work-timer.ts` |
| Attendance start/end/corrections | `server/services/scheduleStart.ts`, `scheduleReview.ts`, `scheduleTimeCorrection.ts` |
| Scoped credentials/API | `server/services/scheduleShortcuts.ts`, `server/routes/schedule-shortcuts.ts`, `schedule-review.ts` |
| Web check-ins and cross-client refresh | `src/views/schedule/ScheduleReview.tsx`, `src/hooks/useCloudWorkTimer.tsx`, `src/components/WorkTimerIndicator.tsx` |
| Goal percentages/health and analytics | `src/utils/goalTaskMetrics.ts`, `src/utils/goalTimeAnalytics.ts`; find current GoalDetail/DeadlinePill call sites |
| Native transport/models | `native/MarinaCore/Sources/MarinaCore/Models.swift`, `DayWork.swift`, `WorkPicker.swift` |
| Native durable state | `native/Marina/Shared/SharedStore.swift`, `DayWorkStore.swift` |
| Native work UI | `native/Marina/App/DayWorkSheet.swift`, `WorkTaskPicker.swift` |
| App shell / WebKit / offline test fixtures | `native/Marina/App/MarinaApp.swift`, `MarinaWebView.swift`, `NativePreview.swift` |
| Widget layouts/actions | `native/Marina/Widget/MarinaWidget.swift`, `DayWorkWidget.swift`, `native/Marina/Shared/*Face.swift` |
| Check-in time gesture / expanded notification | `native/Marina/Shared/HoldTimeControl.swift`, `native/Marina/Notification/NotificationViewController.swift` |
| Native project and build/test | `native/Marina/project.yml`, `.github/workflows/marina-iphone.yml`, `native/Marina/test-simulator.py`, `native/README.md` |
| Portable export safeguards | `server/services/portableBackup.ts` — excludes secret connection tables |

Task/goal screens own hierarchy, deadlines and context. Schedule owns placement, routines, proposals and feasibility. Work owns the canonical timer. Time owns chronological contribution views. Capture owns Thoughts/Journal; do not assume an older similarly named file is the live entry point. Resources owns upload/extraction/provenance/search. Copilot owns conversation/history/proposals. Trace actual mounts and imports before editing similarly named legacy modules.

### Additive migrations already deployed

- `M-035-schedule-review.sql`: proposed/actual scheduling and scoped check-in infrastructure.
- `M-036-day-work-widget.sql`: `focus_control` defaults false; daily picks and idempotent work commands.
- `M-037-independent-attendance.sql`: `work_timers.attendance_only` defaults false, plus `focus_ended_at`. Existing rows retained; lazy conversion only on explicit supported action.

Schema files and runtime prerequisites must agree. A new checkout must inspect migration state; never blindly run all deployment scripts against production.

## 6. Invariants that fixes must preserve

### Work, attendance and hierarchy

1. Proposed plan, accepted reservation, actual attendance, focused effort, completion and forecast are different facts. Booking a task changes coverage, not remaining effort or actual contribution.
2. Personal clock capacity is counted once. Use half-open intervals and stable identities; parent/goal rollups must not add the same child/session twice.
3. A corrected hour-long timer with 30 credited minutes observes an hour but credits 30 minutes. Attendance fallback must not restore the removed 30 minutes. Preserve original reports and correction provenance.
4. A task reaching its estimate, a Feel rating, an upload or elapsed event does not complete it. Missing effort estimates remain unknown, with known subtotal/coverage where available.
5. Open unestimated and unfinished overrun leaf work must remain selectable. A pure parent container with no residual work is not an extra timer target. Archived branches and future CP scaffolding do not leak into today selection; explicitly started eligible CP work is supported.
6. Child `time_rollup_mode` governs inclusive versus additive budget membership. Redistributing a parent into children must preserve historical effort, evidence and scope instead of duplicating it.
7. Only explicit user actions supply actual boundaries. Planned end, event advance and task switch do not supply an attendance end. Unknown ends remain reviewable while Schedule now follows the current occurrence.
8. Independent attendance must not be overwritten from a linked focus row. Attendance corrections cannot edit saved focus measurements. Work Stop never completes/deletes the task.
9. Legacy focus detach saves the focused boundary, marks attendance-only with `focus_ended_at`, retains identity and keeps attendance `ended_at` unknown. Do not rewrite unrelated historical records.
10. Active-focus coverage must have a finite observed end (currently now plus a small tolerance). `uncoveredRanges` rejects non-finite intervals: using Infinity previously removed the intended protection and was fixed.

### Concurrency and failure recovery

- All focus/attendance mutations share the `marina-active-work-timer` advisory lock. Validate new task eligibility before stopping current work. Stop+start+reconcile must be one transaction.
- Commands capture exact `expected_running_id`, including explicit null. Stale Stop cannot stop a newer task. UUID replay with identical payload is idempotent; changed payload under the same UUID conflicts.
- UUID history across saved sessions/timers prevents an old start from restarting later. New commands older than ten minutes or more than one second in the future reject, except already committed replay.
- Lost response after commit must retry the same command UUID and instant, not invent a second session. Network/5xx uncertainty stays pending; definitive rejection can clear with visible failure.
- Cross-surface pending mutations use shared App Group state and locking. Schedule and focus commands must not race around that serialization.
- `scheduleRevision` refresh is necessary when attendance changes without a focus timer ID change. Preserve the hook regression coverage.

### Today queue and security

- Membership comes from accepted current-day calendar links plus explicit day picks, not every overdue item or unapplied proposal. Deduplicate stable IDs, expand eligible child work with context, never copy a task to make it timeable.
- Rank an unambiguous current linked task, explicit pick order, recent unfinished work within the queue, then deterministic fallback. Overlap/multiple choices must not silently guess.
- A task can remain in the queue from its calendar link after a manual unpin; these are separate membership sources.
- Existing schedule-only credentials stay schedule-only. Focus control is explicit opt-in, not a silent upgrade. Tokens must not access general task APIs or key management.
- HTTPS fixed-origin requests, no token in URLs/logs, no embedded credentials. General API remains cookie-authenticated; native scoped transport does not reuse the browser cookie jar.
- Saved state must mean durable acceptance. Do not show false Saved, discard uncertain commands or suppress cloud save failures.

### Narrow API reference

Cookie authentication owns `/api/schedule-review/shortcuts/keys` (create/list/revoke connections) and general `/api/work-timer` routes. A newly created connection returns its plaintext token once; never persist it in repo/docs.

Scoped bearer API:

| Route | Purpose / important inputs |
| --- | --- |
| `GET /api/schedule-shortcuts/context` | Date/timezone/server clock, accepted events, pending check-ins; optional date |
| `POST /api/schedule-shortcuts/start` | `session_id`, `occurrence_id`, `date`, `expected_running_id`, `started_at`, `track_live`, `attendance_only` |
| `POST /api/schedule-shortcuts/end` | Original schedule `session_id` and `ended_at`; cannot stop arbitrary work |
| `GET /api/schedule-shortcuts/work/context?available=1` | Today tasks, optional available choices and current focus; requires focus capability |
| `POST /api/schedule-shortcuts/work/pick` | Stable `task_id`, `selected`; requires focus capability |
| `POST /api/schedule-shortcuts/work/command` | `command_id`, start/stop `action`, nullable `task_id`, `date`, nullable `expected_running_id`, UTC `instant` |

New native/web attendance sends `attendance_only:true`. Omitted/false retains older client compatibility. Empty-string task ID is not equivalent to null for routine/legacy Stop; current native code normalizes it. Consult current types for full response shapes rather than treating this table as a schema replacement.

## 7. Next-work checklist

The detailed [widget research/build/test checklist](iphone-widgets-research-build-test-checklist.md) owns T01–T24 and market sources. Its earlier baseline sections are historical; latest milestone notes supersede descriptions of functionality now implemented. Do not implement already delivered features because an old research checkbox remains unchecked.

### A. First priority: actual iPhone acceptance and reported defects

- [ ] Install/update the latest IPA through AltStore using the same bundle IDs; retain both extensions. Verify App Groups and the app's shared connection on the physical phone.
- [ ] Add actual Home Screen small/medium and both Lock Screen widgets. Verify direct Start/Stop, paging-only navigation, stale snapshots and required unlock/authentication. Gallery previews are insufficient.
- [ ] Verify switching A→B→C during an open calendar event: one focused segment per boundary, event remains open, End event leaves focus running, web/native totals converge, later corrections do not restore removed minutes.
- [ ] Test hold/swipe/release, side cancel, interrupted hold, refresh/reordered queue during hold, long/duplicate titles, large text, VoiceOver, reachable targets and left-handed comfort.
- [ ] Test offline command, committed-but-lost response, retry, two surfaces, concurrent web/phone, stale expected timer, revoked key and empty/corrupt cache. Never silently start a different task.
- [ ] Test midnight, account timezone/DST, next-day stale choices, overlapping events, missed end, deleted/archived running task Stop and unestimated/overrun child work.
- [ ] Verify actual expanded native notification presentation and time editing separately from widget actions. The OS owns expansion and authentication; stale reminders need honest handling.
- [ ] Verify full WebKit app: persistent sign-in, uploads/camera/media, downloads/share, OAuth return, keyboard/chat drafts and visible save failures. Test live reads safely; coordinate intentional production work mutations rather than injecting fixtures.

### B. Subchecklists and daily work polish

- [ ] Identify exactly what the user calls “P subchecklists” in current UI/storage. Parent/CP task descendants already have stable identities and eligibility rules. Plain text/note checkboxes are not proven independent work records.
- [ ] If plain checklist items need work identity, design stable item IDs and migration/rollup semantics first. Never key timers by checklist index or label; never clone entire tasks for today.
- [ ] Review manual versus inherited calendar membership, short parent context, pin ordering and remove behavior. Keep the daily queue intentional and compact.
- [ ] Assess Live Activity/optional Shortcuts/Control Center convenience only after core device acceptance. Reuse the canonical timer; do not add another stopwatch.

### C. Cohesive time metrics — major unfinished workstream

The detailed specification is local `study/Marina-cohesive-time-model.md`, superseding the earlier `Marina-time-accounting-proposal.md`. It is a redesign/reference calculation, **not** proof it is integrated. The October 18 audit predates the latest attendance fixes; reproduce each remaining mismatch against current source before patching.

- [ ] Inventory every consumer: heatmap, Work SQL stats, task/goal logged totals, progress ring, Feel, velocity, finish illustration, deadline health, lateness, reservations, planner and Copilot summaries.
- [ ] Use one shared time projection and explicit precision/conflict policy. Work statistics previously summed raw rows/start dates while the heatmap integrated bounded intervals. Allocate midnight/timezone intersections correctly; preserve unlocated reports separately.
- [ ] Preserve inclusive/additive parent semantics during decomposition. Redistribute scope weights and historical evidence once; new scope versions must explain progress changes.
- [ ] Reproduce goal ring double weighting: a 120-minute inclusive parent with two 60-minute children should not make one finished child 25% of equal child outcomes. Distinguish outcome progress from effort coverage.
- [ ] Freeze original estimates and record reliable lifecycle/completion timestamps. Do not classify lateness from `updated_at` or round a positive two-hour delay into On time.
- [ ] Replace fixed four-hours-per-calendar-day finish illustrations with constrained schedule scenarios when enough inputs exist. Separate deadline passed, feasibility, missing coverage and forecast uncertainty; unknown work cannot be unconditionally Safe.
- [ ] Capacity-check overlapping future accepted reservations across the person. Two hour bookings overlapping by 30 minutes cannot create 120 minutes of coverage in 90 clock minutes. Preserve accepted occupied time; proposals consume scenario capacity only.
- [ ] Rename/clarify historical velocity as actual-versus-original-estimate where that is what it computes. Separate effort ratio, comparable units per active minute, delivery throughput, elapsed cycle time and unfinished work age.
- [ ] Make estimate units explicit: the audited parser interpreted plain values ≤12 as hours and larger ones as minutes. Reproduce current behavior and show the parsed value.
- [ ] Treat Feel as subjective attention (0–100), not automatic duration/completion. Sparse history does not validate a regression or confidence label.
- [ ] Model uploads as scoped study requirements and submitted evidence. Deduplicate shared reading/version/range/work-type/pass; distinguish intentional rereads and production work. Submission can prove an outcome without manufacturing hours.
- [ ] Preserve explicit remaining-work checkpoints. Do not subtract all lifetime actual time again from a newly supplied remaining estimate. Exhausted estimate on open work means overrun/unknown remainder, not zero or complete.
- [ ] Keep future unscoped goals visible without invented breakdowns. When later broken into children, preserve scope, evidence, time and historical completion; disabled autoscheduling must not erase backlog/history.
- [ ] Backtest candidate personal rates/forecast corrections chronologically with comparable, adequately logged completed work. The old cloud audit found only three candidate completed estimate+actual pairs, not three validated training observations. Do not multiply a learned personal rate by the same slowdown a second time.
- [ ] Feed Copilot authoritative typed metrics with coverage/as-of/scope provenance. Models must not recompute totals or infer completion from a successful tool call.

Review concerns requiring reproduction, not declared new regressions: integer-minute/minimum-one rounding across rapid tiny segments; old awaiting-end combined records without a trustworthy focus boundary; visibility of corrupted shared-cache state. Do not bulk infer historical ends to hide uncertainty.

### D. Copilot and resource roadmap — still open

Read [the implementation plan](time-management-copilot-implementation-plan-2026-10-03.md) and [P03.2 reopened checkpoint](planning-checkpoints/P03.2.md). At that checkpoint P00–P02 and P03.1 were complete; hierarchy accounting shipped but **P03.2 answer-quality acceptance reopened**. Do not jump to P03.3 merely because tests or native widgets pass. Historical section counts are not a new audit of completion.

- [ ] Reconcile the dirty original checkout's unfinished Copilot repairs before using them. They are unqualified candidate work and include unrelated files. Do not blanket-stage or deploy them.
- [ ] Reproduce the checkpoint's seven open chatbot closure gates and actual failed planning/calculation/requirements answers. Keep real semantic usefulness distinct from typed schemas and mock tests.
- [ ] Trace Nemotron-only chat selection (Super/Ultra/Lightning; Super default in historical delivery). Search embeddings and document specialists have separate roles; do not restore retired chat models without user direction.
- [ ] Preserve the activated Nemotron search index and note-worker lifecycle fixes. Historical 572/572 coverage on October 7 is not evidence of current freshness or retrieval quality. Keep legacy/native embedding spaces separate.
- [ ] Continue outstanding source-change/queue atomicity, mixed-language and long-source retrieval, near-duplicate disambiguation, provider outage/quota and latency evaluations in their checkpoint. Distinguish endpoint errors, throttling, empty content and timeout.
- [ ] Later plan sections cover persistent plan use, scoped resource roles, requirements, remaining forecasts, scenarios, explicit Apply/version checks, Google sync recovery, conversation persistence/cancellation, unified resources and full answer acceptance. Persistent manual plan records existing does not mean automatic chat planning is implemented.
- [ ] Make failed behavior expand the current checklist rather than declaring infrastructure equivalent to a useful product. Follow the plan's bounded leaf-by-leaf continuation protocol unless the user authorizes a larger batch.

### E. Cloud operations

- [ ] Verify current automatic backup scheduling, last success, private retention and a restore drill. Past registration/manual backup success is not proof today's automation works.
- [ ] Preserve visible save errors and separate local acceptance from remote Google/Drive sync status.
- [ ] Keep source push, deployed code, database migration, native artifact, installation and phone acceptance as separately evidenced statuses.

## 8. Native release and installation

Latest locally preserved IPA:

```text
C:\Users\Salam\Documents\ChatGPT\marina\implementation\native\Build\Marina-LockScreen-WorkPicker.ipa
C:\Users\Salam\Documents\ChatGPT\marina\implementation\native\Build\Marina-LockScreen-WorkPicker.verified.json
SHA-256: d70872650951387ca70ac077ce0a4eb60c32d6c59e89f65275d3fe162ff6797e
```

[Successful build/test run](https://github.com/Abkob/Marina/actions/runs/39223130601), native source `993366e`. IPA build **3**, device minimum **iOS 17**, existing IDs:

```text
com.abkob.marina
com.abkob.marina.widget
com.abkob.marina.notification
```

Both widget configurations share one widget extension; do not create additional app IDs for each face. App + two extensions are retained. The IPA is built/ad-hoc verified for user re-signing, not App Store/TestFlight distribution or a claim of valid installation without AltStore signing. No paid Apple account was purchased. Current free-signing limits/renewal must be checked against official Apple/AltStore guidance if advising anew.

Install/update through AltStore Classic, retain both extensions, open Marina and sign in (WebKit cookies differ from Safari), open the native stacked-card control → Tasks for today → Widget connection → Connect task widget. Older schedule-only connections require explicit focus upgrade. Choose daily tasks, add Home and Lock Screen configurations in iOS. The picker opens inside Marina; iOS controls any unlock requirement.

Windows has no local Xcode/iOS Simulator. CI uses `macos-15`, XcodeGen, Swift tests, device Release build, codesign verification, Simulator UI tests and artifact upload. Workflow: `.github/workflows/marina-iphone.yml`; manual dispatch is available. Preserve artifacts locally because retention is 14 days. Do not spend Apple money or change bundle IDs to solve a build issue.

Simulator-only deployment override 18.4 works around an Apple WebKit issue on the runner's iOS 18.5. It does not raise the device minimum from iOS 17. UI fixtures in `NativePreview.swift` are Simulator-only and intercept writes; they must never be enabled against production.

Known build pitfalls already fixed: a SwiftUI helper requires `@ViewBuilder`; naming a UILabel property `next` collides with UIKit's responder property. Preserve the fixes. Two preliminary failing candidates are not release evidence. A redundant later workflow was canceled because its native source matched the successful build; do not describe it as another successful run.

## 9. Verification evidence and safe commands

Last feature verification, recorded before this documentation task:

| Evidence | Result / limitation |
| --- | --- |
| Real PostgreSQL integration | 43 cases across day work, schedule review and work timer; independent clocks, intermediate/final totals, overlap, corrections, races, replay and authorization |
| Hook/web regression set | 15 tests, including independent attendance, next-event/overlap/proposal behavior and same-timer-ID refresh |
| Full unit run | 1,405/1,406 passed; one PDF-render timeout; all 11 PDF tests passed on isolated rerun without assertion changes. Do not claim one uninterrupted green full run |
| TS/build/serverless/preflight | Passed on final runtime changes |
| Swift core | 10 tests passed |
| Simulator UI | Six passed: check-in hold/slide; task hold/swipe/release; horizontal cancel; Home layouts; one-tap start/switch/stop; widget gallery |
| Native build | Device app and both extensions compiled; ad-hoc signatures verified |
| Live production reads | Work and attendance context 200; schedule-only key denied focus 403; native key denied generic task API 401; revocation 401. Temporary keys revoked; no production timer/attendance/pick mutations |
| Actual iPhone | Still requires physical acceptance; no claim of hosted-widget/signing success |

The picker gesture screenshot and shared Home/Lock layout gallery were viewed. Local extracted evidence is under `native/Build/Verified-LockScreen-993366e/`; it is ignored and absent from a clone. Shared-view gallery is layout evidence only.

Use Node **24.x**, matching `package.json`. This laptop's bundled runtime:

```powershell
$env:PATH='C:/Users/Salam/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin;'+$env:PATH
node --version
npm run lint
npm test -- --maxWorkers=2 --testTimeout=15000
npm run build
npm run vercel:entry-check
npm run vercel:preflight
```

These commands are examples, not permission to ignore a new failure. On a fresh clone install dependencies through the lockfile first. Avoid default Node 26 incompatibilities. Do not repeatedly broaden tests after relevant checks pass unless a new change/failure justifies it. A documentation-only handoff needs link/content/diff checks, not rerunning the entire application suite.

Relevant tests:

```text
server/__tests__/dayWork.integration.test.ts
server/__tests__/scheduleReview.integration.test.ts
server/__tests__/workTimer.integration.test.ts
src/hooks/__tests__/cloudWorkTimer.test.tsx
src/views/schedule/__tests__/ScheduleReviewAttendance.test.tsx
native/MarinaCore/Tests/MarinaCoreTests/MarinaCoreTests.swift
```

`npm run test:integration` **must use a dedicated disposable local test database**. These suites truncate fixtures. `server/db.ts` requires `DATABASE_URL_TEST` and a database name containing `test`; keep the guards. Integration config disables file parallelism. This laptop has PostgreSQL 18 tools under `C:\Program Files\PostgreSQL\18\bin` and local port 5433. The local ignored runner uses `marina_schedule_review_test` and a 30-second setup allowance. Never point tests at cloud, a production restore you need to retain, or the user's ordinary local database.

## 10. Backup, migration and deployment runbook

Latest pre-M037 backup record: ignored `backups/schedule-database-backup-verified.json`, created **2026-10-19T08:18:50.813Z**; 65 tables / 4,951 rows, 14,988,636 bytes. SHA-256:

```text
a845b2119d0cf42145efc5a45d1d25d9ac436187b0de379820493d3e7baa3814
```

The custom PostgreSQL dump has a local recovery copy and a private Blob copy with matching read-back hash. A separate local restore matched table counts. Uploaded originals remain in Blob/Google Drive; database backup includes their references, not a newly copied archive of every original file byte. M037 was rehearsed against the restore and applied additively with every existing table's row count preserved. No local/development dataset replaced production.

For the next production schema/data change:

1. Inspect current deployed schema/data and the exact intended mutation. Establish what will change and how recovery works.
2. Take a fresh consistent production snapshot; upload privately, read back/hash, keep a local recovery copy and restore into a separate local database. Verify counts and required relationships. A historical manifest is not current protection.
3. Rehearse the exact migration on the restore. Compare existing row counts and relevant invariants. Review locks/defaults/backward compatibility and ensure code deployment prerequisites are satisfied.
4. Apply only the intended additive migration using the established transactional/locking approach; verify again. Do not run broad seed/restore/init operations against production.
5. Push verified source using the normal workflow; verify exact-SHA Vercel success and safe live endpoints. For native source changes, separately obtain a successful IPA/test artifact.
6. Keep recovery artifacts private and report evidence honestly. Never restore over production as a shortcut to resolving a migration or local mismatch.

Local ignored helpers exist in `tmp/`: `schedule-database-backup.ts`, `deploy-independent-attendance.mjs`, `verify-independent-attendance-live.mjs`, `day-work-test-runner.mjs`, `attendance-diagnostics.mjs`, `dispatch-widget-build.mjs`, `download-attendance-release.mjs`. They are **not shipped in GitHub**. Inspect them before reuse; the M037 deploy helper is specific to that migration and required a backup less than one hour old. Do not blindly rerun it for another change. A fresh editor must recreate the procedure from reviewed source if those local files are absent.

Backup helper used a repeatable-read exported snapshot and `pg_dump` custom archive, restored locally, then private Blob upload/read-back verification. Live scoped verification used temporary narrowly authorized keys and revoked them in cleanup. Reproduce those safeguards rather than committing private helper inputs. Portable backup scripts in `package.json` have a different export scope; inspect before treating one as a full PostgreSQL disaster-recovery dump.

### Git delivery sequence

```powershell
Set-Location C:/Users/Salam/Documents/ChatGPT/marina/implementation
git status --short
git branch --show-current
git remote -v
git log -5 --oneline
git ls-remote origin refs/heads/main
git diff --check
```

Read `AGENTS.md`, inspect exact changes, run appropriate checks, stage **only specific task files**, commit with the configured human identity, then `git push origin HEAD:main`. Fetch/reconcile if remote main has moved; never force-push. Worktree Git metadata may reside outside this checkout and require the editor's normal filesystem approval. Network/tool sandbox approval and repository authorization are separate.

Inspect exact-commit GitHub/Vercel status; an HTTP 200 root alone does not prove that commit is deployed, authenticated functionality works, the database is backed up or native installation succeeded. Verify statuses separately. This handoff's own documentation commit will follow the runtime SHAs above; it does not require a new IPA.

## 11. Reading order and surviving local research

Repository documents available in a clone:

1. [AGENTS.md](../AGENTS.md) — delivery/data/design rules.
2. [Widget market study and checklist](iphone-widgets-research-build-test-checklist.md) — competitor evidence, Apple surface boundaries, test matrix and latest two milestones.
3. [Native README](../native/README.md) — project/build/install/connection behavior.
4. [Proposed/Actual schedule specification](proposed-actual-schedule.md).
5. [Copilot implementation plan](time-management-copilot-implementation-plan-2026-10-03.md) and [P03.2 reopened checkpoint](planning-checkpoints/P03.2.md).
6. [Application guide](application-guide.md), [resource upload architecture](resource-upload-architecture.md), [resource rollout](resource-upload-rollout.md), [mobile usability](mobile-usability.md), [schedule simplification](schedule-simplification-review.md), [routine review](routine-design-review.md), and [Google Drive resources](google-drive-resources.md) as needed.

Local `C:\Users\Salam\Documents\ChatGPT\marina\study` reading order:

| File | Use / qualification |
| --- | --- |
| `README.md`, `Marina-codebase-map.md` | Whole-system map, actual screen ownership, source relationships; October 18 baseline now historical |
| `chat-context-map.md` | Relevant earlier chat titles/IDs and durable requirements; useful for retrieving original conversations in an editor with authorized chat access |
| `Marina-cohesive-time-model.md` | Full remaining-metrics redesign and worked edge cases; supersedes initial formula proposal |
| `Marina-time-accounting-proposal.md` | Earlier research/formulas, retained for context; do not override later redesign |
| `Marina-proposed-actual-schedule.md` | Feature study, before later implementation |
| `module-catalogue.md`, `module-index.json`, `dependency-edges.json` | Broad source/dependency inventory, not current line-number authority |
| `api-routes.md`, `schema-map.md`, `schema-index.json` | Historical route/schema inventories; trace current code/migrations |
| `timing-metric-audit.mts`, `timing-metric-audit-results.json` | Reproducible old mismatches; rerun/adapt to current tree |
| `timing-model-reference.mts`, `timing-model-reference-results.json` | Proposed arithmetic examples, not integrated engine acceptance |

Other study files include read-only aggregate cloud evidence, checkout snapshots, private diffs and prototype evidence. Keep them private/local; do not publish raw data or copied chats to make a clone self-contained. A new editor without Codex chat access can use the curated requirements here and those local files; it cannot assume it has the earlier chat tools or conversation history automatically.

## 12. Handoff acceptance / reporting template

Before a new feature slice is declared finished, record:

- Exact problem, final behavior and scope; remaining known limitations.
- Files/commit, task-specific checks and actual outcomes, including timeouts/retries or untested surfaces.
- Fresh backup/migration verification if production data/schema changed.
- Remote push SHA and exact-SHA web deployment status.
- Native source SHA, workflow run, IPA path/hash/build/bundle IDs when native changed.
- Actual phone checks separately from Simulator/shared-view previews.
- Checklist updates and the next bounded unresolved step.

Do not erase prior history to make a checklist appear complete. Do not claim every feature was audited because the module inventory exists. Most important: preserve the user's data, existing work and explicit work/attendance boundaries while making the daily interactions fast and understated.
