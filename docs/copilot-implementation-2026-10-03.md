# Marina: scoped resources, modular prompts and page evidence

Implementation checkpoint, 3 October 2026. This follows the [architecture comparison](copilot-architecture-review-2026-10-02.md), which contains the detailed comparison of Open WebUI, LibreChat, Onyx, RAGFlow, assistant-ui, AI Elements and OpenAI tool orchestration. The earlier document describes the baseline; this document describes the resulting changes and their tested limits.

**Primary product objective, clarified by the user:** Marina is a time-management copilot. Its main job is to help the user manage priorities, workload, deadlines, commitments and progress across goals and tasks, discuss realistic options, and adapt plans as circumstances change. Resources provide context for understanding the work and estimating its effort. Studying is one task type, not the product's primary purpose. The user wants a model-led discussion of meaningful alternatives, without a hard-coded strategy or fixed planning menu. Section 8 records this objective and distinguishes the existing capabilities from the remaining gaps.

The follow-up [time-management research and implementation recommendation](time-management-copilot-research-2026-10-03.md) compares current products, pinned open-source implementations and research papers. It develops section 8 into a proposed architecture, staged delivery plan and evaluation strategy; those additions are recommendations, not newly implemented features.

Its [expanded comparison of closer alternatives](time-management-copilot-research-2026-10-03.md#16-closer-alternatives-the-expanded-search-for-marinas-actual-objective) now includes conversational personal planning, PExA/PTIME, TaskTracer, GAIA and additional calendar/assistant implementations. The resulting recommendation is a persistent, revisable work plan linking requirements, resource evidence, progress, uncertain effort and alternative uses of time. It records source/license findings and additional evaluation cases; this remains proposed work.

The [detailed implementation game plan](time-management-copilot-implementation-plan-2026-10-03.md) now specifies 26 work packages and 78 individually testable sections covering the complete chatbot transformation: planning, resource evidence, forecasting, conversation transport and persistence, tools, existing application domains, interface, synchronization and operations. Every section has backend/frontend work, unit/integration/stress cases and a completion gate. It includes dependencies, worked scenarios, discussion coverage and prompts for implementing one section at a time. This is a proposed execution plan; it does not change the implemented status described below.

## 1. The folder and context contract

Follow-up implementation: **P00–P02 and P03.1–P03.2 are complete**. The [P03.1 checkpoint](planning-checkpoints/P03.1.md) records shared work accounting, explicit remaining forecasts, reservation eligibility, stress tests and migration/restore checks. The [P03.2 checkpoint](planning-checkpoints/P03.2.md) records hierarchy totals, residual work, guarded reparenting and real-model failures. Interval-union feasibility remains P03.3. The [P00 checkpoint](planning-checkpoints/P00.md) records fixtures and diagnostics; [P01.1](planning-checkpoints/P01.1.md) records typed identities; the [expanded P01–P02 checkpoint](planning-checkpoints/P01-P02.md) records scoped snapshots, persistent plan revisions, conflict-preserving editing, lifecycle/retention, migration and restore evidence. A task/goal now has manual Plan memory. Automatic chat use of that memory, resource-based effort forecasting and subsequent game-plan sections remain proposed. The new checkpoint separately inventories bounds and limitations.

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

Successful role outputs survive a partial failure. Only missing roles retry, up to three attempts per page. Truncated OCR is incomplete coverage. Exhausted visual failures preserve native text and successful evidence, and remain visible after indexing finishes. Lease checks prevent stale workers publishing a replacement. The old chunk set remains intact until the new generation is atomically written; a pending replacement is not reported as ready. Ready pages can reuse evidence when the **whole file's SHA-256**, page number and extractor/model version match. This is not independent change detection for each page: changing one page can invalidate reuse across the document.

Chunking respects physical page and evidence-kind boundaries, then Markdown sections/paragraphs, then a 2,000-character ceiling with Unicode-safe splitting. Heading, evidence kind, model and generation accompany passages. Native quotations, OCR, extracted structure and visual interpretations are distinguishable in retrieval and citation cards. This is not a fully validated table-cell graph or an assertion that model-generated text is verbatim source material.

The [LlamaIndex Drive example](https://developers.llamaindex.ai/python/examples/ingestion/ingestion_gdrive/) is useful for folder-directed loading and change-aware upserts. It does not supply Marina's authorization/ancestry rules, calendar semantics or visual evidence pipeline. [DoclingDocument](https://docling-project.github.io/docling/concepts/docling_document/) is the stronger reference for typed structure and provenance. This release adopts those separation principles within the existing TypeScript/Inngest stack. It does **not** install LlamaIndex or a Python Docling service on Vercel.

Document and research search now share the PostgreSQL lexical/vector pipeline and rank fusion, with optional NVIDIA reranking. The research filter is applied in SQL before candidate ranking; it no longer fetches the first 1,000 chunks for a separate JavaScript search. A real-database test finds a distinctive passage at chunk 1,200 among 1,201 chunks. Scope is applied in both candidate lanes, and Drive ancestry is checked before text reaches the reranker.

One live **synthetic** image probe completed OCR, Parse and Omni in 26.5 seconds. All three outputs contained the calibration code; OCR was not truncated. This demonstrates endpoint compatibility, not general OCR accuracy or a speed guarantee. Private documents were not used for that probe.

### 3.1 When indexing runs

Indexing builds a reusable search representation: passages, page information, extracted visual evidence and embeddings. Asking a question searches that saved representation; it does not rebuild the whole library. Originals remain in Drive or their preserved legacy storage. The index occupies Neon database storage and grows with the amount of indexed material.

| Trigger | Current behavior |
| --- | --- |
| Upload or import a new supported document | Automatically queues that document for background processing. PDFs and supported images use the visual pipeline when NVIDIA document analysis is enabled and configured. |
| Ask about an already indexed document | Searches the saved evidence; the assistant can request a separate page inspection when needed. |
| Select `@goal` or `@task` | Checks the selected directory, imports newly discovered supported files, and queues files whose saved Drive version changed. Unchanged, available files retain their index. |
| Edit a saved Drive document | A synchronization check detects the changed Drive version and queues that document. Detection happens when a check runs, not instantly after every Drive edit. |
| Press **Re-index** in one document's Semantic Index panel | Queues that document, preserving its original. An already queued/running job is reused; a failed embedding stage can resume without repeating extraction. |
| Deploy this release with older text-only indexes | Preserves those indexes. Unchanged older PDFs need a deliberate **Re-index** to gain automatic visual coverage; no whole-library upgrade was started. |

For example, selecting a goal with 1,000 already indexed, unchanged documents checks its directory without analyzing all 1,000 again. Discovering 1,000 previously unimported supported files queues their first processing. Directory checks still incur work and API requests; “not re-indexing” does not mean a large folder refresh is free or instantaneous. A failed upgrade may need a retry, and future extractor changes may require another upgrade.

### 3.2 How images become usable in chat

For PDFs, the pipeline renders each page so the specialist models can see embedded diagrams, charts, tables, screenshots and scanned text. Native text is retained; OCR supplements low-text pages, Parse extracts structure, and Omni writes visual descriptions with visible labels and relationships. Structure and visual analysis currently run on every processed PDF page, including pages with native text. Supported standalone images are PNG, JPEG and WebP.

The extracted descriptions are indexed with the document and physical page number. This makes a diagram discoverable by its subject even when that subject is absent from the PDF's native text. These are searchable textual descriptions, not a separate image-vector index. At question time the assistant can retrieve them alongside text and call `inspect_document_page` to examine the actual page more closely, within the selected resource scope. Page inspection is a tool available to the assistant, not a guarantee that it is called on every visual question.

Example: `@Biology Explain the diagram showing how substances cross the cell membrane, and cite its page.` Retrieval can locate the saved diagram description; a subsequent page inspection can ground a more detailed explanation. Source cards distinguish visual interpretation, OCR and native text, and link to the source/page. They do not present a model description as a verbatim quotation.

New PDFs receive this processing automatically when the visual pipeline is available. Older text-only PDFs need Re-index to make their images searchable across the document, although a known page can still be inspected on demand. Incomplete indexing, tiny labels and ambiguous charts can limit coverage or accuracy. Check the visible processing status; a searchable text index alone does not prove all images were analyzed successfully.

### 3.3 Large-library work still to do

The current implementation has not been demonstrated at terabyte scale. In addition to whole-file change detection, each durable page invocation materializes the original again; a large PDF can be downloaded repeatedly during one indexing run. Visual model calls, database growth, provider quotas and job volume remain material costs.

The following are proposed improvements, **not completed features**: cache an immutable downloaded original or rendered pages across jobs; use page-level hashes to reuse unaffected evidence after an edit; and add explicit library-wide processing budgets and rate controls on top of the existing bounded jobs and retries. These changes need throughput and recovery tests before making large-library capacity claims. Existing folder scope and incremental per-document synchronization reduce unnecessary work but do not establish terabyte readiness.

Implementation references: [Drive synchronization](../server/services/googleDrive.ts), [directory refresh](../server/services/driveDirectoryScan.ts), [processing and retry](../server/services/resourceProcessing.ts), [page evidence and reuse](../server/services/structuredIngestion.ts), [chat resource tools](../server/services/copilotTools.ts), and [per-document Re-index control](../src/components/resource-profile/SemanticIndexPanel.tsx).

## 4. Scheduling invariants

In everyday terms, `Read chapter → Solve exercises → Submit homework` must stay in that order. If reading needs two hours, scheduling only 30 minutes does not make the exercises ready. A missing reading task is not proof that it was completed. If reading and exercises depend on each other, they form an impossible loop; submission is blocked behind the loop without being one of its causes. Exercises also cannot start at 10:30 when reading ends at 11:00, or overlap an existing calendar event.

The scheduler remains deterministic. Following the precedence and no-overlap constraints in [Google OR-Tools job-shop guidance](https://developers.google.com/optimization/scheduling/job_shop), the fixes enforce these independently:

- A dependent task cannot allocate before its prerequisite is fully allocated in the proposed schedule.
- An absent blocker is unresolved unless explicitly verified completed.
- Cyclic work cannot become feasible through ordinary allocation or overflow recovery.
- Strongly connected components identify actual cycle members separately from their downstream blocked tasks.
- Clock placement checks prerequisite completion as well as daily capacity and calendar overlap.

Tests cover missing blockers, partial prerequisites, recovery ordering, self-cycles, downstream tasks, zero-minute cyclic tasks and a 10,000-task chain without recursion overflow. Existing randomized calendar/capacity tests remain. This does not replace the greedy planner with a global optimization solver or promise an optimal schedule.

“Deterministic” means the same task facts, calendar, settings and reference time produce the same scheduling result. A greedy planner makes successive local placement choices. A global optimization solver would consider combinations against an explicit objective, such as minimizing missed deadlines. The tests check feasibility rules and regressions; the 10,000-task chain exercises dependency handling, not whole-product throughput or a guarantee of the best arrangement.

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

## 7. Limitations in plain language

This inventory was checked against the repository on 3 October 2026, after application commit `489a7aa` and documentation update `669e1ac`. It covers the reviewed upload, Drive, ingestion, retrieval, Copilot, scheduling and recovery paths. It records identifiable limits rather than claiming to enumerate every possible bug. No production data was changed for this documentation audit.

The labels matter: a **hard limit** is an enforced cap; a **tradeoff** is intentional behavior with a cost; a **known defect** has a reproduced failing expectation; an **unvalidated capability** has not been demonstrated at the claimed scale or quality. A proposed improvement below is not a feature already delivered.

### 7.1 File sizes and supported formats

**Hard limits.** Uploads accept up to **50 MiB per file** (52,428,800 bytes; the interface calls this “50 MB”). That is unrelated to the amount of free space in Google Drive. Interactive visual inspection has a smaller limit: **25 MiB for a PDF original**, or **8 MiB for a standalone image**. A 40 MiB PDF can therefore be accepted and processed in the background but rejected when chat tries to inspect one of its original pages live. The page-inspection path currently downloads the whole PDF to render that page.

PDF, UTF-8 TXT/MD/CSV, PNG, JPEG, GIF and WebP are accepted upload types. Acceptance does not imply equal analysis support:

- PDF, PNG, JPEG and WebP enter the automatic visual path when configured. GIF can be saved but is not supported by that path or the selected-page inspection tool; convert it to PNG/JPEG for analysis.
- The default detector OCR accepts PNG/JPEG, not WebP. A WebP image can receive visual interpretation while its OCR role fails; conversion to PNG/JPEG avoids that particular mismatch. Merely accepting WebP does not guarantee complete specialist coverage.
- Direct DOCX/XLSX/PPTX, archives, audio and video are not handled by this resource upload/indexing path. Export relevant material to a supported format. Native Google Docs, Sheets and Slides are exported to PDF, so analysis sees the export, not editable spreadsheet formulas, hidden sheets or slide interactions as structured application objects.
- Password-protected PDFs cannot be indexed without an unlocked copy. Corrupt files, mismatched signatures and empty files are rejected or fail processing. Google can also refuse a native export under its own rules; the app's 50 MiB cap does not override provider restrictions.

**Practical response:** export/unlock/convert a source when needed. Raising a byte limit alone would not fix the download, memory, rendering and timeout constraints. Sources: [upload policy](../shared/uploadPolicy.ts), [Drive export](../server/services/googleDriveClient.ts), [file validation](../server/services/uploadValidation.ts), [original-page inspection](../server/services/documentReading.ts), [OCR](../server/services/nvidiaEvidence.ts).

### 7.2 Folder organization and selected context

**Tradeoff.** Drive originals must be descendants of the stored Marina root ID. A shortcut to an outside file is not accepted as proof that the original belongs to Marina. Missing access, a trashed root, ambiguous parents, duplicate managed folders or excessively deep hierarchies stop the operation. The ancestry walk is bounded to 64 visited items; resolving task ancestry permits at most 48 task nodes. These are safety bounds, not recommended folder depths.

Directory refresh reads ten entries at a time and limits its pending traversal queue to 200 folders. This is a queue-width bound, **not a 200-file library cap**. Very broad folder trees may require selecting a smaller goal/task folder. The browser continues the paginated refresh; leaving or changing context stops further client requests. Already queued indexing jobs continue, but undiscovered files may wait until the folder is selected again.

The `@` interface currently selects one goal, task or document at a time. Its chooser lists up to 20 matching items of each kind and searches names by text; semantic document discovery happens in the assistant's retrieval tools, not in that chooser. Task subfolders require the include-subtasks option. Changing context also excludes earlier differently scoped turns from the model's active history, even though those turns remain visible in the chat.

Existing Blob files were not moved into Drive, and old Drive originals were not automatically reorganized. Adding a reference does not move the file. Directory import can add a goal/task reference without removing earlier references. Folder identity is based on saved IDs; this is not a complete bidirectional file-manager synchronization system that automatically renames, relocates and removes every old relationship.

**Practical response:** select the smallest useful context, search the chooser by a more specific name and check import/refresh status. Sources: [folder refresh](../server/services/driveDirectoryScan.ts), [client refresh lifecycle](../src/hooks/useResourceDirectory.ts), [root guard](../server/services/driveAncestry.ts), [folder creation](../server/services/driveFolders.ts), [chooser](../src/components/ResourceContextPicker.tsx).

### 7.3 Freshness and external changes

**Tradeoff.** Drive synchronization is based on checks, not a push notification for every edit. The Inngest recovery function is configured every ten minutes and checks ten saved Drive resources per run by default, oldest checked first. Those ten resources are not the entire library. If that background path were the only trigger, checking 1,000 unchanged resources would take roughly 100 successful runs, or about 16 hours 40 minutes. That arithmetic describes the configured batch size, not a promised delay: selecting a resource/folder and other maintenance paths also perform checks.

A successful ancestry/access check proves the file is still inside Marina and accessible. It does not, by itself, refresh its indexed content to the latest Drive version. Until synchronization detects an edit, a search can return older evidence. Once the change is detected, the document is queued again. Google access expiry, API errors and rate limits can delay checks or prevent reading even when passages exist in Neon.

**Practical response:** select or explicitly sync the relevant source before relying on a recent edit, then wait for its processing status. A scalable freshness improvement would use provider change tracking and a measured refresh backlog. Sources: [Drive synchronization](../server/services/googleDrive.ts), [recovery cadence](../server/routes/resourceWorkflows.ts), [candidate access checks](../server/services/driveResourceAccess.ts).

### 7.4 Indexing cost, waiting and recovery

**Tradeoff.** Saving a file, finishing searchable text and completing visual analysis are separate states. Jobs are asynchronous. The configured Inngest processing concurrency is two stage invocations; each extraction invocation advances one page, and each embedding invocation handles up to three missing chunk embeddings. A large book can therefore require many downloads, model calls, database operations and durable executions. Configured concurrency is not a measured documents-per-hour throughput.

Each page invocation currently downloads/materializes the original again. Initial PDF text extraction reads the document before staging its pages, and final publication gathers its page evidence into chunks. There is no dedicated parsing service or immutable intermediate page cache. The whole-file hash also means a one-page edit can repeat specialist work across the document. These are concrete efficiency limits before terabyte-scale use.

Previous chunks are preserved until replacement publication, but normal search and `read_document` require the resource job to be `ready`. Starting re-indexing therefore creates a **temporary search gap** for that document; preserved data does not mean the old index remains served while a replacement builds. A failed replacement can leave it unavailable to normal search until repaired, although an accessible validated original may still be inspected within the visual tool's size limits.

Worker failures and missing visual roles have bounded retry paths, generally three processing attempts for the relevant stage/page; successful roles are retained. Inngest has its own retries too, so “three” is not a promise of at most three HTTP requests across an entire document. Some failures need a manual retry. A document may reach searchable status with failed visual pages; inspect the separate visual coverage counts. Keeping the original safe does not guarantee analysis will finish successfully or by a particular time.

**Practical response:** monitor processing errors and coverage, and upgrade old books deliberately. Highest-value improvements are cached originals/pages, page-level change detection, a versioned index that can keep serving the last verified generation, and measured queue/cost controls. Sources: [worker](../server/services/resourceProcessing.ts), [structured ingestion](../server/services/structuredIngestion.ts), [dispatch](../server/services/resourceDispatch.ts), [workflows](../server/routes/resourceWorkflows.ts), [search readiness](../server/services/documentRag.ts).

### 7.5 Visual understanding and OCR accuracy

**Quality limits.** Rendering lets the visual model see PDF images, but does not make it infallible. Pages are scaled to fit 1,600 by 2,200 pixels with an upscale ceiling of 2. Tiny chart labels, dense engineering drawings and small mathematical notation can lose detail. The current tool examines a whole physical page; it does not provide an automatic zoom/crop investigation workflow.

OCR is automatically added when native page text has fewer than 80 trimmed characters. A page with abundant native text plus a small scanned inset does not necessarily receive detector OCR; Parse and Omni still run, but may miss exact text in that inset. Detector OCR output is bounded to 150 regions and about 12,000 characters. Truncation is flagged as incomplete coverage; retrying the same dense page is not a substitute for splitting/cropping it. Structure and visual responses also have output limits.

Descriptions of figures are embedded as **text**. There is no separate visual embedding index that can retrieve an image detail never captured in those descriptions. Tables are extracted as model text/markup, not a validated spreadsheet cell graph. Descriptions can omit relationships, duplicate headings, misread a minus sign or infer the wrong trend. Cross-page figures and tables are not automatically reconstructed into one verified object.

Chat can inspect a known page on demand, including before indexing is ready, but it must choose the tool and the original must be supported and accessible. If visual interpretation fails, selected-page inspection may return OCR instead, with a warning. Reading labels is not evidence that shapes, colors or spatial relationships were understood. Physical PDF page numbers can differ from the numbers printed inside the book.

**Practical response:** name the figure/page, inspect the source and verify important numbers. Useful future work includes high-resolution crops, visual retrieval evaluation and structured table validation. Sources: [rendering](../server/services/pdfText.ts), [specialist limits](../server/services/nvidiaEvidence.ts), [OCR trigger](../server/services/structuredIngestion.ts), [inspection/fallback](../server/services/documentReading.ts).

### 7.6 Chunking, embeddings and database growth

**Tradeoff.** Structured chunks preserve page and evidence-kind boundaries and prefer headings/paragraphs before splitting at 2,000 characters. That ceiling counts characters, not model tokens or complete ideas. A long proof, table or explanation can still span multiple chunks or pages. The new structured splitter does not add a guaranteed overlap between every chunk; the assistant may need neighboring passages to interpret a small excerpt correctly.

Full resource-chunk content is now embedded with its title, section and page metadata; it is no longer cut to the former 600-character prefix. Older vectors are not magically regenerated when code is deployed. Explicit re-indexing upgrades older embedding inputs. Other entity types have their own shorter summaries—for example, a note's embedding input currently uses the first 500 content characters—so improving resource chunks does not make every workspace search exhaustive.

Embeddings currently use the configured Gemini embedding model at 3,072 dimensions, independently of the chosen chat model. A Kimi/NVIDIA chat key does not replace the Gemini embedding dependency. Choosing another chat model does not change existing vectors. Changing the embedding model requires a compatible re-index/migration; vectors from different models cannot be assumed comparable merely because they have the same length.

Neon stores passages, evidence, metadata and vectors; Drive stores originals. There is no fixed conversion from “50 GB of PDFs” to a database size. A scan-heavy library and a text-heavy library produce different indexes; multiple evidence kinds can repeat information. Index storage, query indexes, retained page generations, chat history and backups add overhead. No terabyte capacity or bill prediction follows from the available Drive space.

**Practical response:** measure chunk counts, database size, indexing time and retrieval accuracy on representative documents before changing models or scaling up. Sources: [structured splitter](../server/services/documentElements.ts), [chunk reuse](../server/services/chunkPipeline.ts), [embedding inputs](../server/routes/embeddings.ts), [embedding provider](../server/embeddingProvider.ts).

### 7.7 Retrieval, comparisons and evidence quality

**Hard limits and known defect.** A document search accepts up to 20 explicit document IDs, sends at most 60 merged candidates to reranking and returns at most 12 passages. `read_document` returns at most eight chunks per call, with a continuation cursor. Those are per-call budgets, not limits on how many documents can be stored. A goal can contain many more than 20 documents, but a single answer still sees a bounded selection.

The system combines lexical and vector candidates and can reserve coverage across requested sources. This does not guarantee the best passage, every selected source or a tiny exception buried in a long book will reach the answer. Twenty requested documents cannot all have a passage in one 12-result response. Balanced source coverage also does not prove relevance. Large comparisons and “find every exception” questions require iterative searches/reads and remain limited by the turn budget.

**RAG-02 remains reproduced:** an unrelated vector candidate can be returned because there is no calibrated relevance/abstention gate. For example, the audit asks about quasar radio emission and supplies an unrelated baking passage; the search does not reliably discard it. Reranking scores rank candidates and are not correctness probabilities. The assistant can also confuse similar mathematical terms or source titles.

Lexical search uses PostgreSQL's `simple` text-search configuration; it is not a complete multilingual synonym/word-form engine. If query embedding fails, search can fall back to lexical candidates with `vector_degraded` reported. If reranking fails, fused candidates remain with an unavailable status. These preserve partial service, not equivalent answer quality. Empty search results cannot prove a topic is absent from all files, especially if indexing is incomplete or scope excludes them.

**Practical response:** narrow the question, select relevant goals/files, request neighboring pages and review citations. Priorities are a labeled relevance/abstention evaluation, stronger long-document and multi-source tests, and explicit coverage reporting. Sources: [retrieval](../server/services/documentRag.ts), [reading/discovery](../server/services/documentReading.ts), [tool schemas](../server/services/copilotTools.ts), [RAG-02 reproduction](../audits/copilot/retrieval.test.ts).

### 7.8 Conversation memory, prompting and research depth

**Hard limits and tradeoffs.** A session message is limited to 16,000 characters. The server fetches at most the most recent 100 stored chat messages; model history is then reduced by complete turns toward a 32,000-character budget, retaining the newest turn even if it is large. Older visible conversation is therefore not guaranteed to be in the model's current context. There is no claim of unlimited long-term conversational memory. Changing resource scope further restricts active history to the contiguous matching context.

The tool protocol allows at most three tool calls in one model reply and normally three fresh read rounds, with bounded format/proposal repair and additional research-verification allowances. Encoded tool observations must remain below 50,000 characters for one observation and at most 70,000 cumulatively. Exhausting these budgets can produce a partial answer, a clarification or an error instead of a complete book-by-book investigation.

The 3,923-character core prompt is only the initial system component. Resource rules raise it to 13,017 characters; additional domains, history and retrieved evidence add more. These are measured characters, not tokens or a guarantee of response time. Domain discovery also depends on the model calling the appropriate tools. Modular prompts remove unnecessary overhead but do not make every tool decision correct.

**Practical response:** split broad investigations into stages and restate essential constraints when changing context or revisiting an old conversation. A future long-running research workflow would need its own resumable plan and coverage checks. Sources: [conversation loop/history](../server/services/copilotConversation.ts), [context budgets](../server/services/copilotContextWire.ts), [session route](../server/routes/ai.ts), [scope history](../server/services/scopedConversation.ts).

### 7.9 Model availability, timeouts and model choices

**Operational limits.** NVIDIA chat calls have a default 90-second timeout, configurable by the deployment, and share a 180-second deadline across the model calls in one conversation turn. Individual tools have separate timeouts, so this is not an exact end-to-end wall-clock promise. The Vercel function is configured for a maximum duration of 300 seconds. Raising one timeout does not increase every other deadline or remove a provider queue.

Specialist call budgets differ: reranking uses eight seconds; detector OCR twenty; Parse twenty-five; ordinary visual interpretation thirty-five; Kimi visual interpretation sixty. Long/dense outputs can hit generation limits before a final answer appears. The normal conversation requests 6,000 output tokens, or 16,384 for Kimi; reasoning can consume part of the provider's allowance. Empty, interrupted or invalid model output is reported as failure after bounded recovery attempts.

The current model-led Copilot deliberately does not automatically switch chat models on failure. It can retry an eligible transient failure with the same model. A fallback displayed elsewhere in provider configuration does not mean this conversation uses it. Choose another available model if a selected endpoint cannot respond. A model appearing in the picker does not guarantee the key has access or that its endpoint is healthy.

Per-chat OCR/vision/structure settings govern interactive inspection. Background indexing uses server defaults; changing the picker does not rerun old documents or retroactively alter their descriptions. The release does not install LlamaIndex, Docling, a local visual model or an OpenAI MCP service. No provider price, free-tier permanence, throughput entitlement or service-level guarantee was established by the code audit.

**Practical response:** use model traces and explicit errors to distinguish timeouts, access failures, malformed output and slow retrieval. Sources: [provider calls](../server/ollama.ts), [NVIDIA transport](../server/services/nvidiaTransport.ts), [specialists](../server/services/nvidiaEvidence.ts), [role selection](../server/services/copilotModelRoles.ts), [Vercel configuration](../vercel.json).

### 7.10 Scheduling, action proposals and Google synchronization

**Tradeoff.** The planner enforces the reviewed dependency/capacity constraints on the supplied data. It does not know unrecorded commitments, your true task duration, travel time or an undeclared prerequisite. Missing estimates are not proof that a task requires no time. Incorrect input can produce a logically consistent but impractical plan. Reading a resource does not itself create a verified task estimate or mark its prerequisite complete.

Day allocation and placement into actual clock intervals are separate steps. Enough total minutes in a day does not prove there is a suitable free interval. The clock layout skips available slivers shorter than fifteen minutes by default and may leave work unplaced. Plans also operate within bounded date windows. The algorithm makes local placement choices rather than solving a global optimization objective; a feasible alternative or better arrangement can exist even when the current preview is poor or partial.

Conversational workspace reads are bounded too: `find_tasks` pages at up to 50 tasks, `task_details` accepts up to 20 requested IDs and returns at most 100 task rows including related work, and `schedule_range` reads at most 200 day-level tasks, 200 events and 100 meetings per call. These are tool-result limits, not database or solver capacity guarantees. A broad answer about “everything in my schedule” must not imply it reviewed rows beyond those limits; narrower windows and follow-up reads may be necessary.

**CHAT-01 remains reproduced:** proposal preparation collects observed IDs without fully distinguishing resource IDs from task IDs. The scripted audit can obtain an `update_task` proposal containing an observed resource ID before Apply. This is a missing early validation check, not evidence that the audit successfully changed a task. The server's Apply validation remains the authoritative write boundary. A proposal review model can also misunderstand intent; its approval is not a proof of correctness. Review target, dates and scope before Apply.

Google Calendar/Tasks synchronization is a separate operation from generating or applying a Marina plan. Changes on both sides can create conflicts; a remote deletion can be retained as a decision instead of deleting the Marina task. A partial or failed sync does not imply both systems now match. Planner accuracy depends on the commitments actually present in Marina. Large simultaneous-edit and cross-provider failure behavior was not exhaustively validated in this release.

**Practical response:** maintain estimates/dependencies, review unplaced work, inspect proposals and check sync status. Next work should prioritize typed entity validation before proposal creation and benchmarked scheduling-quality comparisons. Sources: [scheduler](../server/services/scheduler.ts), [clock layout](../server/services/planLayout.ts), [workspace tool limits](../server/services/copilotTools.ts), [proposal preparation](../server/services/copilotConversation.ts), [CHAT-01 reproduction](../audits/copilot/conversation.test.ts), [Google sync](../server/services/googleWorkspaceSync.ts).

### 7.11 Source cards, citations and interface behavior

**Tradeoff.** Source cards record evidence a tool actually returned, but “consulted” does not establish that every sentence of the answer is supported by that evidence. There is no complete claim-by-claim entailment verifier. Inline citations are model-authored Markdown; the renderer repairs one observed bracket mistake and validates links, not every possible malformed citation.

Saved excerpts are capped at 1,200 characters per citation; cards initially show 360, and only the first two document cards are expanded into the main list. “Read excerpt” expands the saved excerpt, not the whole book. The original/page preview points to the current file, which may have changed since the answer. A saved excerpt and generation label are not an immutable archived copy of the original PDF. Browser PDF viewing and page anchors can behave differently across devices.

Replies render after the backend finishes; upstream model streaming does not currently provide token-by-token chat output. Raw HTML and remote images in model Markdown are intentionally disabled. Source-page previews are available, but this release does not automatically insert cropped figures into the answer. Processing status uses polling, so updates need not appear instantly.

The production frontend still emits a large-bundle warning. Mobile, keyboard and source-preview checks covered selected paths, not every device, browser, screen reader or lengthy chat. Interface correctness and accessibility remain subjects for broader testing.

**Practical response:** use the page/original link for full context and distinguish evidence excerpts from answer claims. Sources: [citation extraction](../server/services/documentCitations.ts), [source cards](../src/components/CopilotSources.tsx), [Markdown renderer](../src/components/CopilotMarkdown.tsx), [index status](../src/components/resource-profile/SemanticIndexPanel.tsx).

### 7.12 Cloud dependencies, backups and recovery

**Operational limits.** Drive, Neon, Vercel, Inngest and the model/embedding services have separate availability, credentials and quotas. A successful upload, Git push or Vercel build does not prove the indexing queue, provider calls, automatic backup and Google synchronization all succeeded. Application request rate limits are currently in-memory per server process, not a distributed budget across all Vercel instances. They cannot serve as a reliable account-wide spending ceiling.

The verified pre-migration dump protects the database checkpoint; it is not a fresh backup of every Drive original. A complete portable backup separately reads referenced files, creates a ZIP in private storage and verifies the uploaded archive by reading it back. Missing/inaccessible originals or expired Drive access can abort that operation. Database rows are read in a consistent database snapshot, but external files are read afterwards; it is not one atomic point-in-time snapshot across Drive and Neon.

Automatic backup is configured daily. Configuration alone is not proof the latest scheduled run succeeded; use a recent verified receipt. Full archives are not silently rotated, so retained backups also consume storage. Large exports/downloads and verification need time and bandwidth and are not proven to fit serverless limits for a huge library. A scalable backup strategy needs incremental originals, retention decisions, monitoring and restore exercises.

Portable archives intentionally omit Google OAuth credentials and sync identifiers; reconnection is required after restore. Checksum verification establishes archive integrity, not that all provider connections and workflows will resume without setup. No production disaster-recovery time or maximum acceptable data-loss interval was measured here.

**Practical response:** monitor last successful indexing, synchronization and verified backup separately; test restoration into an isolated database. Sources: [job dispatch](../server/services/resourceDispatch.ts), [rate limiter](../server/utils/rateLimit.ts), [scheduled backup](../server/services/scheduledBackup.ts), [portable archive](../server/services/portableBackup.ts), [cloud verification](../server/routes/backups.ts).

### 7.13 Privacy, access and security boundaries

**Design boundary.** Marina currently uses a private-workspace password gate and a primary Google connection. Goal/task resource scope narrows evidence selection; it is not separate per-user ownership or a complete multi-tenant permissions system. Scheduling can still read task and calendar facts outside the selected document context to calculate occupancy. The Drive root restriction is an application check, not a reduction of the OAuth grant itself to that folder.

Hosting the UI locally or keeping originals in your Drive does not make processing local. In the cloud configuration, retrieved text can go to the chat/reranking provider, rendered pages to NVIDIA specialists, and embedding inputs to Gemini. The current embedding implementation still needs Gemini even with local chat. This audit did not establish provider retention/training policies or legal compliance; it documents where the implementation sends data.

Source text is treated as untrusted and tool arguments/actions are validated. Those defenses and scripted injection tests do not prove immunity to every malicious document or model error. Moving a file outside the root prevents new guarded reads; it does not erase excerpts already saved in prior chat history. Sharing the workspace or extending it to multiple users needs an explicit authorization/data-retention design and security review.

Sources: [workspace authentication](../server/utils/auth.ts), [Drive scopes](../server/services/googleDriveClient.ts), [scope enforcement](../shared/resourceScope.ts), [provider configuration](../server/config/providers.ts), [embedding calls](../server/embeddingProvider.ts).

### 7.14 What the tests establish—and what remains unknown

The dedicated synthetic audit was rerun for this inventory: **217 ordinary passing cases plus four expected-failure reproductions**. Vitest reports the expected failures as passes, yielding 221 reported passes. They are:

| Issue | Meaning | Current status |
| --- | --- | --- |
| RAG-02 | An unrelated vector passage can survive retrieval. | Open relevance/abstention defect. |
| CHAT-01 | A resource ID can reach proposal preparation as a task ID. | Open early-validation defect; Apply is still required. |
| VIS-01 | Native PDF text extraction misses a code printed only inside an image. | Expected limit of that primitive; structured visual ingestion is separate. |
| VIS-02 | Native PDF text extraction misses embedded chart labels. | Expected limit of that primitive; not proof that the visual pipeline fails or is always correct. |

The earlier first-1,000-row research search and scheduling cycle/dependency reproductions (RAG-03, PLAN-01, PLAN-02) now pass as ordinary regression checks. They should not remain listed as current expected failures.

The 1,214-unit and 167-integration results in section 6 are the implementation validation record; this documentation-only pass reran the dedicated audit, not the entire application suite. Integration tests use real PostgreSQL and HTTP behavior but mock external providers/storage. Scripted models test contracts, not real-model reasoning quality. The live visual fixture and one 6.9-second production document answer establish specific successful paths, not average/tail latency, accuracy across subjects or large-library throughput. The latter answer used Nemotron Super and does not benchmark Kimi.

Not demonstrated: a thousand-document or terabyte ingestion run; a labeled multilingual/long-book/chart accuracy benchmark; a sustained concurrent-user load test; exhaustive mobile/accessibility coverage; a broad adversarial security assessment; and a full production-scale restore drill. Capacity should be measured using representative files, costs, queue lag, retrieval recall, supported citations and failure recovery before promising those capabilities.

### 7.15 Suggested order for further work

The user's primary objective is time management. Further work should improve decisions about time across goals and tasks; resource understanding supports those decisions:

1. **Time-management context and discussion:** connect goals, competing tasks, priorities, deadlines, commitments and progress so the model can discuss realistic options and revise them with the user (section 8).
2. **Realistic workload understanding:** connect task requirements, relevant resources and comparable personal history to provisional effort estimates. Tasks without attached resources must remain fully supported. Keep predicted effort, the user's chosen budget and available calendar capacity distinct.
3. **Correctness of proposals:** reject wrong entity types early; validate source support, time arithmetic, dependencies and scope; expose incomplete analysis and unscheduled work. These checks establish feasibility without choosing the user's priorities or planning strategy.
4. **Fresh, efficient context:** keep task/calendar facts current and resource evidence reliable. Cache originals/rendered pages, detect changed pages, retain the last verified index during replacement, improve crops/table validation, and measure discovery and processing backlogs and costs.
5. **Planning quality, scale and recovery:** evaluate real time-management discussions across competing goals, interruptions and changing estimates, alongside retrieval quality. Load-test increasing library sizes, review database/index and backup growth, and run restore and accessibility checks before making larger capacity claims.

These are recommendations for subsequent implementation. This limitations update changes documentation only.

## 8. Primary workflow: managing time with context about the work

### 8.1 What the user wants

Marina should help the user decide how to use their time across their goals, tasks and existing commitments. Typical conversations include “What can I realistically get done this week?”, “What should change if this task takes longer?” and “How would doing this today affect my other goals?” Understanding the work helps answer those questions; document retrieval and studying are supporting capabilities and use cases.

The user explicitly rejected a fixed default strategy for insufficient time. Marina should reason about relevant alternatives and their consequences in the current situation. Changing the order of work, breaking down an uncertain task, adjusting scope, protecting a deadline or discussing a negotiable commitment may make sense in different circumstances. These are examples, not predefined branches or a required menu. The model should help the user decide, retain their corrections and revise proposals as the conversation develops. “All options” means considering meaningful alternatives, not claiming to enumerate every mathematically possible schedule.

### 8.2 The working context needed

| Context | What it contributes to the conversation |
| --- | --- |
| Goals and priorities | What matters to the user, desired outcomes, competing work and the consequences of delay. Priority comes from the user's context and choices, not merely from which task has an attachment. |
| Task requirements | What completion means, existing subtasks, dependencies and known remaining work. A report, repair, errand, assignment or routine can require different kinds of effort; none requires a resource attachment to be planned. |
| Relevant resources | Briefs, specifications, reference documents, readings, notes or diagrams linked to the selected goal/task. Their requirements, complexity, overlap and analysis gaps can inform workload. Identities, versions and source evidence remain inspectable. |
| Progress and personal history | Completed work, the user's account of what remains, actual-time records and comparable previous tasks. Logged time alone does not establish completion or understanding. |
| Effort and uncertainty | Provisional estimates of the work still needed, their evidence and assumptions. A predicted duration, the time the user wants to spend and the free time on the calendar are three different quantities. |
| Time constraints | Deadlines, fixed commitments, usable time windows, dependencies and other planned work. Distinguish firm constraints from those the user is willing to reconsider. |
| Decisions already made | The latest corrections, preferences, accepted tradeoffs and task changes. Preserve those decisions while allowing the user to revise them. |

Selecting `@task` or `@goal` limits the resource evidence being inspected. It does not erase broader calendar occupancy or competing work needed to assess available time. Considering those commitments does not authorize changing unrelated tasks or expanding resource access beyond the selected scope.

Resource context should use scoped, inspectable evidence and reusable document structure when it is relevant to the planning question. It should not require every original PDF in every prompt, imply that twelve retrieved passages constitute complete collection analysis, or make full-library ingestion a prerequisite for ordinary time-management advice. Disclose analysis gaps that materially affect an estimate or recommendation.

### 8.3 Model reasoning and deterministic calculations have different jobs

The model interprets the situation, develops possible approaches and explains their tradeoffs in conversation. There should be no forced number of options or fixed rule that always drops lower-priority work when a deadline is close. The user can challenge an estimate, change a priority or explain a constraint, and the assistant should investigate or revise the proposal accordingly.

Deterministic tools verify facts and feasibility: remaining capacity, dependency ordering, calendar overlap, action scope and evidence access. They do not choose the user's priorities or force a planning strategy. An option requiring five hours when only three are available must show the two-hour gap. The model must not silently stretch the budget, reduce a saved estimate, move a deadline or claim the option fits.

Estimates should remain provisional when task complexity and personal pace are uncertain. A specification may reveal implementation and testing work; a report brief may require analysis and revision; a textbook and exercise sheet may reveal reading and practice work. Page count alone cannot predict those durations. Relevant historical observations can help calibrate estimates, but a broad median or default is weak evidence for a particular task. After a work session, compare what was accomplished with what remains instead of simply subtracting elapsed minutes and assuming equivalent progress.

### 8.4 Example of the intended interaction

Hypothetical week: a report and a homework assignment are due Friday, a meeting occupies Thursday afternoon, and an errand also needs doing. The report has an attached brief, the assignment has readings and exercises, and the errand has no document.

When the user asks what is realistic, Marina should bring together remaining work, deadlines, priorities and free time. Inspecting the brief could reveal an analysis step missing from the report estimate; inspecting the assignment could clarify which exercises are required. The errand still belongs in the plan. Suggestions should explain their effects on the whole workload, identify uncertain estimates and show any capacity shortfall.

If the user says the report matters most but its deadline is flexible, Marina should discuss the resulting tradeoffs instead of mechanically scheduling the earliest deadline first. If a task overruns or an unexpected meeting appears, it should reassess what remains and discuss adjustments. Studying can be planned within that conversation, alongside other work. These are examples of adaptable reasoning, not a prescribed sequence of options. Calendar/task writes remain reviewable proposals requiring Apply.

### 8.5 What is present and what is still missing

**Present:** Marina already has time-management capabilities: goals and tasks, estimates and actual-time records, calendar reads, deterministic scheduling previews and reviewable action proposals. Scoped resource discovery, text/visual page evidence and saved resource-to-task/goal relationships add context about the work. The model can combine these tools for a limited, evidence-backed planning discussion today.

**Missing as a dedicated, validated capability:** a reliable connection from task requirements and relevant resource content to remaining workload, provisional effort ranges and flexible plan alternatives evaluated against competing commitments. Calibration to comparable personal history, explicit coverage of the inspected resources and sustained revision after progress updates also require implementation and evaluation. These gaps do not mean the existing time-management copilot is absent, and they do not establish a requirement to turn it into a curriculum or mastery-tracking product.

The current [estimate helper](../server/services/estimateSuggest.ts) uses the median actual duration of completed tasks in the same goal, then broader completed-task history, then a 60-minute starting guess. It does **not** inspect resource content or derive the work required to complete the task. [Resource context](../server/services/resourceContext.ts) returns relationships and indexing information, not a complete workload analysis. [Schedule previews](../server/services/copilotTools.ts) work from existing eligible tasks and estimates; they do not yet constitute a dedicated comparison engine for hypothetical work breakdowns and alternative scopes.

The next implementation should strengthen this connection within the time-management copilot. Additional prompts must not present unimplemented workload analysis as available or substitute a fixed strategy for the user's planning discussion.

### 8.6 How to validate the next implementation

Evaluate time-management scenarios across multiple goals: competing deadlines, firm and negotiable commitments, an unexpected meeting, interrupted work, a task taking longer than expected, uncertain remaining effort and insufficient capacity. Include tasks with no resources as well as tasks whose brief, specification, readings or diagrams materially change the workload estimate. Check time arithmetic, dependencies, explicit uncertainty and preservation of the user's priorities and action scope. When resource claims support a recommendation, also check source/page support and disclosed analysis gaps.

Evaluate multi-turn discussion: the user challenges an estimate, changes a priority, reports partial progress or rejects an option. The assistant should revise the reasoning and tradeoffs without forcing the same menu, inventing completion, silently changing constraints or treating all free time as permission to book it. Scripted contract tests can check boundaries; representative real-model evaluations and feedback on actual planning decisions are needed to assess usefulness.

This section records the clarified product direction and current gap. It does not claim the missing planning layer was implemented by this documentation update.
