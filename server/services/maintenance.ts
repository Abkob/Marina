import { processEmbeddingJobs, reclaimExpiredJobs } from './embeddingWorker.js';
import { query } from '../db.js';

export async function retryPendingJournalEntries(limit = 3): Promise<number> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM journal_entries
     WHERE (ingestion_status = 'failed' AND ingestion_attempts < 3)
        OR (ingestion_status = 'pending'
            AND ingestion_attempts < 3
            AND updated_at < (NOW() - INTERVAL '10 minutes')::TEXT)
     ORDER BY updated_at ASC
     LIMIT $1`,
    [limit],
  );
  if (!rows.length) return 0;

  await query(
    `UPDATE journal_entries SET ingestion_status='pending', updated_at=$1 WHERE id = ANY($2)`,
    [new Date().toISOString(), rows.map(row => row.id)],
  );
  const { ingestJournalEntry } = await import('../routes/journal.js');
  for (const { id } of rows) await ingestJournalEntry(id);
  return rows.length;
}

export async function runMaintenance() {
  const reclaimed = await reclaimExpiredJobs();
  const embeddings = await processEmbeddingJobs(10);
  const retried_journals = await retryPendingJournalEntries();
  const { rollupCaptureWalls } = await import('../routes/journal.js');
  const capture_rollups = await rollupCaptureWalls();
  return { reclaimed, embeddings, retried_journals, capture_rollups };
}
