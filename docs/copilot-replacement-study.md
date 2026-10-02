# Marina Copilot indexing retrieval and scheduling study

Study date: 2 October 2026. Code baseline: `2e4147c4beae6ca98adca597c9f53a8aff50b943`.

Marina should keep Google Drive for original documents and Neon PostgreSQL for application data and searchable evidence. The next Copilot should combine structured document reading, visual evidence, explicit source selection, and a deterministic scheduling service. Changing the chat model alone would leave several confirmed failures intact.

The current system has useful foundations: real uploads, durable processing jobs, lexical plus vector search, deterministic schedule calculations, and reviewed Apply proposals. Its document understanding is substantially less capable than its interface suggests. Most seriously, the embedding path includes only the first 600 characters of a chunk that can contain 2,000 characters. PDF images never enter that text path.

This delivery adds an isolated audit and experimental indexing helpers. It does **not** replace the running Copilot, migrate production data, or deploy the proposed architecture. The plan below is the concrete specification for that work.

## Findings and evidence

### What was tested

| Exercise | Result | What it establishes |
| --- | --- | --- |
| Existing unit suite, two workers | 962 passed, 0 failed | Existing regression contracts still pass |
| New isolated Copilot audit | 219 cases: 202 ordinary passes and 17 expected failures | Reproducible implementation limits and candidate algorithm behavior |
| Real PostgreSQL lexical experiment | 8 synthetic query and passage pairs | Actual PostgreSQL matching behavior, without modifying tables |
| Real PDF extraction | A two-page generated document with text and an embedded image | The production parser reads the text-layer control, misses the image-only code and chart labels |
| Local Tesseract OCR | Recovered the image-only code and both chart labels | OCR can restore searchable evidence on this clean English fixture |
| Candidate page windows | Boundary, character coverage, Unicode, page and version checks passed | A page-aware splitter avoids the reproduced boundary and page errors |
| Candidate source allocation | Represented 2, 3, 5 and 12 selected sources when each had qualified candidates | A global ranking need not crowd out a requested comparison source |

The first unconstrained full-suite run had 23 UI test failures. Repeating the unchanged suite with two workers passed all 962. Resource contention is a plausible explanation, not a proved application defect. Keep the controlled run for reproducibility.

The new suite deliberately uses Vitest `it.fails` for known gaps. Its green exit status means those failures remain reproducible; it does **not** mean all 219 desired behaviors work. The 17 failures cover 13 distinct issue IDs, with multiple boundary positions for some issues. When a gap is fixed, its unexpectedly passing test fails the audit until it is promoted to an ordinary regression test.

No real model answer-quality benchmark was run. Provider responses and candidate rankings are scripted in unit tests. The OCR test is a small capability demonstration, not an accuracy estimate for textbooks, Arabic scans, handwritten equations, or arbitrary diagrams. No production resource was sent to another service for this audit. Reproduction details are in [the audit guide](../audits/copilot/README.md).

### Confirmed indexing gaps

| Issue | Evidence in current code and tests | Consequence |
| --- | --- | --- |
| EMBED-01 | `server/routes/embeddings.ts`, `buildEmbeddingText`, truncates chunk content to 600 characters; the real embedding-input builder fails the rare-detail test | Semantic search cannot directly represent a detail confined to the remainder of that chunk. Lexical search may still retrieve it |
| IDX-01 | `chunkPipeline.ts` cuts long paragraphs every 2,000 characters; three complete terms disappear across the cut | Exact identifiers and rare words can become unsearchable as whole terms |
| IDX-02 | A 100-character tail from page 1 is assigned a range ending on page 2 | A citation can claim evidence spans a page it does not actually use |
| IDX-03 | The splitter advances by two newline characters even when separators contain more; three fixtures reproduce drift | Page metadata labelled exact is not always exact |
| IDX-04 | A changed chunk at the same ordinal position retains its previous row ID | A chunk ID alone does not pin an old citation to its original content |
| VIS-01 | `pdfText.ts` calls `getText()`; real PDF test misses `NEBULA-731` inside an image | Scanned content is absent without OCR |
| VIS-02 | The same parser misses the image's `Before: 25` and `After: 45` labels | Charts and figures need a visual path, even if the rest of the PDF has extractable text |

