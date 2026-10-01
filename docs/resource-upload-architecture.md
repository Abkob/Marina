# Resource uploads: architecture audit and restructuring plan

Implementation follow-up: [changes, verification, and remaining cloud rollout](resource-upload-rollout.md). The findings below describe the pre-restructuring code reviewed during the original audit.

Reviewed 2026-10-01 against repository commit `cb72656` and the local upload-feedback changes. This is a code audit and design proposal, not a deployed migration. The live Vercel management API returned 403 during the preceding investigation; the deployed schema, storage usage, logs, and failed user upload have not been inspected. No production data was changed.

## Recommendation

Keep React/Vite, the Express API on Vercel, PostgreSQL/pgvector, and private Vercel Blob. Separate file transfer, durable registration, document processing, and presentation. The missing piece is a persistent lifecycle connecting these components.

For a minimal implementation, retain the Blob SDK and existing text-PDF parser, introduce durable processing through a coordinator with an Express integration, and make PostgreSQL the source of document status. Inngest is a practical candidate for this integration. Evaluate Vercel Workflow as the alternative if remaining within Vercel is preferred; its integration with this repository's custom Express/esbuild deployment needs a staging proof. Do not install multiple coordinators.

Add Docling on an isolated worker when OCR, Word documents, or layout-aware extraction is required. Consider Uppy headless React components for the shared upload queue, with an adapter around the Blob SDK. Neither requires replacing the restrained Resource Manager interface.

## What the current system does

The original file bytes live in private Blob storage in cloud mode. PostgreSQL stores resource metadata and the file reference, then extracted text and embeddings. Files are not stored as large binary values inside `resources`. The 50 MB limit is an application policy, not a PostgreSQL capacity limit. No aggregate per-workspace storage quota is enforced in the inspected upload path.

| Stage | Implementation | Behavior |
| --- | --- | --- |
| Select files | `src/views/ResourcesView.tsx`, local `src/components/ResourceUploadPanel.tsx` | Browser selection and upload feedback. The local patch adds validation, sequential transfer, progress, and errors. |
| Authorize transfer | `src/utils/blobUpload.ts`, `server/routes/uploads.ts` | Checks capabilities and issues a restricted client token to an authenticated browser. |
| Transfer bytes | `@vercel/blob/client` | Browser sends bytes directly to private Blob; multipart is enabled above 5 MiB. |
| Register file | `src/db/queries/resources.ts`, `server/routes/resources.ts:271` | Browser separately submits the completed Blob reference, name, MIME type, size, and optional attachment target. |
| Validate and save | `server/routes/resources.ts:291` | API verifies Blob metadata, downloads the entire file into temporary storage, checks its header, then inserts the resource and optional attachment. |
| Extract and chunk | `server/services/chunkPipeline.ts` | A background promise extracts PDF/text content and transactionally writes chunks plus embedding jobs. |
| Embed | `server/services/embeddingWorker.ts` | Database-backed jobs are claimed with leases and `SKIP LOCKED`, then processed in batches. |
| Display | Resource Library, profile, semantic-index panel, file viewer | Library queries return resource rows; preview eligibility is inferred from URL extensions; processing feedback is inferred from chunk rows. |

Direct browser-to-Blob transfer is appropriate for Vercel: it avoids the function request-body limit. Vercel's official guide also provides a completion callback for database updates. [Vercel client uploads](https://vercel.com/docs/vercel-blob/client-upload).

## Findings, ordered by consequence

1. **Registration and attachment are not atomic.** The resource insert and attachment insert are separate commits. If the second insert fails, the catch block deletes the Blob but leaves the resource row. This can produce a broken resource and also cause a complete backup to fail because a referenced original is missing. Evidence: `server/routes/resources.ts:301–316`; backup missing-file handling in `server/services/portableBackup.ts`.

2. **Completion is not safe to repeat.** Each registration creates a new resource UUID. Replaying the same completed Blob creates multiple resources. A lost response followed by retry can therefore duplicate a file record. Two rows can then reference one object, complicating deletion. Evidence: `server/routes/resources.ts:299` and absence of a unique upload identity in the resource schema.

