# Google Drive resources

Marina stores original resources in the connected user's Google Drive. Neon keeps resource metadata, processing jobs, extracted passages, and pgvector embeddings. Chat searches this persisted index and cites the matching passages; it does not download the entire Drive on each question.

## Current rollout

On October 2, 2026, the Vercel CLI login was renewed and Marina project access verified. Production is linked to GitHub `Abkob/Marina`, branch `main`. The Google project is **Marina Drive** (`marina-drive`), with Drive, Calendar, and Tasks APIs enabled. The web client's credentials were updated in Vercel as **sensitive** variables; a missing readable `value` is not evidence that a setting is absent. Actual OAuth consent still needs a live connection check. The Inngest Vercel integration is connected to only Marina on **Hobby (Free)**, with event/signing keys installed for Production and Preview.

Migrations M-028 and M-029 were applied to the production database using credentials retrieved from the linked Vercel project's production environment. Existing resource IDs, titles, URLs, and file references were checked before and after and preserved. No seed data was applied. Commit `1fffe4e` deployed successfully to the production alias. Inngest automatically registered both functions, and recovery run `01M3WXDM40X47KQCAA1V3DGA20` completed successfully with the ten-minute schedule. Unsigned `/api/inngest` requests return 401 by design; the signed coordinator requests succeed.

The first live upload saved its original and triggered Inngest, but PDF extraction reported a parser error. The saved 210-page PDF parsed locally. The follow-up explicitly loads and packages the bundled PDF worker and canvas support, distinguishes runtime failures from corrupt documents, and exercises real PDF extraction during deployment readiness checks. Subsequent safe diagnostics identified SQLSTATE `22021`: the extracted text contained 65 NUL glyphs. Chunk sanitization now replaces NULs with spaces before database persistence, preserving original file bytes and page mapping. Retrying the existing resource does not require another upload.

Google Drive is now connected and live file listing succeeded. Google Tasks + Calendar is connected to the same account, and its first sync completed on October 2 at 00:01:02 UTC without a recorded error. A live Drive upload reached Ready for AI with 76 passages and 76 embeddings; a deployed chat answer cited the document's Drive URL and page 7. The PDF uploaded before Drive was connected remains safely in private Blob storage, with 412 extracted passages and embedding still in progress. Google OAuth remains in Testing; publishing is blocked on incomplete Branding configuration, so refresh tokens are still subject to Google's seven-day testing expiry.

Before migrating, a fresh private cloud backup was written, read back, and verified against a local recovery copy:

- Archive: `marina-complete-before-drive-2026-10-01T22-18-02.805Z.marina-backup.zip`.
- SHA-256: `645b0b36dca15e6bafaf8d39f93d7b69febdf68ed53d0a77a9ccb24b5cbe8761`.
- 44 source tables, 2,592 rows, zero uploaded originals referenced.
- Local archive entry checksums verified; matching private cloud verification receipt retained. Recovery files are ignored by Git.

A second backup was verified immediately before deployment: `marina-complete-before-drive-2026-10-01T23-29-11.600Z.marina-backup.zip`, SHA-256 `bd251a8b0b2045099d8f8a931dbb5eac7621358b655b633e35a66af9d1d83e22`. It contains 51 tables, 2,594 rows, and zero referenced originals. Private cloud read-back and local archive entry checksums both passed.

After the first live upload, `marina-complete-before-drive-2026-10-01T23-43-54.697Z.marina-backup.zip` was verified in private cloud storage and locally, including the original PDF: 51 tables, 2,598 rows, one file, SHA-256 `9ac6e332577b555f67467260f70484e109e5fb3e92fe37bf23a386e607920425`.

The latest checkpoint before the NUL-glyph repair is `marina-complete-before-drive-2026-10-02T00-03-35.029Z.marina-backup.zip`: 51 tables, 2,600 rows, one original, SHA-256 `cb6fe7ead5c2304c81c811326bbaf307fffa0d8eefefb613efdb70a18e7ed2b8`. Private cloud read-back and local entry checksums passed.

## Connection and deployment

