# Resource discovery and section verification

Resource questions must not stop at a literal filename mismatch. `find_resources`
now runs semantic/text retrieval automatically whenever it receives `search` or
`query`. The planner supplies the approximate title in `search` and the topic in
`query`; without `query`, the title is used as the semantic query. Browsing and
metadata cursor continuation do not make embedding calls.

The existing Gemini embedding index supplies semantic candidates, PostgreSQL text
search supplies lexical candidates, and the selected reranker orders their merged
evidence when available. Source diversity reserves candidates from different
documents so a long book cannot occupy every slot. No new embedding model, schema
or reindex is required for this change.

The discovery result separates:

- `resources`: discovered candidate sources, including content matches even when
  their names differ from the user's wording. `matched_via` explains discovery.
- `title_matches`: literal title/original-filename matches, with `has_more` and
  `next_after` continuing this metadata listing.
- `evidence`: ranked passages with actual source links and physical page numbers.
- `previews`: up to eight opening passages from each of the top two semantic
  candidates, capped at 6,000 characters per source, with continuation preserved.
- `semantic_discovery`: candidate IDs, bounded coverage, and embedding/reranker
  availability. Failures never imply that a document lacks the requested topic.

Goal/task filters constrain both retrieval lanes. Archived, unavailable, invalid
or unready content cannot enter semantic retrieval. Previews recheck source
availability. Metadata can still identify files awaiting indexing or image-only
sources. Images require the separate selected-page inspection tool.

The model uses opening context and contents to disambiguate concepts and verify
relevant sections. Similarity alone does not establish document identity or prove
absence. If it tries to finish a content inquiry after discovery without inspecting
a candidate page/continuation, the conversation allows one verification repair with
at most two extra read rounds. The existing 180-second turn deadline remains. This
uses observed tool activity; no hardcoded topic or filename routing chooses the
answer. Genuine unresolved ambiguity can still end in a clarification.

Only retrieved evidence and actual selected workspace context contribute source
references. A metadata-only library lookup no longer counts unrelated tasks and
journals loaded internally by the workspace context builder.

Kimi gets a 16,384-token output allowance because its reasoning is always enabled.
An empty NVIDIA answer is treated as a retryable provider failure; the conversation
retries once without replaying completed tools or changing models. This cannot
repair provider downtime or guarantee an available Kimi endpoint.

## Verification

- Unit coverage: semantic discovery with and without literal matches, topic-only
  queries, filename escaping, previews and continuation, search outages, citations,
  bounded research repair, genuine ambiguity, and empty provider output.
- Real PostgreSQL integration: vector-only discovery with no shared title words,
  small documents beside long books, saved goal/task intersections, unavailable
  sources, stale embeddings, and unready content.
- `scripts/eval-copilot-resource-discovery.ts`: opt-in real-model evaluation using
  fictional documents only. Cases cover a wrong title and misleading semantic hit,
  a user correction after an earlier refusal, a topic without a filename, and two
  plausible sources. All application/Drive tools are replaced with fixtures. Pass
  checks require supported source/page findings, no unauthorized actions, and
  preserved ambiguity. Reports remain in ignored `tmp/`.

These are bounded retrieval and conversation checks, not evidence of defect-free
answers across an entire library. Provider latency and availability remain external
limits, and image-only content still needs OCR/visual inspection.
