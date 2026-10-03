# P00: reproducible planning baseline

This harness freezes Marina's starting behavior before implementing the rest of the [game plan](../../docs/time-management-copilot-implementation-plan-2026-10-03.md). It contains synthetic data only. Scripted model responses test software contracts; they do not measure a live model's planning quality.

## Commands and prerequisites

```text
npm run test:planning
npm run test:planning-baseline
```

Without `DATABASE_URL_TEST`, database/HTTP cases are **skipped**, and the receipt names them (70 at P03.2: 19 prior cases, 23 persistent-plan cases, 14 accounting cases and 14 hierarchy cases). A successful synthetic-only invocation does not satisfy the database gate. Vitest, its child process exit status and the receipt's suite status must all agree. The separate negative control intentionally fails one assertion; the parent runner succeeds only if it observes that exact failure. An unexpected pass or startup failure cannot satisfy the control.

For real integration checks, start an isolated local PostgreSQL cluster, then run:

```text
node --import tsx scripts/setup-planning-test-db.ts
```

The setup script defaults to loopback port 55439 and the `postgres` administration database. `PLANNING_TEST_ADMIN_URL` can point to a different **local test cluster**. It creates only `marina_planning_test_p00`, or verifies its explicit `marina:p00:disposable` database marker before reuse. It writes an ignored `tmp/planning-test.env`; never commit that file. Load those values into the test process, for example:

```powershell
$env:DOTENV_CONFIG_PATH = 'tmp/planning-test.env'
node --require dotenv/config --import tsx audits/planning/run.ts
node --require dotenv/config node_modules/@playwright/test/cli.js test --config playwright.planning.config.ts
```

Both `DATABASE_URL_TEST` and `PLANNING_TEST_DB=1` are required. URL checks reject remote hosts and unrelated database names; a real database identity/loopback/marker query runs before schema initialization or fixture insertion. Production configuration is never a fallback. Run the browser and full test suites sequentially to avoid CPU contention during managed-server startup.

The browser configuration starts the real Express app and Vite on dedicated test ports, refuses existing servers, and does not start background workers or seed example data. Chat replies/history are explicitly intercepted synthetic fixtures. P02 adds a real goal-plan flow with isolated owned fixtures, saved revisions, draft reload, archive and restore on four viewports. Real chat/proposal behavior is tested over HTTP in `database.test.ts`; persistent-plan races, scopes and lifecycle are exercised in `persistence.test.ts`. The [P01–P02 checkpoint](../../docs/planning-checkpoints/P01-P02.md) records the expanded child steps and results.

## Fixture contract and ownership

`fixtures.ts` freezes four version-1 cases: no-resource work with unknown effort, a selected textbook section and figure, a client deliverable, and mixed work/study commitments. Fixtures retain a fixed clock/timezone, explicit null estimates, typed relationships, source generations, expected evidence, work completion and calendar intervals.

The report cases have 40 minutes of completed calculations and 80 minutes of remaining figures/writing/review. An existing 30-minute reservation is not completed work. The mixed case has 80 free calendar minutes. A minute-set oracle checks availability independently from Marina's interval implementation. Seeds 1–100 reorder entities while preserving identities, evidence and arithmetic.

Fixture parsing fails clearly on truncated JSON, duplicate IDs, wrong-type associations, invalid dates, inconsistent clocks, missing evidence and generation mismatch. It does not silently fill missing facts. The test-only schema is not P01's future runtime planning contract.

`withPlanningFixture` inserts goals before dependent tasks/resources/chunks/calendar rows inside a rollback transaction. It never truncates tables, overwrites an existing ID or deletes unowned rows. Replays with different insertion order produce identical selected rows and leave an unrelated sentinel untouched. Hypothetical work items and expected outcomes remain fixture facts; they are not inserted into nonexistent future planning tables.

Six UI stories cover absent, loading, partial evidence, ready plan, stale proposal and provider failure. Source-bearing stories are reused in actual source-card component tests. This supplies test states for later work; it does not claim P02/P16's plan interface already exists.