The pipeline also flattens document structure: its extraction path does not reconstruct table cells, figure regions, equations, or a navigable section hierarchy. It does not populate a meaningful heading for each newly extracted chunk. This is source inspection, not a scored layout benchmark.

Embedding metadata includes resource title and pages, so this is not an entirely context-free index. However, the provider's special title prefix looks for `Title:` while the chunk builder supplies `Resource:`. The title remains in the body, but the dedicated prefix becomes `none`. Validate model-specific formatting before changing it; do not assume an older embedding model's API conventions apply.

### Confirmed retrieval and conversation gaps

| Issue or limit | Evidence | Consequence |
| --- | --- | --- |
| RAG-01 | `searchDocuments` fuses both rankings and takes a global top 8, maximum 12. A controlled A/B comparison returns only A | Selecting two files does not guarantee evidence from both |
| RAG-02 | A deliberately unrelated vector candidate is returned with no relevance gate | The model needs a calibrated relevance check and an explicit insufficient-evidence outcome |
| RAG-03 | `researchRag.ts` fetches at most 1,000 rows before scoring in JavaScript | A relevant research passage after that candidate cap cannot be found through that tool |
| Natural-language lexical queries | Real SQL turns a question into an AND of words including `what` and `for` under the `simple` configuration | The lexical fallback can miss a passage containing the actual requested concept |
| Research language support | `researchRag.ts` extracts only `[a-z0-9]{3,}` terms | Arabic-only research queries have no search terms; document search is a separate path |
| Search tool scope | Maximum 20 explicit resource IDs and 2,000 query characters; no page or goal argument | Large requests need decomposition and a source-set handle, not a longer tool string |
| Resource catalogue | Chat workspace context returns the latest 50 resource titles without resource pagination | Named older resources can be hard to resolve, although global document content search can still find their chunks |
| Context budget | One observation must be below 50,000 encoded characters; cumulative allowance is 70,000 | Two 12-passage observations fit our fixture, a third does not |
| Tool budget | Three read rounds by default, at most three calls per round; execution is sequential | A document discovery, research, verification, and planning chain can run out of rounds |
| CHAT-01 | Observed IDs are collected into one set without entity typing; a resource ID passes the conversation layer's task-ID check | The proposal layer needs typed references. This test does not prove an invalid task write succeeds downstream |

`searchDocuments` already uses PostgreSQL full-text search and pgvector, with reciprocal rank fusion. GIN and HNSW indexes already exist. Replacing Neon or installing a separate vector database does not address these gaps.

The 2,000-character search limit is a tool limit, not the maximum user message length. The chat route accepts longer user messages. The model can reformulate them, but complex requests still need a persistent record of subquestions and which evidence has been checked.

The current tools have no dedicated read-page, expand-neighbors, read-section, inspect-figure, or document-outline operation. Search alone is a poor interface for requests such as “explain the proof around this exception” or “compare every method in these five books.”

### Scheduling foundations and failures

The day scheduler and hour layout are separate deterministic functions. The new audit checks 80 generated workloads with 25 tasks each for capacity, date, per-task limits, conservation of minutes, input immutability, and repeatability. Another 40 generated calendars test layout against overlapping busy intervals and check that unplaced work remains accounted for. These passed.

Two dependency contracts failed:

1. **PLAN-01:** a 30-minute dependent task can enter `tasks_fit` while its 1,000-minute prerequisite cannot finish in the available day. A missing completion date does not block the dependent.
2. **PLAN-02:** tasks in a dependency cycle are reported in `cycle_task_ids`, but can still enter the feasible allocation set. A warning does not make that allocation executable.

