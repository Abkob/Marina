# Marina: scoped resources, modular prompts and page evidence

Implementation checkpoint, 3 October 2026. This follows the [architecture comparison](copilot-architecture-review-2026-10-02.md), which contains the detailed comparison of Open WebUI, LibreChat, Onyx, RAGFlow, assistant-ui, AI Elements and OpenAI tool orchestration. The earlier document describes the baseline; this document describes the resulting changes and their tested limits.

## 1. The folder and context contract

The stored Google Drive root ID is the boundary. Matching a folder named “Marina” is insufficient. Import, browsing, downloading, synchronization, candidate retrieval, exact page reads and visual inspection now verify ancestry back to that ID. Trashed folders, missing parents, shortcuts, cycles and ambiguous ancestry fail closed. Cached parent metadata lives for one operation only, so a later move outside the root is checked again. Temporary provider failure is reported rather than treated as proof that no resources exist.

New uploads use the selected target:

```text
Marina/
  Library/                      unassigned material
  Goal/
    Milestone/                  when the task belongs to one
      Task/
        Subtask/
```

Goal and task IDs are stored in folder properties. Renaming a title does not change its identity; duplicate titles remain distinct. Concurrent uploads serialize folder creation. Invalid task hierarchies and goal/milestone disagreement stop the upload with an actionable error.

The Resource Library upload panel and chat attachment use the same target contract. A pending upload retains the target selected when it was added, including on retry. Existing originals are preserved in place; this release does not bulk-move old files or convert old Blob originals to Drive. Adding a reference also does not move a shared file out of other references.

Typing `@` opens the context picker. Selecting a goal or task checks only its directory, in resumable pages of ten Drive entries, and queues new or changed supported documents. Selecting a task excludes nested subtask directories by default; the user can explicitly include them. A forged continuation cursor cannot traverse outside the selected directory. Unsupported files and individual failures are visible. An existing file discovered in a new target folder gains a saved reference without duplicating its resource or erasing existing references.

Chat retrieves from the already built index. Folder refresh does not place every file in the prompt and does not make new documents instantly ready. The server intersects the selected goal/task/resources with every resource tool, including metadata discovery, research search and page inspection. A model cannot override the selection. Switching context excludes old differently scoped model history; the visible transcript remains. Context persists across navigation and is restored from saved chat metadata.

Scope here means **resource evidence**. Scheduling still needs calendar occupancy and task facts outside that document selection. It is not a new multi-user authorization system.

## 2. Prompt structure and measured effect

The initial system message contains the core interaction/grounding rules, clock, output contract and four discovery tools: `find_resources`, `find_tasks`, `workspace_context`, and `load_capabilities`. Resource, task, scheduling, routine and goal rules and action schemas are loaded by domain. Resource discovery activates its reading/citation rules automatically; an explicit resource selection starts with that domain loaded. There is no keyword classifier routing the user's question to a different assistant.

Local measurement with the same synthetic clock produced:

| Loaded domain | System characters |
| --- | ---: |
| Core only | 3,923 |
| Resources | 13,017 |
| Scheduling | 9,390 |
| Tasks | 8,056 |
| Routines | 9,794 |
| Goals | 7,402 |

The core is approximately 84% smaller than the recorded 24,532-character baseline. These are characters, not tokenizer counts or measured latency. History and retrieved observations add to each call. Several loaded domains accumulate. Kimi reasoning time, endpoint queues and provider outages remain separate factors.

This adopts the **deferred discovery pattern** described in [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search) and found in the reviewed assistants. NVIDIA requests retain Marina's validated JSON protocol. No unsupported OpenAI wire fields or MCP service were added. Action proposals still require Apply; domain loading cannot apply writes.

## 3. Ingestion and retrieval

An additive page-checkpoint table stores document identity, generation, source hash, physical page, extractor/model version, native text, specialist evidence, attempt count and status. Native PDF text is extracted first. Each durable job invocation handles one page's specialist work; independent roles run concurrently:

- OCR supplements pages with very little native text.
- Parse extracts reading order, headings and table markup.
- Omni describes figures, diagrams, charts, labels and relationships.

Successful role outputs survive a partial failure. Only missing roles retry, up to three attempts per page. Truncated OCR is incomplete coverage. Exhausted visual failures preserve native text and successful evidence, and remain visible after indexing finishes. Lease checks prevent stale workers publishing a replacement. The old chunk set remains intact until the new generation is atomically written; a pending replacement is not reported as ready. Unchanged pages can reuse evidence when their source hash and extractor/model version match.

Chunking respects physical page and evidence-kind boundaries, then Markdown sections/paragraphs, then a 2,000-character ceiling with Unicode-safe splitting. Heading, evidence kind, model and generation accompany passages. Native quotations, OCR, extracted structure and visual interpretations are distinguishable in retrieval and citation cards. This is not a fully validated table-cell graph or an assertion that model-generated text is verbatim source material.