3. **The browser is the sole registrar.** `onUploadCompleted` does nothing. If the transfer completes but the browser closes or loses its session before registration, the Blob has no resource row. There is no persisted upload session to reconcile it later. The complete backup follows database file references, so an unregistered object is outside that recovery path. Evidence: `server/routes/uploads.ts:51`, `server/services/portableBackup.ts`.

4. **The critical path includes a second full-file transfer.** Before acknowledging the resource, the API downloads the entire Blob, even though the immediate signature check reads only its header. This creates a second waiting period after browser transfer reaches 100%. The parser later uses the downloaded temporary file, so it is useful work, but it belongs in durable processing rather than registration. Evidence: `server/routes/resources.ts:291`, `server/services/fileStorage.ts:50`.

5. **Cloud indexing differs substantially from local indexing.** Local startup processes ten embedding jobs every 30 seconds. The Vercel entry imports only `createApp()` and starts no interval worker. The checked-in maintenance cron runs once daily and processes ten jobs. There is also a manual processing endpoint, but upload registration does not invoke it. A document with 100 new chunks requires at least ten successful scheduled batches if there are no other triggers or competing jobs. This is a repository configuration finding, not a measurement of the active deployment. Evidence: `server/index.ts:82`, `api/index.ts`, `server/services/maintenance.ts:28`, `vercel.json:18`.

6. **Extraction has no durable job or persisted result state.** It is launched through `waitUntil`; parse failure and empty extraction both return `null`. No document status distinguishes queued, processing, scanned-only, corrupt, or failed extraction. Vercel documents that `waitUntil` shares the function timeout; the configured function duration here is 300 seconds. A timeout can interrupt processing with no extraction job to resume. Evidence: `server/utils/background.ts`, `server/services/chunkPipeline.ts:61`, `vercel.json:8`. [Vercel waitUntil behavior](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil).

7. **The interface loses file identity.** Cloud URLs are `/api/resources/blob/<uuid>`, but Library previews require an extension in that URL. The resource schema does not retain the original filename, MIME type, and byte size as dedicated file metadata. The saved title strips the extension, and the download response uses that title. A successfully stored file can consequently lack a Preview action or a useful download filename. Evidence: `src/views/ResourcesView.tsx:45`, `src/views/ResourcesView.tsx:135`, `server/routes/resources.ts:304`, `server/routes/resources.ts:402`.

8. **Processing feedback can freeze or mislead.** The semantic panel stops polling when there are zero chunks, including while initial extraction is still running. If chunks exist but embedding jobs permanently fail, it can continue showing “indexing” without exposing the job error. Evidence: `src/components/resource-profile/SemanticIndexPanel.tsx:31`.

9. **Storage, format, and library limits are not modeled together.** The usage page measures local upload directories, which do not represent private Blob usage in Vercel. The Library fetches only the first page of an endpoint capped at 500 rows. Text extraction has no OCR path and does not parse DOCX. These need explicit user-visible states and pagination, rather than another generic upload error. Evidence: `server/services/usageMetrics.ts:142`, `server/routes/resources.ts:158`, `src/api/hooks.ts`, `server/services/chunkPipeline.ts`.

The embedding queue's leases and transactional chunk writes are useful foundations. The private archive backup also verifies its uploaded bytes by reading them back. Preserve these behaviors during restructuring.

## Failure probes performed

Three isolated probes used the actual registration handler with mocked database/storage calls and a synthetic local file. All three reproduced their target behaviors:

- Registering the same Blob twice returned different resource IDs and performed two resource inserts.
- Forcing the attachment insert to fail left the resource insert unrolled back and invoked Blob deletion.
- Holding the materialization promise prevented any resource insert or success response until the complete download was released.

The scratch probes are in `tmp/upload-architecture-audit.test.ts`, with a dedicated config. They demonstrate existing defects; they are not acceptance tests for a repaired implementation. They made no database or Blob network calls. The previous eleven tests cover the local uploader patch and do not validate the full cloud lifecycle.

## Target lifecycle