The scheduler explicitly treats blockers missing from its input as already complete. That can be valid only if the caller has resolved their actual status. The replacement must carry external prerequisite status instead of relying on absence. This is an interface risk, not a claim that every current scoped plan suffers it.

The audit also verifies calendar-date round trips around month, year, leap-day, and DST boundary dates. It does not establish correctness of every timezone conversion, ambiguous local time, or Google Calendar recurrence rule. Those require provider integration tests.

### Resource and chat interface findings

These findings come from source inspection and must become acceptance tests during implementation:

- `CopilotView.tsx` uploads a file, places one attachment in local state, and appends its resource ID to the outgoing message as prose. It clears the indexing flag after 20 seconds instead of reading the processing job. The composer has no structured multi-resource scope or page reference contract.
- Drive file IDs are available and search results already construct Drive links. Resource cards and the resource header can instead expose `resource.url`, including the internal `/api/resources/blob/...` preview route. That route name is not reliable evidence of the actual storage provider.
- Drive metadata requests do not include the parent chain or `webViewLink`, so the app cannot truthfully show a full current Drive location from stored metadata alone.
- Goal file handlers create resource metadata with `url: null` without uploading the selected bytes. The task focus upload path uses the real upload helper. One shared Add flow must replace these divergent paths.
- Task note files use another file route and are not automatically part of the indexed resource library.
- Resources attach to goals/tasks through `attached_to` edges, while some resource reference views use only `mentions`. This produces inconsistent views of the same relationship.
- Library loading fetches all pages, and pending work can trigger repeated full-library polling. Resource detail views poll several queries. Use paginated queries and one processing-status stream or targeted polling.

## What other systems demonstrate

The following are documented behaviors and design patterns, not head-to-head quality scores. Commercial product documentation does not disclose its proprietary scheduling or retrieval implementation. Public repositories also have different licenses and deployment requirements; reuse requires a license check.