## Baseline receipt

`run.ts` writes `tmp/planning-baseline/receipt.json` with starting commit, dirty-tree status, runtime, test names, per-suite failures, skipped cases and expected failures. Raw Vitest JSON and logs stay alongside it. The recorded checkpoint supplies the reviewable, tracked summary. Old receipts are removed before invoking each suite so a failed startup cannot reuse an earlier success.

Three remaining expected failures are individually inventoried in `knownFailures.ts`. The original P00 count is historical:

- `CHAT-01` is repaired in P01.1 and runs as an ordinary regression, supplemented by real database/HTTP tests.
- `RAG-02`: irrelevant retrieval candidates do not yet receive dependable relevance rejection. Repair belongs to P06.1.
- `VIS-01` and `VIS-02`: native PDF text extraction alone cannot read embedded image content. These are primitive limitations. Positive structured OCR/vision pipeline tests remain separate; the fixture does not assert that the whole visual pipeline is broken.

Vitest reports expected-failure assertions as passes. The receipt subtracts them from ordinary passes and records their full names. The source-inventory test detects an added/removed expected failure so it cannot disappear inside a green total.

## Current arithmetic and identity consumers

This inventory reflects delivered P03.1 own-task accounting and P03.2 hierarchy changes. P03.2 is reopened for chatbot-answer and provider-recovery acceptance; deployed arithmetic alone does not close it. Recheck call sites before the remaining P03/P17 work.

| Entry point | Current behavior / downstream consumers | Follow-up |
| --- | --- | --- |
| [AI context](../../server/routes/ai.ts), task summaries and retrieval | Shared own/subtree accounting; exhausted/stale forecasts remain unknown. Goal contexts retain known subtotals and unknown counts. | P03.1 complete; P03.2 must now verify these facts through the final chatbot answer. |
| Same file, `loadSchedulerInputs` | Shared database snapshot separates remaining work, eligible reservations and new calendar demand. | P03.1 completed; broader scenario freshness remains P17. |
| [Schedule preview](../../server/routes/schedule-preview.ts) | Same accounting loader as chat; direct task links, current versions, effective dates and explicit shared allocations. | P03.1 completed; overlapping interval union remains P03.3. |
| [Planning buckets](../../server/services/planningBuckets.ts) | Shared residual/hierarchy arithmetic; unfinished overruns remain visible. | P03.2 arithmetic delivered; answer consistency remains open. |
| [Event autofill](../../src/utils/eventAutofill.ts), task/goal time displays | Shared forecasts and authoritative recorded work; no implicit completion or historical-velocity multiplication. | P03.1 completed; see [checkpoint](../../docs/planning-checkpoints/P03.1.md). |
| [Estimate suggestions](../../server/services/estimateSuggest.ts) | Same-goal/global medians or labeled fallback; no document-based effort forecast. | P08; do not reinterpret current suggestions as calibrated predictions. |
| [Scheduler](../../server/services/scheduler.ts), [clock layout](../../server/services/planLayout.ts) | Consume supplied minutes and enforce existing ordering/capacity constraints. They do not discover missing work. | P12; preserve current dependency regressions. |
| [Conversation](../../server/services/copilotConversation.ts), typed observation and action filtering | P01.1 keys observations by kind and ID, ignores document metadata as identity, checks current tables before proposal persistence and rechecks at Apply. | P01.3/P17 for broader scope/freshness. |
| [Action contracts](../../server/services/actionValidation.ts) | Validate supported action shapes/values, including a limited `update_task` field set. Rename is not currently a Copilot `update_task` field. | P21/P23; inventory capabilities before promising them. |
| [Durable Apply](../../server/routes/ai-proposals.ts) | Validates payload, locks proposal and checks current archive/target facts within transaction. | P17 for broader freshness/idempotency protocol. |
| [Calendar plan Apply](../../server/routes/ai.ts), `PlanApplySchema` | Separate legacy path validates blocks and active task IDs but has no proposal/run identity in its contract. | P17; P00 does not silently redesign or claim full trace correlation for this path. |

