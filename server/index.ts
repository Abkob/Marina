import 'dotenv/config';
import { createApp } from './app.js';
import { initSchema } from './db.js';
import { seedIfEmpty } from './seed.js';
import { ensureDefaultSchedulePrefs } from './routes/schedule-prefs.js';
import { processEmbeddingJobs, reclaimExpiredJobs } from './services/embeddingWorker.js';
import { scheduleObsidianVaultSync } from './services/obsidianVaultSync.js';
import { EMBED_DIMENSION, EMBED_MODEL } from './embeddingProvider.js';
import {
  CHAT_HOST,
  CHAT_MODEL_PRIMARY,
  CHAT_MODEL_FALLBACK,
  NVIDIA_FALLBACK_MODEL,
  isCloudChatModel,
} from './config/providers.js';

const PORT = 3001;

/**
 * Process entry point: schema init, seed, HTTP listener, background workers,
 * and graceful shutdown. The Express app itself is built by createApp()
 * (server/app.ts) so tests can mount the exact production app without
 * starting any of this.
 */
async function startServer() {
  try {
    await initSchema();
    await ensureDefaultSchedulePrefs();
    await seedIfEmpty();
    const app = createApp();
    const server = app.listen(PORT, '127.0.0.1', () => {
      console.log(`[server] Marina API running on http://127.0.0.1:${PORT}`);
      const rawDbUrl = process.env.DATABASE_URL ?? '';
      let dbDisplay = 'localhost:5432/marina';
      try {
        if (rawDbUrl) {
          const u = new URL(rawDbUrl);
          dbDisplay = `${u.hostname}:${u.port || 5432}${u.pathname}`;
        }
      } catch { /* malformed url */ }
      console.log(`[server] Database: PostgreSQL (${dbDisplay})`);
      // Log the RESOLVED provider config (config/providers.ts), not raw env
      // vars — the old line read OLLAMA_MODEL with a stale default and lied.
      console.log(
        `[server] Chat: ${CHAT_MODEL_PRIMARY}${isCloudChatModel(CHAT_MODEL_PRIMARY) ? ' (cloud)' : ''}` +
        (process.env.NVIDIA_API_KEY && NVIDIA_FALLBACK_MODEL !== CHAT_MODEL_PRIMARY
          ? ` Â· fallback ${NVIDIA_FALLBACK_MODEL} (NVIDIA cloud)`
          : '') +
        (CHAT_MODEL_FALLBACK
          ? ` · fallback ${CHAT_MODEL_FALLBACK}${isCloudChatModel(CHAT_MODEL_FALLBACK) ? ' (cloud)' : ' (local)'}`
          : '') +
        (CHAT_MODEL_FALLBACK || !isCloudChatModel(CHAT_MODEL_PRIMARY) ? ` · via ${CHAT_HOST}` : ''),
      );
      console.log(`[server] Embeddings: ${EMBED_MODEL} (${EMBED_DIMENSION} dimensions)`);
      const vault = scheduleObsidianVaultSync('startup');
      if (vault.enabled) console.log(`[obsidian-vault] sync enabled: ${vault.vault_dir}`);

      // Reclaim any 'processing' jobs left by a prior crash
      reclaimExpiredJobs().then(n => {
        if (n > 0) console.log(`[embedding-worker] reclaimed ${n} expired lease(s) on startup`);
      }).catch(err => console.error('[embedding-worker] reclaim error on startup:', err));

      // Reclaim journal entries stuck in 'processing' from a prior crash.
      // Journals that stayed in processing past 15 minutes are assumed crashed.
      (async () => {
        try {
          const { query: dbQuery } = await import('./db.js');
          const { rowCount } = await dbQuery(
            `UPDATE journal_entries
             SET ingestion_status='pending', ingestion_attempts=LEAST(ingestion_attempts, 2)
             WHERE ingestion_status='processing'
               AND updated_at < (NOW() - INTERVAL '15 minutes')::TEXT`,
          );
          if (rowCount && rowCount > 0) {
            console.log(`[journal] reclaimed ${rowCount} stuck processing journal(s) on startup`);
          }
        } catch { /* non-fatal — table may not exist on first run */ }
      })();

      // Auto-process embedding jobs every 30 seconds.
      // Guard prevents overlapping ticks if a batch takes longer than 30s.
      let workerRunning = false;
      const workerInterval = setInterval(async () => {
        if (workerRunning) return;
        workerRunning = true;
        try {
          const reclaimed = await reclaimExpiredJobs();
          if (reclaimed > 0) console.log(`[embedding-worker] reclaimed ${reclaimed} expired lease(s)`);
          const { processed, failed } = await processEmbeddingJobs(10);
          if (processed > 0 || failed > 0) {
            console.log(`[embedding-worker] processed=${processed} failed=${failed}`);
          }
        } catch (err) {
          console.error('[embedding-worker] error:', err);
        } finally {
          workerRunning = false;
        }
      }, 30_000);
      console.log('[embedding-worker] started, interval=30s, lease_timeout=10min');

      // End-of-day capture rollup: yesterday's un-journaled wall notes become
      // one journal entry per day (hourly check; idempotent).
      const rollupTick = async () => {
        try {
          const { rollupCaptureWalls } = await import('./routes/journal.js');
          const n = await rollupCaptureWalls();
          if (n > 0) console.log(`[capture-rollup] bound ${n} day wall(s) into the journal`);
        } catch (err) {
          console.error('[capture-rollup] failed:', (err as Error).message);
        }
      };
      setTimeout(rollupTick, 90_000);
      setInterval(rollupTick, 60 * 60_000).unref?.();

      // Daily automatic backup (skipped in test mode). Rotation keeps the
      // newest MARINA_BACKUP_KEEP (default 14).
      const backupTick = async () => {
        try {
          const { createBackup, rotateBackups } = await import('./routes/backups.js');
          const r = await createBackup('auto');
          const rotated = rotateBackups();
          console.log(`[backup] auto backup ${r.file} (${Math.round(r.bytes / 1024)} KB)${rotated ? `, rotated ${rotated} old` : ''}`);
        } catch (err) {
          console.error('[backup] auto backup failed:', (err as Error).message);
        }
      };
      if (process.env.NODE_ENV !== 'test' && process.env.MARINA_AUTO_BACKUP !== 'false') {
        setTimeout(backupTick, 60_000);                       // first backup 1min after boot
        setInterval(backupTick, 24 * 60 * 60_000).unref?.();  // then daily
        console.log('[backup] auto-backup enabled (daily, keep last ' + (process.env.MARINA_BACKUP_KEEP ?? 14) + ')');
      }

      // Auto-retry failed journal entries every 5 minutes (max 3 attempts).
      // Entries exceeding 3 attempts are set to 'needs_review' during ingestion.
      let journalRetryRunning = false;
      const journalRetryInterval = setInterval(async () => {
        if (journalRetryRunning) return;
        journalRetryRunning = true;
        try {
          const { query: dbQ } = await import('./db.js');
          // 'failed' → bounded retries; stale 'pending' → crash recovery for
          // entries whose fire-and-forget ingestion never ran (e.g. the server
          // died right after the journal row committed).
          const { rows: failed } = await dbQ<{ id: string }>(
            `SELECT id FROM journal_entries
             WHERE (ingestion_status = 'failed' AND ingestion_attempts < 3)
                OR (ingestion_status = 'pending'
                    AND ingestion_attempts < 3
                    AND updated_at < (NOW() - INTERVAL '10 minutes')::TEXT)
             ORDER BY updated_at ASC
             LIMIT 3`,
          );
          if (failed.length) {
            const { ingestJournalEntry } = await import('./routes/journal.js');
            // Mark as pending so ingestJournalEntry's claim guard will pick them up
            await dbQ(
              `UPDATE journal_entries SET ingestion_status='pending', updated_at=$1 WHERE id = ANY($2)`,
              [new Date().toISOString(), failed.map(r => r.id)],
            );
            for (const { id } of failed) {
              ingestJournalEntry(id).catch(err => console.error(`[journal-retry] ${id}:`, err));
            }
            console.log(`[journal-retry] queued ${failed.length} failed journal(s) for retry`);
          }
        } catch (err) {
          console.error('[journal-retry] error:', err);
        } finally {
          journalRetryRunning = false;
        }
      }, 5 * 60_000);
      console.log('[journal-retry] started, interval=5min');

      // Graceful shutdown — stop worker, drain HTTP, close DB pool
      const shutdown = (signal: string) => {
        console.log(`[server] ${signal} received — shutting down gracefully`);
        clearInterval(workerInterval);
        clearInterval(journalRetryInterval);
        server.close(async () => {
          console.log('[server] HTTP server closed');
          try {
            const { pool } = await import('./db.js');
            await pool.end();
            console.log('[server] DB pool closed');
          } catch { /* non-fatal if pool already drained */ }
          process.exit(0);
        });
        setTimeout(() => {
          console.error('[server] Forced shutdown after 10s drain window');
          process.exit(1);
        }, 10_000).unref();
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('uncaughtException', (err) => {
        console.error('[server] Uncaught exception:', err);
        shutdown('uncaughtException');
      });
      process.on('unhandledRejection', (reason) => {
        console.error('[server] Unhandled rejection:', reason);
        shutdown('unhandledRejection');
      });
    });
  } catch (err) {
    console.error('[server] Startup failed:', err);
    process.exit(1);
  }
}

startServer();