| System or research | Verified pattern | Proposed use in Marina |
| --- | --- | --- |
| [Open WebUI knowledge](https://docs.openwebui.com/features/workspace/knowledge/) | Separate focused retrieval and full-context reading; tools browse knowledge and read files | Add discovery, literal search, semantic search, and direct page/section reading as distinct tools |
| [Open WebUI document chat](https://docs.openwebui.com/getting-started/essentials/) | A chat can attach reusable knowledge through a composer shortcut | Adopt explicit source chips; the shortcut can be `@` in Marina |
| [AnythingLLM](https://docs.anythingllm.com/chatting-with-documents/introduction) | Distinguishes chat attachments, embedded workspace documents, and full-text document pinning | Small exact references may fit directly; a large book must remain searchable without pretending it was all read |
| [Onyx connectors](https://docs.onyx.app/overview/core_features/connectors) and [repository](https://github.com/onyx-dot-app/onyx) | Connector ingestion tracks source updates and metadata; permission features vary by edition | Preserve source identity, freshness and access state independently from the chat session |
| [Google source-based chat](https://support.google.com/gemininotebook/answer/16179559?hl=en) | Explicit source selection and citations that open evidence in context | A visible source scope and inspectable quote/page should accompany answers |
| [RAGFlow repository](https://github.com/infiniflow/ragflow) | Document parsing and retrieval are substantial parts of its agent system | Treat ingestion as a real subsystem; evaluate parser components rather than replacing Marina with an entire second application |
| [Dify repository](https://github.com/langgenius/dify) | Combines RAG and tool/workflow building | Useful reference for observable workflow steps; adopting it wholesale would duplicate Marina's application layer |
| [Docling enrichments](https://docling-project.github.io/docling/usage/enrichments/) | Supports picture classification, picture descriptions and other document enrichments | Evaluate a separate parser worker with OCR, layout, tables, and optional visual descriptions |
| [Docling pipeline options](https://docling-project.github.io/docling/reference/pipeline_options/) | Exposes page images, OCR, table processing, timeouts and partial processing | Persist page-level capability and progress instead of one misleading ready flag |
| [Anthropic contextual retrieval](https://www.anthropic.com/engineering/contextual-retrieval) | Adds chunk-specific context before embedding and lexical indexing, then reranks candidates | Keep section identity with passages; evaluate contextual prefixes and reranking on Marina's corpus |
| [LlamaIndex subquestions](https://developers.llamaindex.ai/python/examples/query_engine/sub_question_query_engine/) | Breaks a complex multi-source question into source-specific questions and synthesizes responses | Compare files with a coverage ledger and explicit subquestions |
| [LlamaIndex auto merging](https://developers.llamaindex.ai/python/framework/integrations/retrievers/auto_merging_retriever/) | Expands retrieved child chunks into parent context | Retrieve a small passage, then read the surrounding definition, proof, or section |
| [Haystack sentence windows](https://docs.haystack.deepset.ai/docs/3.2/sentencewindowretriever) | Retrieves neighboring sentences around a hit | Avoid presenting a tiny isolated sentence without its qualifications |
| [GraphRAG global search](https://microsoft.github.io/graphrag/query/global_search/) | Broad questions use aggregated evidence and a map/reduce process | Start with section/document summaries for broad review; require measured benefit before adding a graph extraction system |
| [ColPali research](https://arxiv.org/abs/2407.01449) | Retrieves document pages through visual representations | Benchmark as an optional figure-heavy retrieval lane, not a prerequisite for the first release |
| [Reclaim scheduling](https://help.reclaim.ai/en/articles/15280604-reclaim-2-0-faq) | Combines conversational scheduling, live calendar context, background rules, and previews before applying assistant changes | Preserve Apply; show the full proposed change and conflict impact |
| [Motion scheduling reference](https://www.usemotion.com/help/time-management/auto-scheduling/reference-auto-scheduling) | Scheduling considers duration, start date, deadline, priority, chunking, and calendar events | Treat those as explicit constraints and preferences, rather than asking the language model to perform schedule arithmetic |
| [Taskade knowledge organization](https://help.taskade.com/en/articles/8958683-taskade-as-a-second-brain) | Links organized projects, notes, tasks, attachments, and references, including mentions | One resource identity can be referenced from several tasks without duplicating the original |
| [OR-Tools job shop example](https://developers.google.com/optimization/scheduling/job_shop) | Models precedence and non-overlapping intervals as constraints | Consider CP-SAT if the repaired scheduler cannot satisfy the evaluation set; do not add a solver merely for branding |
| [LangGraph workflow design](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph) | Separates data, model and action steps with checkpoints and interruption | Use the same separation in Marina; existing Inngest can provide durable steps without adding a second orchestration framework immediately |

The design recommendation is a synthesis of these patterns. None of the cited benchmarks demonstrates Marina-specific answer accuracy or supports a promise of instant responses on every document.

## The proposed indexing system

### Preserve the document before deriving an index

An upload first becomes a durable Drive file and a stable Marina resource. Indexing is an asynchronous derivative. Record the Drive file ID, connected account, source URL, current folder identity, version or content fingerprint, MIME type, upload verification, and source-check time. Re-upload retries reuse an idempotency key instead of producing duplicates.

Use content fingerprints for deciding whether to re-extract. A Drive metadata version can change after a rename or move; those operations should update location without necessarily rebuilding every embedding. A content change creates a new immutable document version. Keep the previous usable version available with a visible stale marker while a replacement processes, subject to current source permissions.

### Parse pages and meaningful elements

Recommended candidate for a measured pilot: **Docling in a separate Python worker**, with the existing fast text path retained for simple files. This is a proposed choice; Docling itself was researched, not installed or benchmarked in this audit.

| Content | Extraction and reading strategy |
| --- | --- |
| Ordinary text PDF | Native text with page coordinates and reading order; retain headings, lists and footnotes |
| Scanned page | Render and OCR; retain recognized text, page region, language and confidence where available |
| PDF containing both text and images | Keep native text, inspect image/figure regions separately; a nonempty text layer does not mean the page is fully understood |
| Table | Preserve headers, cells, row/column relationships and page regions; retrieve compact rows with their headers |
| Diagram or chart | Save the page/crop reference, original caption, OCR labels, and optional model-generated description; read the actual image when answering a visual question |
| Equation or proof | Keep source page/crop, mathematical notation and surrounding conditions; mark low-confidence extraction rather than silently changing symbols |
| Spreadsheet or CSV | Parse rows and schema; do not rely only on exported PDF text for numerical analysis |
| Google Docs or Slides | Use a deliberate export format and retain the source/version; verify figures survive export |

OCR recognizes characters. It does not by itself establish arrow direction, a plotted relationship, table structure, or whether a mathematical argument is valid. A visual description is a derived interpretation, not an exact quotation from the file. Store those as different evidence kinds.

Do not describe every page with a large vision model by default. Start with native extraction; route scanned pages and relevant figure regions through the expensive path. Add full-page visual retrieval only if evaluation shows it improves the target questions enough to justify storage, inference and latency.

### Build several levels of evidence

Proposed hierarchy: document version → sections → page elements → retrievable windows. Each item carries its source, physical PDF page index, printed page label where available, optional bounding box, parent section, content fingerprint, extraction method and parser version.

Start testing text windows around 400–800 tokens with modest overlap, adjusting for document structure and language. These are pilot parameters, not a universal optimum. Do not split a table arbitrarily or cut an identifier to meet a character target. The checked-in experimental splitter proves narrower boundary properties; it is not the final semantic chunker.

Embed the entire retrievable window within the embedding model's token limit. Include concise document/section context. Maintain separate raw evidence and generated contextual summaries so a model cannot quote generated text as if it were original prose. Small windows help find a needle; parent sections help explain it. Section and document summaries help choose what to read for broad questions but do not replace the original evidence.

### Store each kind of data in the right place

| Storage | Contents |
| --- | --- |
| Google Drive | Original documents, organized folders, and durable derived page/crop files if Drive remains the chosen file backbone |
| Neon | Resource and folder identities, goal/task relationships, source versions, extraction progress, text elements, chunks, lexical indexes, vectors, evidence references, chat and proposal state |
| Temporary worker storage | Downloaded inputs and rendered intermediates; delete after durable output verification |
| Inngest | Dispatch, checkpoints, retries and bounded batches; persistent job state still records progress in the database |

Fifty GB of Drive originals does not imply fifty GB of Neon data. It also does not imply the index is tiny. At 3,072 half-precision dimensions, vector values alone use roughly 6,144 bytes per chunk: about 614 MB for 100,000 chunks or 6.14 GB for one million, before row overhead, text, indexes, summaries and retained versions. Measure representative extracted pages and database index sizes before estimating a bill. Test smaller supported embedding dimensions against recall before adopting them.

Neon can remain the vector store. For narrow filtered searches, compare exact search with HNSW and test the deployed pgvector version. Its documentation explains that approximate search can lose candidates after filtering and describes iterative scans. This is a deployment/evaluation concern, not a proved defect in the current production query plan. [pgvector filtering](https://github.com/pgvector/pgvector#filtering)

### Make progress and failures truthful

Expose separate capability states such as `saved`, `text indexing`, `text searchable`, `visual processing`, `ready`, `partial`, `failed`, and `source unavailable`. A resource can support text questions while some visual regions remain unavailable. The answer must disclose that coverage.

Process long documents in bounded page batches, with cancellation, per-source concurrency, provider rate limits, retries, leases and resumable checkpoints. Commit a new version atomically after validation. Count actual extracted/indexed pages and figures. Remove the fixed 20-second assumption. Keep failed work and retry actions visible in the same library interface.

## How the next Copilot should retrieve and reason

### Source references in the composer

Add `@` references for a **file, goal, task, folder, section, or page range**. Typing `@` opens a searchable, paginated picker. Choosing an item creates a structured chip containing its stable ID and type; the visible title remains editable only through the underlying resource. Raw text resembling `@Algebra` is not enough to establish scope.

Example: `Compare @Algebra book [pages 70–85] with @Lecture 6, explain the exception, and plan two study sessions before Friday.`

The request should carry structured references alongside the text. A goal expands to its authorized resource set on the server. Let the user choose “these sources only” or permit broader library search; make expansion visible. References persist through follow-up questions and saved chat history. A newly selected source changes the scope version so cached evidence cannot silently carry over.

Selecting a file tells Copilot where to look; it does not mean the full book is pasted into every prompt. For a short selected passage, direct full-text context is appropriate. For a large file, use the index and page-reading tools. A reference to a still-processing or unavailable source must show its real state.

On mobile, keep one compact Sources control and a bottom sheet for search, scope and page selection. Use unobtrusive remove icons with comfortable touch targets, accessible names and keyboard focus. Do not make source selection dependent on hover.

### Retrieval paths by question

| Request | Proposed path | Required evidence of completion |
| --- | --- | --- |
| Exact small fact in a huge book | Literal/identifier search plus semantic search; rerank; expand neighboring section | Supporting passage, precise source version and page |
| Explain a difficult passage | Read the selected passage, its definitions and surrounding proof | Enough context to preserve assumptions and exceptions |
| Compare several files | Resolve the source set, split comparison dimensions, retrieve per file, synthesize | Every requested file is checked or explicitly reported missing/unavailable |
| Broad review of many documents | Traverse outlines and summaries, then batch section analysis asynchronously | A coverage ledger records which sections were inspected, skipped or failed |
| Read a chart or diagram | Find figure/caption, fetch its page/crop, use visual reading, verify against nearby text | A figure/page citation and uncertainty for ambiguous labels |
| Compute from a table | Retrieve structured rows, use deterministic calculation, cite input cells | Reproducible arithmetic tied to the source cells |
| Plan study from documents | Extract evidenced topics/deadlines, separate inferred effort, read calendar constraints, calculate a preview | Source-backed facts, stated effort assumptions, feasible blocks and unplaced work |

The proposed normal retrieval sequence is: resolve scope → plan subquestions → retrieve lexical/vector candidates → rerank for relevance → allocate evidence across required sources → expand useful sections → assemble a bounded evidence packet → answer with citations and missing-evidence disclosures.

Use a relevance model or calibrated rule with measured recall, not an arbitrary universal cosine threshold. A source quota must never insert unrelated text merely to make a comparison look complete. If B has no supporting evidence, report that B was searched without a result.

The SQL experiment demonstrates why simply switching every query to English stemming is insufficient. English search fixed three natural-language matching failures in our fixtures, but it also matched “not reversible” against “reversible” after dropping negation. Preserve literal/identifier and language-aware lanes, then verify entailment from the passage. Arabic needs its own evaluation set.

### Typed tools and persistent evidence

Proposed tools include `find_resources`, `resolve_source_set`, `read_outline`, `search_evidence`, `read_section`, `read_pages`, `inspect_figure`, `read_table`, `get_index_status`, and the existing task/calendar/preview tools. They return typed IDs, versions, coverage and explicit errors. All tools enforce source scope on the server.

A persistent evidence record should contain the resource/version/element IDs, raw supporting quote or figure region, retrieval query, freshness, and the claim it supports. The chat response references that record. Validate that cited IDs were actually retrieved and their pages belong to that version. Present inline citations that open an internal page viewer at the evidence, with separate “Open in Google Drive” and “Show folder” actions. Do not assume a Drive URL can reliably deep-link to a PDF paragraph.

For long work, persist the source coverage ledger and intermediate evidence outside the model context. Keep a small working summary in the conversation and fetch the exact evidence when needed. Increasing the 70,000-character budget alone would add noise and cost without establishing coverage.

### Scheduling stays a constrained operation

The model interprets the request and explains alternatives. Typed tools resolve task identity, reading scope, deadlines, timezones, dependencies, meetings, routines and user preferences. Deterministic code computes the schedule. An infeasible request must produce explicit unscheduled work and a reason, not invent free time or relax a constraint silently.

Fix the dependency failures before comparing alternative solvers. Carry prerequisite state into scoped requests; exclude cycles and descendants that cannot begin; enforce completion before dependent start in the actual timed layout. If greedy scheduling misses demonstrably feasible cases involving minimum block sizes and dependencies, evaluate CP-SAT with a strict runtime limit and an explicitly scored fallback.

A document-derived estimate is an estimate. “This chapter will take 90 minutes” needs either the user's estimate, an explicit assumption, or an established personalized estimate with uncertainty. It must not be presented as a fact extracted from the book.

Keep Apply proposals. Bind each to a workspace/calendar snapshot and selected source versions. On Apply, revalidate changed tasks, locked events, capacity and permissions; use an idempotency key and transactional state transitions. A concurrent calendar update should trigger a refreshed preview rather than overwrite newer work. Existing proposal protections should be reused and tested, not discarded.

## One resource library and an actual Drive location

Recommended physical organization for files created by Marina:

```text
Marina/
  Library/
  Goals/
    <goal>/
      Resources/
      Tasks/
        <task>/
          Resources/
  System/
    Derived evidence/
```

Each resource has one primary home and any number of goal/task references. Store folder IDs and resource IDs; do not resolve identity by title. This avoids accidental collisions after renaming or duplicate goal names.

An existing Drive file should remain in its original location. A managed shortcut may represent it in a Marina folder. Google's folder model permits a single parent per file, while shortcuts provide additional references. Moving a shared original is a separate explicit operation. [Drive folders](https://developers.google.com/workspace/drive/api/guides/folder), [Drive shortcuts](https://developers.google.com/workspace/drive/api/guides/shortcuts)

In the UI, distinguish:

- **Stored in:** actual provider, account and current Drive folder breadcrumb, with direct source/folder links and a last-checked time.
- **Used by:** goal/task relationships inside Marina, including all `attached_to` and relevant mention relationships.
- **AI readiness:** extraction/indexing state and supported evidence types.

Fetch and cache parent metadata before showing a breadcrumb. Handle moved files, restricted ancestors, Shared Drives, shortcuts and revoked access. A guessed Marina hierarchy must never be displayed as the actual Google Drive location.

Unify Add across Library, goals, tasks and chat: Upload, Choose from Drive, Link, or Existing resource. Show the destination before committing; reuse an existing resource by source identity. Preserve selected bytes and retry state on interruption. A task note attachment should either become a canonical resource or be clearly excluded from Copilot with an action to index it.

For legacy Blob files, show their true source until a verified migration succeeds. Copy, verify size/hash and readability, update the stable resource mapping, then retain a recovery copy according to the migration policy. Do not relabel a Blob resource as Drive merely because its card now has a Drive icon.

## Implementation sequence and release gates

| Stage | Concrete work | Acceptance gate |
| --- | --- | --- |
| 1 Correctness repairs | Full-chunk embedding; page offsets and boundaries; immutable evidence versions; dependency handling; typed proposal IDs; real readiness; functional goal upload path | Promote corresponding expected-failure tests to ordinary tests; no data loss or false ready states |
| 2 Resource identity and selection | Shared Add flow, canonical relationships, Drive provenance/folder links, paginated catalogue, structured `@` chips and saved scopes | Desktop/mobile keyboard and touch tests; upload from every entry point; repeat upload, rename, move and reconnect checks |
| 3 Document ingestion pilot | Page/element schema, separate parser worker, OCR, tables, figures, resumable batches and version cutover | Representative scanned/text/mixed PDFs retain verifiable page/region references; extraction failures remain visible |
| 4 Evidence retrieval | One common research/document retrieval service, language-aware lexical lanes, full embeddings, reranking, per-source coverage, section/page/figure reading | Held-out retrieval and citation evaluation meets agreed gates; no late-book or omitted-file blind spot |
| 5 Hybrid Copilot | Persistent research jobs, coverage ledger, bounded parallel reads, visual evidence, document-to-plan flow, fresh Apply validation | Multi-file research-to-schedule scenarios complete with correct citations and zero constraint/write-scope violations |
| 6 Measured rollout | Shadow index, comparison traces, gradual read-path switch and rollback | Verified backup, successful restore exercise, passing cloud smoke tests and stable latency/cost measurements |

These stages are ordered work packages, not claims of completed implementation or delivery-date estimates. Keep application features usable during migration. Use feature flags and a versioned new index rather than deleting the old index first.

Before any production schema or data migration, create and verify a fresh complete backup, including originals and source mappings, with a durable private cloud copy and local recovery where practical. Restore a sample in isolation. Never replace cloud data with local development data. A Git push protects code, not database rows or Drive files.

## Evaluation required before calling the replacement ready

The present unit audit is a starting gate. Build a separately versioned, held-out answer-quality set from representative permitted documents. Keep tuning and evaluation documents distinct. Record the exact parser, embedding model/dimensions, retrieval configuration, prompt/model version and source snapshot for every run.

Suggested initial corpus: text textbooks, two-column papers, image-only scans, mixed pages, tables, equations, Arabic/English content, diagrams, duplicates, revised editions, and a long document with labelled needles near the beginning, middle and end. Include inaccessible and still-processing sources.

| Evaluation family | Cases and measurements |
| --- | --- |
| Extraction | Character fidelity, reading order, table cells, figure coverage, page/bounding-box validity, partial/failure status |
| Retrieval | Recall at candidate budget, rank of gold evidence, exact identifiers, paraphrases, negatives, rare details beyond character 600, filtered scopes |
| Multiple sources | Gold-source coverage, conflicting evidence, edition separation, duplicate suppression, explicit unavailable-source reporting |
| Broad analysis | Section coverage and omissions, summary faithfulness, resumability, cancellation, time and token budgets |
| Citations | Claim support, exact version/page/region, click-through correctness, stale-source behavior, quotation fidelity |
| Scheduling | Hard constraints, dependency completion, cycles, locked blocks, overload, minimum blocks, routines, DST and midnight, concurrent changes |
| Hybrid conversations | Referenced reading → evidenced topics → estimated effort → scoped preview → correction → Apply; verify every boundary |
| Adversarial behavior | Instructions inside PDFs remain data; invented/cross-type IDs are rejected; revoked sources disappear; retry does not duplicate writes |
| Performance and cost | Ingestion pages/minute, cold/warm query p50/p95, retrieval recall versus index size, model tokens, OCR/vision cost, cancellation waste |

Proposed release targets: zero unauthorized or duplicate writes; zero hard scheduling-constraint violations on the deterministic suite; all fixture citations point to the correct source version and page; every requested source has a truthful checked/missing/unavailable status. Set corpus-specific retrieval and answer thresholds after measuring the baseline; do not invent an achieved accuracy percentage now. Human review is required for a sample of visual and mathematical answers even if an automated judge scores them well.

For a fast question, measure a small bounded retrieval path. For a book-wide or many-file analysis, show progress and persist the job. “Instantly answers everything in 50 GB” is not a realistic acceptance criterion. The useful promise is that the user can see what was read, inspect its evidence, and understand what remains uncertain.