1. Use **Web client 1** in the **Marina Drive** (`marina-drive`) Google project. Enable the Drive, Calendar, and Tasks APIs and retain the exact redirect URI `https://marina-demol1sin.vercel.app/api/google/oauth/callback`. Drive connection requests `openid`, `email`, `drive.file`, and `drive.readonly`. The latter allows choosing existing files outside the app's folder. The separate Tasks + Calendar connection uses `tasks` and `calendar.app.created`. Never make the Drive public. A personal OAuth app in Testing can have short-lived refresh credentials; configure its audience/publishing status appropriately before relying on unattended sync. Public distribution requires reviewing Google's scope verification requirements.
2. Keep `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, `GOOGLE_OAUTH_STATE_SECRET`, and `APP_URL` configured. Encryption/state keys must contain at least 32 characters. Reuse the current encryption key; replacing it invalidates saved encrypted Google connections. Calendar and Drive share the client but maintain separate encrypted refresh-token records.
3. Connect an Inngest account to **only Marina** using its Vercel integration. This installs `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` and syncs deployments. The custom served endpoint is `/api/inngest`; confirm that path in the integration. `INNGEST_DEV=1` only enables a local coordinator and is not a production replacement.
4. For another environment, create a current verified backup before `CONFIRM_RESOURCE_SCHEMA_APPLY=1 npm run db:deploy-resources -- <local-recovery-archive>`. The script validates archive integrity, age, cloud receipt, and database name, then applies only the additive M-028/M-029 migrations. Select the correct project/environment beforehand; a matching database name alone cannot identify a Neon branch.
5. Run the deployment readiness check in Vercel, deploy, and verify both `process-resource-stage` and `recover-resource-work` are registered with Inngest. Keep deployment protection enabled where possible and use its supported automation bypass if required by the integration.
6. In Resource Library, expand Google Drive and connect the account holding the originals. Import one existing document and upload one small text file and one PDF. Verify Drive storage, ready status, citations, original preview/download, retry behavior, and a detected edit. Complete this live smoke test before declaring rollout complete.

Production builds fail before release if required settings or columns are absent. A successful Git push does not prove deployment or background worker registration.

## Upload, indexing, retrieval, and recovery

- New uploads reserve a database intent and an immutable Drive file ID before bytes are sent. The browser sends 2 MiB chunks, within Vercel's request limit, through authenticated API endpoints. Drive's resumable session URI is encrypted and remains on the server. A lost response is recovered by querying the acknowledged offset; completion is idempotent and transactional with attachments, the processing job, and its outbox entry.
- The first new upload creates or reuses a private `Marina Resources` folder. Existing Drive imports remain in their original folders. Concurrent imports of the same Drive ID produce one library resource. Deleting a resource from Marina leaves the Drive original intact.
- Processing validates the actual stored content, extracts text, and embeds bounded batches. Saved and Ready for AI are distinct states. Invalid files, missing permissions, no text, and provider outages stay visible and retryable where appropriate. Drive account disconnection does not silently redirect future uploads into a different provider.
- Google Docs, Sheets, and Slides are exported as PDF. Binary uploads support PDF, UTF-8 TXT/MD/CSV, and supported images, up to 50 MiB per file. Word files must be exported to PDF. Google applies its own native-document export limits. Images and scanned PDFs require OCR, which this release does not supply; saving an image does not mean it is searchable.
- Chat's `search_documents` tool combines lexical retrieval with pgvector similarity and merges duplicate passage IDs. Only ready, valid, visible sources qualify. Results contain source URLs, immutable resource/chunk IDs, page numbers where available, and the last Drive check. Embedding outages fall back to text search and are reported as degraded retrieval. Documents are untrusted source material, never instructions.
- Every ten minutes, the recovery job checks a bounded batch of least-recently-checked Drive resources. Source edits invalidate old embeddings and queue a new generation; revoked access or deleted sources are excluded from retrieval. Temporary API failures preserve the previous index and expose the failed check. This is eventual synchronization, not an instant Google push feed: larger libraries take longer to sweep. Manual sync checks a bounded batch or one selected resource. Chat reads the already-built index without waiting for a complete Drive scan.
- New uploads dispatch processing immediately. Transient processing failures use an Inngest durable sleep until their stored retry time, releasing Vercel while waiting; they do not need to wait for the recovery sweep. The recovery schedule uses five Inngest executions per run (the run plus four steps): 22,320 executions in a 31-day month before retries. Running every minute would exceed the Hobby plan's 50,000 monthly executions while idle. Uploads, retries, and other functions also use that shared allowance; Hobby pauses execution when it is exhausted. Monitor usage as the library grows.
- Existing Blob resources retain their IDs and storage. Private Blob remains necessary for existing files, note attachments, and verified backups. Portable backups include referenced Drive originals but exclude OAuth tokens and resumable upload secrets. A restore materializes backed-up file bytes into the selected destination; reconnect Google separately. Large complete backups can exceed serverless execution limits and require a dedicated backup worker before scaling to tens of gigabytes; do not assume Drive capacity equals backup throughput.

## Validation

The complete unit/component suite passed 949 tests across 105 files. Five additional OAuth redirect cases were added afterward; all 42 affected OAuth, Drive UI, and readiness tests passed, as did 32 chat-tool/catalog tests. The complete real-PostgreSQL suite passed 141 tests across 14 files; after adding import/completion and interrupted-sync cases, all 27 Drive persistence/retrieval tests passed. Provider/storage calls use synthetic mocks, and the database is an isolated local test database.

Coverage includes concurrent session creation/imports, duplicate finalization, metadata mismatch, session expiry, lost responses, OAuth replay/expiry, provider confusion, retry recovery, account disconnection, actual extraction/vector retrieval, citations, transient failures, changed versions, unavailable sources, and original preservation. Phone fixture checks at 358 pixels of content width verified import selection, saved feedback, no horizontal overflow, and 44×44-pixel sync controls. TypeScript, frontend build, serverless import, and static preflight pass. The existing large frontend bundle warning remains.

The October 2 recovery-schedule adjustment passed 82 focused upload lifecycle, readiness, and Drive client tests, TypeScript, and the serverless bundle/import check on Node 24.

The PDF worker fix passed 16 parser/chunk tests and 39 real-PostgreSQL upload integration tests, plus TypeScript and the expanded serverless readiness check. Regression coverage includes actual text, blank pages, password protection, corrupt bytes, missing runtime dependencies, and parser cleanup after failure.

The NUL-glyph regression reproduced production's `22021` against isolated PostgreSQL before the fix. After sanitization, all 40 upload integration tests and 18 parser/chunk tests passed. The regression verifies successful embedding, preserved original bytes, and page citations; Unicode and NUL-only text have focused cases.

Live Drive consent, upload, ready indexing, and a cited chat response have succeeded. The larger PDF's embedding progress and Google OAuth publishing remain follow-ups; synthetic tests cannot guarantee zero defects.

## References

- [Google Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google Drive downloads and native exports](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Google Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Inngest on Vercel](https://www.inngest.com/docs/durable-execution/deploying-functions/platforms/vercel)
- [Inngest execution limits](https://www.inngest.com/docs/durable-execution/limits)
- [PDF parser serverless worker setup](https://github.com/mehmet-kozan/pdf-parse/blob/main/docs/troubleshooting.md)