## Diagnostic trace contract

The actual conversation loop emits phases for context/source reads, model responses, proposal validation and conversation persistence. A session's existing durable `agent_runs` record correlates the HTTP request with its execution and durable proposal. Successful proposal Apply appends one correlated event after the transaction commits. This is agent-run correlation; external Inngest resource-indexing jobs are not traced end to end by P00. Forecast/UI phase types are available for fixtures and later consumers; no future forecast is fabricated to fill a timeline.

`shared/evaluationTrace.ts` allowlists enums, UUIDs, counters, timings, source generations and a SHA-256 configuration fingerprint. There are no prompt, document body, free-text error, URL, header, credential or hidden-reasoning fields. The hash identifies effective role settings/policy version without storing their input payload. This policy covers the **new diagnostic stream**, not all preexisting application logging.

Each trace has at most 48 events, eight source references per event, 30 proposal IDs, and a recorder byte budget below 24 KiB. Omitted events/sources are counted. Stable event IDs and proposal IDs prevent duplicate effective trace entries. The UI displays the first eight phases; additional phases and diagnostic identifiers are secondary details with a 44px target. It labels partial or unsaved diagnostics separately from application-save success.

One bounded snapshot is stored as an `evaluation_trace_v1` event in the existing agent ledger. It is not copied into chat message metadata. History loading hydrates live diagnostics separately and safely tolerates missing/malformed/expired records. Diagnostics expire after seven days; the existing maintenance job prunes at most 100 expired diagnostic rows per run. It cannot delete chat, proposal, source, run or ordinary audit-event rows. A backlog may take several maintenance runs to physically remove; expired traces are already hidden on read. Browser-local cached response state may retain operational metadata until cleared; UI expiration still applies.

Storage uses a short statement timeout and catches diagnostic failures; an unavailable sink cannot change a successful application result. It may add a bounded database operation after the core write. Real DB tests inject an INSERT failure and verify the chat still saves and returns success. New traces are an aid to investigation, not an assertion that every existing save path is failure-independent.

No live model call or production load test is part of the P00 baseline. The [P00 checkpoint](../../docs/planning-checkpoints/P00.md) records that baseline's executed checks and limitations. Later P03.2 provider probes are separate evidence.

P03.2 adds the [hierarchy checkpoint](../../docs/planning-checkpoints/P03.2.md), 14 real database/HTTP cases, deep/wide/generated-tree unit cases and a parent-breakdown flow on four viewports. `liveModels.ts` is an explicit opt-in real-provider harness; its protocol success requires a separate semantic review and is never included in the synthetic test totals.

## Reopened P03.2 acceptance

The [expanded repair checklist](../../docs/planning-checkpoints/P03.2.md#8-reopened-chatbot-correctness-and-provider-recovery-checklist) is the authoritative next scope: 13 open implementation children, 28 proposed regression case families and seven closure gates. These counts are planned coverage, not executed tests. The task is not ready to advance to P03.3.

The original real answers confused a parent's residual with subtree completion, transferred an optional resource role to a task, invented parent-work meaning, contradicted their time allocations and made unsupported completion guarantees. Provider failures are recorded separately. The current code reviews proposals conditionally on actions; the expanded checklist requires coverage for factual planning replies with no actions too.

Implementation must preserve these failures as negative fixtures, add independent expected facts and real tool-contract parity, and report transport, protocol, facts, scope, arithmetic, grounding, usefulness, side effects and persistence separately. Current `liveModels.ts` does not implement those new verdicts yet. Its existing `semantic_review: required` cannot be counted as a semantic pass. Unknown/unavailable evaluations, degraded facts-only responses and selected successful retries cannot inflate planning success.

Use local mock providers for concurrent/large stress checks. Real live checks remain opt-in, serial and bounded, using synthetic tasks and no application mutations. The user's authorization for real chatbot testing remains valid; it does not require another permission round for each test. Deployment credential checks and real production verification must be labeled distinctly from calls using local saved credentials.
