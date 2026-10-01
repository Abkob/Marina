# Resource upload implementation and rollout

Initial implementation completed on 2026-10-01. Update on October 2: Vercel management access is restored, M-028/M-029 have been applied after a verified backup, and commit `1fffe4e` is live. Inngest Hobby (Free) is connected to Marina; both functions registered and the scheduled recovery run succeeded. The first uploaded PDF is saved and backed up, but exposed a serverless PDF worker issue addressed by the follow-up fix. Successful indexing and live Google Drive connection still need verification. See [Google Drive resources](google-drive-resources.md) for current rollout evidence; the historical checks below describe the original Blob lifecycle work.

The implementation is prepared for publication to GitHub `main` under the user's Git identity. The Vercel build now starts with a read-only resource readiness check: missing storage/worker credentials or lifecycle schema fail the build before the release can replace the existing deployment. This check never migrates or seeds a database. A GitHub push does not complete the remaining rollout steps.

## Implemented behavior

- File selection creates a persistent `resource_uploads` intent before transfer. Retries reuse its identity and exact immutable Blob path. Concurrent creation, callbacks, and browser completion produce one resource/job set.
- The verified Blob callback and browser use the same transactional finalizer. Resource, attachment, processing job, and outbox event commit together. A database error never deletes the uploaded original. If the attachment target was deleted during transfer, the original is preserved as a standalone library resource. Registration verifies object metadata without downloading the file.
- `resource_processing_jobs` persists extraction/indexing stages, attempts, errors, retry time, leases, and versions. Each invocation handles one extraction or three embedding calls. Expired workers cannot write after a replacement worker claims the job. Provider calls and storage reads have timeouts.
- `resource_outbox` records dispatch in the same database transaction. Inngest runs processing events immediately and recovery every ten minutes. Lost dispatches and expired leases are recovered. Local development uses the same persisted jobs on its existing worker interval.
- File validation gates inline serving. Password-protected, corrupt, empty, and scanned-only PDFs have distinct visible outcomes. Embedding failure preserves the validated original and the last good chunk generation. Retry resumes indexing without uploading again.
- Filename, MIME, byte size, and validation state live on the existing `resources` row. Existing IDs and `file_path` references stay intact. This deliberately simplifies the audit's proposed separate file table: no replacement file-reference model or mandatory bulk backfill is needed.
- Preview eligibility uses metadata; private file delivery supports byte ranges, Unicode filenames, stream errors, and same-origin PDF embedding. Legacy MIME falls back to the stored path. Legacy metadata is recovered when re-indexing.
- Processing status is read from the database and polled even when no chunks exist. Terminal errors stop polling. Library loading failures are visible and retryable. Mobile retry/re-index and file actions retain 44-pixel targets with fewer labels; desktop file actions appear on hover or keyboard focus.
- Library reads use stable cursor pagination beyond 500 rows. Cloud usage reports recorded file sizes, deduplicated by stored reference, and explicitly counts unknown legacy sizes. It is **not** the provider's billed total: backup objects and unrelated/unregistered objects are outside that measure.
- Portable backups include new lifecycle tables, keep original file references portable, and preserve filename/MIME metadata. The file-discovery query remains compatible with the older production schema.

The existing Blob SDK and restrained custom uploader remain. Uppy, Docling, Word parsing, OCR, and additional worker platforms were optional in the design study and were not introduced. Supported uploads remain PDF, UTF-8 TXT/MD/CSV, PNG/JPEG/GIF/WebP, up to 50 MiB per file. Images and scanned-only PDFs are preserved but require OCR before their text can be indexed.

## Verification completed