1. **Create an upload intent.** Before transfer, the authenticated API allocates a stable upload/file ID and exact allowed object path. Store original filename, expected MIME type and size, attachment target, expiry, and a unique client request key. Validate the target now. Repeating this request returns the same intent.
2. **Transfer directly to private Blob.** Issue a token bound to that intent. The browser displays byte progress. Keep the current application size limit initially; increasing it should follow measured worker and mobile testing.
3. **Finalize through one shared service.** Both the verified Blob callback and browser completion call the same idempotent finalizer. Match the object to the recorded intent and verify metadata. In one PostgreSQL transaction, confirm the file/resource relationship, create the intended attachment, and record processing work. Duplicate callbacks return the existing result.
4. **Acknowledge durable receipt quickly.** Do not download or parse the entire file in this transaction. Return the stable resource ID and a truthful state such as “Uploaded · checking file.” Treat the object as unvalidated until the worker completes content checks; do not expose arbitrary unvalidated content inline.
5. **Run durable stages.** Validate signature and content, extract text or OCR, write a complete chunk generation, embed bounded batches, then optionally summarize. Persist attempts, stage, error, retry time, and source version. Failure of summarization or indexing must not discard the original file. Reprocessing reuses stored bytes.
6. **Serve status from PostgreSQL.** Refreshing or opening the app on a second device returns the same status. Poll active jobs, including jobs with zero chunks, with backoff. Stop at an explicit terminal state. Transfer percentage, file availability, and search readiness are separate facts.
7. **Reconcile and recover.** Periodically find expired intents, completed objects awaiting finalization, unpublished processing events, expired worker leases, and missing referenced files. Cleanup must verify that an object is owned by an expired intent and unreferenced before deleting it, with a retention window.

Use a transactional outbox: save an event row with the database changes, then dispatch it to the durable coordinator. A scheduled reconciler retries undispatched events. Calling an external job API only after a database commit leaves a failure window unless that event is recoverable. Coordinator retries still require idempotent database writes; they cannot make Blob and PostgreSQL one atomic transaction.

## Minimum data and API changes

| Record | Purpose |
| --- | --- |
| Existing `resources` | Preserve the current IDs, titles, reading state, relationships, and citations. |
| `resource_files` | Stable upload ID; resource ID; exact Blob path; original name; expected/actual MIME and size; checksum; transfer/validation state; upload request key and expiry. This can hold the upload intent before a file is complete. |
| `resource_processing_jobs` | File/version, processing stage, status, attempts, lease/heartbeat, next attempt, last error, and parser/pipeline version. |
| `outbox_events` | Durable dispatch intent, unique event identity, delivery attempts, and delivery status. |
| Existing chunks/embeddings | Retain their model and citation roles; bind new generations to a file version and prevent overlapping processing of the same version. |

Suggested API responsibilities: `POST /api/resource-uploads` creates/reuses an intent; the existing upload-token route authorizes its exact path; `POST /api/resource-uploads/:id/complete` finalizes; `GET /api/resources/:id/processing` returns status; `POST /api/resources/:id/reprocess` queues work without retransferring the file; a file-access endpoint authorizes viewing/downloading by resource ID.