The [LlamaIndex Drive example](https://developers.llamaindex.ai/python/examples/ingestion/ingestion_gdrive/) is useful for folder-directed loading and change-aware upserts. It does not supply Marina's authorization/ancestry rules, calendar semantics or visual evidence pipeline. [DoclingDocument](https://docling-project.github.io/docling/concepts/docling_document/) is the stronger reference for typed structure and provenance. This release adopts those separation principles within the existing TypeScript/Inngest stack. It does **not** install LlamaIndex or a Python Docling service on Vercel.

Document and research search now share the PostgreSQL lexical/vector pipeline and rank fusion, with optional NVIDIA reranking. The research filter is applied in SQL before candidate ranking; it no longer fetches the first 1,000 chunks for a separate JavaScript search. A real-database test finds a distinctive passage at chunk 1,200 among 1,201 chunks. Scope is applied in both candidate lanes, and Drive ancestry is checked before text reaches the reranker.

One live **synthetic** image probe completed OCR, Parse and Omni in 26.5 seconds. All three outputs contained the calibration code; OCR was not truncated. This demonstrates endpoint compatibility, not general OCR accuracy or a speed guarantee. Private documents were not used for that probe.

## 4. Scheduling invariants

The scheduler remains deterministic. Following the precedence and no-overlap constraints in [Google OR-Tools job-shop guidance](https://developers.google.com/optimization/scheduling/job_shop), the fixes enforce these independently:

- A dependent task cannot allocate before its prerequisite is fully allocated in the proposed schedule.
- An absent blocker is unresolved unless explicitly verified completed.
- Cyclic work cannot become feasible through ordinary allocation or overflow recovery.
- Strongly connected components identify actual cycle members separately from their downstream blocked tasks.
- Clock placement checks prerequisite completion as well as daily capacity and calendar overlap.

Tests cover missing blockers, partial prerequisites, recovery ordering, self-cycles, downstream tasks, zero-minute cyclic tasks and a 10,000-task chain without recursion overflow. Existing randomized calendar/capacity tests remain. This does not replace the greedy planner with a global optimization solver or promise an optimal schedule.

## 5. Chat presentation

Source disclosure uses a small adapted [AI Elements](https://elements.ai-sdk.dev/components/sources) component with its Apache license retained. Radix supplies the context popover, collapsible passages and accessible source dialog. Streamdown renders Markdown, with KaTeX for mathematics, safe links, inert raw HTML and disabled remote image rendering. The existing backend returns complete replies, so the renderer uses static mode; no artificial streaming is claimed.

Cards show the source, physical page, actual tool-supplied excerpt, evidence kind and original Drive link. Preserved legacy Blob originals retain their Resource Library link. The preview shows the saved excerpt beside the current original, noting that it may have changed. Mobile uses a bottom sheet, compact labels and 44-pixel controls. Desktop and 375-pixel fixture checks covered formatting, context selection, explicit subtask opt-in, opening a preview and Escape/focus return.

An authenticated production check selected the abstract-algebra book with `@` and asked for physical PDF page 94. Nemotron 3 Super answered in 6.9 seconds with a page-specific OCR excerpt card; the source preview opened with the saved excerpt, model provenance and original link. This is one successful read-only interaction, not a Kimi latency or full-library performance benchmark. It exposed mixed citation brackets emitted by the model, so the renderer now repairs that narrow link shape while preserving code examples and rejecting unsafe destinations. The affected Markdown/source-card suite passed all 18 tests after that repair.

## 6. Verification and rollout limits

The full unit/component suite passed **1,214 tests**. After the final missing-metadata ancestry hardening, all **41 affected unit tests** and the complete **167-case PostgreSQL/HTTP integration suite** passed. TypeScript, frontend build, serverless import/PDF checks and static deployment preflight passed; the existing frontend large-bundle warning remains. Provider/storage calls in the integration suites are mocked, while SQL, schema, transactions, PDF parsing and durable job state are real. A separate live synthetic NVIDIA probe is described above.

The dedicated audit currently reports 221 passes, of which **four are expected-failure reproductions**, not repaired assertions. Two exercise the native-text-only PDF primitive; positive visual pipeline coverage lives in the structured-ingestion tests and live probe. Two remaining quality gaps are typed-ID discrimination during proposal preparation and calibrated rejection of semantically irrelevant vector candidates. The server's Apply validation remains authoritative. These gaps must not be hidden by calling the audit “221 defects fixed.”

Before M-030, a current PostgreSQL dump was validated locally and read back from private cloud storage with a matching SHA-256. The additive migration verifies the backup identity/age and database identity before applying. It preserves existing tables and data. This checkpoint is a database recovery copy, not a new complete copy of every Drive original. Originals were not modified. Vercel's deployment guard requires the new schema before promoting code.

Current scaling limits remain explicit:

- First ingestion is asynchronous. A large PDF requires page calls and embedding batches; quota, rate limits and Inngest executions matter.
- Each durable page invocation currently materializes the original again. A dedicated parsing worker or immutable intermediate page store is the next optimization for sustained large-file ingestion; a thousand-document throughput benchmark has not been run.
- Existing text-only documents require **Re-index** to gain visual evidence. There is no blind bulk reindex or physical folder migration.
- Default background extraction uses configured server models. Per-chat model choices still govern interactive inspection, not a silently rewritten existing index.
- Retrieval is bounded evidence selection, not an exhaustive review of every file. Large comparisons need iterative reads; a model may still misinterpret a chart or select an irrelevant candidate.
- OAuth expiry and provider availability remain operational dependencies. UI status exposes failed checks and incomplete evidence.

The implementation is designed for measurable recovery and explicit limits, rather than a claim of zero defects.