- Final full unit/component suite: **857 passed across 101 files**, using `vitest run --maxWorkers=4`.
- Final full database integration suite: **116 passed across 13 files**, including **39 upload integration tests**. Both final suites ran on Node **24.19.0**, matching the Vercel major version. One earlier unconstrained parallel unit run timed out in an unrelated TimeView test; the complete suite passed with four workers.
- Before publishing to `main` on October 2, the deployment readiness addition passed TypeScript and **17 focused tests** (13 readiness tests and four Vercel configuration tests). Its read-only check accepted the migrated isolated database and rejected the unchanged cloud schema. It never applied the production migration.
- Coverage includes repeated and concurrent completion, conflicting request keys, object metadata mismatch, missing attachment targets, forced attachment-write rollback, missing storage objects, expired intents, callback recovery, deletion/tombstones, shared legacy references, obsolete events, worker crashes, lost leases, deletion during extraction, retry limits/backoff, outbox delivery failure, local multipart retries, byte ranges, authorization, and backup contents.
- Real PDF parser checks cover text with page citations, blank PDFs, password protection, and corruption. Embedding network calls and Blob objects are mocked in integration tests; no test sends document text to a production provider.
- Browser fixture checks cover an upload failure followed by a successful retry, saved/waiting/failed/ready states, desktop layout, and a 390-pixel phone frame (388-pixel content viewport). No horizontal overflow; mobile processing controls measured 44×44 pixels. The fixture uses synthetic data.
- TypeScript, production build, serverless entry import, and static deployment preflight passed. The build retains the application's existing large-bundle warning.
- Two backups restored into fresh local databases: one with synthetic uploaded originals and processing records, and one from the configured cloud database. Original bytes, file identity, and job relationships verified.
- The additive migration was applied twice to a disposable restored cloud copy with the old resource-column/table layout; existing resource content and IDs remained unchanged.

These checks do not replace production smoke tests or guarantee every possible failure is absent.

## Cloud recovery checkpoint

Verified archive: `marina-complete-before-upload-lifecycle-2026-10-01T20-24-45-104Z.marina-backup.zip`.

- Private archive read back and SHA-256 verified, plus private verification receipt.
- Local recovery copy under `backups/`, with every archive entry checksum verified.
- SHA-256: `241a2c2be4ba874313f95d574a64fd72c23b31b5df26ad256e28a8da041cddb6`.
- 44 source tables, 2,589 rows, no referenced uploaded files. A separate read-only Blob inventory also found zero objects under `marina/resource/` in the configured store.
- This checkpoint is for the repository's configured `.env.local` Neon/Blob connection. Its binding to the currently serving Vercel deployment could not be independently confirmed through the management API. Confirm that binding before rollout and create a new backup if this checkpoint is stale.

Detailed local evidence is in ignored `tmp/resource-cloud-backup-receipt.json`, `tmp/resource-restore-verification.json`, and `tmp/resource-migration-verification.json`. Never commit environment files, backup archives, or restored cloud data.

## Remaining rollout steps

1. Restore access to the linked Marina Vercel project and verify its production branch, active release, database, Blob store, and existing environment. Do not substitute development data.
2. Connect **one** Inngest project/environment. Configure `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` in Vercel. `INNGEST_DEV=1` is for a local dev server only and cannot enable unsigned production execution. Configure the same production AI provider credentials already used by Marina.
3. Test a preview deployment against a separate database/Blob environment and verify signed Inngest invocation. No production database should be attached to automated test suites.
4. Create and verify a current private cloud backup with its local recovery copy. Using the exact production database and Blob environment, run `npm run db:deploy-resources -- <verified-local-archive>` with `CONFIRM_RESOURCE_SCHEMA_APPLY=1`. This applies only M-028 and M-029 in a transaction, after checking archive integrity, age, matching cloud receipt, and database name. It does not seed or replace data. Environment/project binding still must be verified by the operator.
5. Deploy the application, sync `https://<production-host>/api/inngest`, and verify both `process-resource-stage` and `recover-resource-work` are registered. The daily Vercel maintenance cron is a fallback; the Inngest ten-minute schedule is the normal recovery mechanism.
6. Smoke-test a small UTF-8 file and a representative PDF; inspect processing through ready state. Repeat completion, refresh during processing, close the browser after transfer, preview/download including a PDF range request, retry a deliberate indexing failure, and verify desktop/phone status agrees.
7. Confirm the new originals and lifecycle rows appear in a fresh verified backup. Observe queue age, pending outbox events, failed jobs, and the recovery function in the connected coordinator.

For a code rollback, retain the additive schema and all files. Preserve any queued work and restore/redeploy the coordinator when returning to the new application. Do not drop the new tables or restore an older database over ongoing user work.