Persist original filename and MIME metadata and use those to select the viewer. For delivery, either retain an authenticated streaming route with correct headers, range handling, and error handling, or mint a short-lived signed GET URL after access checks. The project already uses the latter pattern for backup downloads. Review the blanket `X-Frame-Options: DENY` header against the iframe PDF viewer in staging. [Vercel private delivery](https://vercel.com/docs/vercel-blob/private-storage), [signed URLs](https://vercel.com/docs/vercel-blob/vercel-signed-urls).

## Open-source projects and official patterns worth using

| Project | Relevant pattern and fit | Boundary |
| --- | --- | --- |
| [Paperless-ngx upload source](https://github.com/paperless-ngx/paperless-ngx/blob/dev/src/documents/views.py) and [worker tasks](https://github.com/paperless-ngx/paperless-ngx/blob/dev/src/documents/tasks.py) | The upload endpoint queues document consumption and returns a task ID. Its document/task separation is the most relevant architectural reference. | Learn from its lifecycle; adopting its entire Django/Celery application would be a separate product migration. |
| [Uppy](https://github.com/transloadit/uppy), [React headless UI](https://uppy.io/docs/react/) | Shared queue, per-file state, progress, retry, and accessible React building blocks while keeping a custom design. | Integrate with the Blob SDK through an adapter. Uppy/tus resumability needs a compatible tus backend; it is not automatically provided by connecting a file picker to Blob. |
| [Inngest](https://github.com/inngest/inngest), [Express integration](https://www.inngest.com/docs/learn/serving-inngest-functions) | Practical coordinator for bounded TypeScript processing stages with retries and persisted execution. Fits the existing Express API. | Hosting limits still constrain individual steps. The SDK is Apache-2.0; the server has SSPL/DOSP terms, so do not describe the whole offering as uniformly permissive open source. |
| [Vercel Workflow SDK](https://github.com/vercel/workflow), [Vercel Workflows](https://vercel.com/docs/workflows) | Native alternative for persisted workflow state and step retries across crashes/deployments. | Verify the custom Express/esbuild deployment integration and plan limits in staging before choosing it. It does not make every individual parsing step unlimited. |
| [Trigger.dev](https://github.com/triggerdotdev/trigger.dev) | Alternative worker platform for jobs that need dedicated compute and system packages, including Python. Supports retries, queues, and observability. | A different execution platform to operate or pay for. Consider it when heavy parsing is part of the initial scope, rather than adding it alongside another coordinator by default. |
| [Docling](https://github.com/docling-project/docling) | Extracts layout-aware document content, supports Office formats, and provides OCR for scans. | Run on an appropriately sized worker. Benchmark actual PDFs, Arabic/English scans, tables, and Word files. Code is MIT; model assets have their own licenses. |
| [pg-boss](https://github.com/timgit/pg-boss) | PostgreSQL-backed queue to consider if a persistent worker is chosen and minimizing additional infrastructure is the priority. | It needs a worker execution environment; adding a queue package alone does not make the Vercel daily cron drain work continuously. |

Vercel's Blob SDK already provides multipart transfer and retries of failed parts. Keep that transport unless actual requirements call for resumable uploads across browser restarts; do not equate multipart retries with guaranteed cross-session resume. [Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk).

## Rollout and acceptance

First restore authorized live access and inventory the active release, schema, Blob references, file counts/bytes, queue backlog, errors, and latest verified backup. Do not treat the local database as production truth.

Before schema/data changes, create and verify a current private cloud backup, keep a local recovery copy where practical, and test restoration against a disposable database. Extend backup file discovery to cover the new file records before relying on them. Preserve old IDs and Blob objects; backfill metadata additively from existing references. Keep compatibility reads during transition and report missing originals instead of deleting their records.

Implement in this order: transactional/idempotent registration and server completion; persistent file metadata; durable dispatch and processing; status/preview corrections; optional broader parsing and upload-queue library. The earlier UI patch can remain as interim feedback but does not satisfy these acceptance conditions:

- Closing the browser after transfer does not lose the registered file.
- Repeating callback or completion requests creates one file/resource/job set.
- Database attachment failure does not leave a live resource pointing at a deleted original.
- Killing a worker mid-extraction or mid-embedding resumes safely and preserves the last good index.
- Lost dispatch and expired leases are recovered automatically.
- Scanned, encrypted, corrupt, empty, and unsupported files receive distinct, persistent outcomes.
- The original is downloadable even if later AI indexing fails, once file validation succeeds.
- Retrying processing never requires uploading the original again.
- Desktop and phone show the same state after refresh, with compact controls and usable touch targets.
- More than 500 resources remain accessible through pagination/search.
- Cloud usage reflects stored objects, and a verified backup restores original files and their relationships.

Measure time to upload, time from Blob completion to durable receipt, extraction time, indexing time, queue age, attempts, and error stage separately. Record the upload ID across logs and job events without logging file contents or signed URLs. Establish service targets from representative staging workloads; there is not yet evidence for a promised production speedup.
