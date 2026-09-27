import 'dotenv/config';
import 'express-async-errors';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { goalsRouter } from './routes/goals.js';
import { tasksRouter } from './routes/tasks.js';
import { notesRouter } from './routes/notes.js';
import { eventsRouter } from './routes/events.js';
import { resourcesRouter } from './routes/resources.js';
import { edgesRouter } from './routes/edges.js';
import { agentRunsRouter } from './routes/agent-runs.js';
import { filesRouter } from './routes/files.js';
import { meetingsRouter } from './routes/meetings.js';
import { aiRouter } from './routes/ai.js';
import { deadlinesRouter } from './routes/deadlines.js';
import { milestonesRouter } from './routes/milestones.js';
import { schedulePrefsRouter } from './routes/schedule-prefs.js';
import { workSessionsRouter } from './routes/work-sessions.js';
import { routinesRouter } from './routes/routines.js';
import { eventTaskLinksRouter } from './routes/event-task-links.js';
import { journalRouter } from './routes/journal.js';
import { embeddingsRouter } from './routes/embeddings.js';
import { graphRouter } from './routes/graph.js';
import { aliasesRouter } from './routes/aliases.js';
import { searchRouter } from './routes/search.js';
import { topicsRouter } from './routes/topics.js';
import { backupsRouter } from './routes/backups.js';
import { databaseAtlasRouter } from './routes/database-atlas.js';
import { obsidianVaultRouter } from './routes/obsidian-vault.js';
import { researchRouter } from './routes/research.js';
import { orchestratorRouter } from './routes/orchestrator.js';
import { usageRouter } from './routes/usage.js';
import { authRouter } from './routes/auth.js';
import { cronRouter } from './routes/cron.js';
import { uploadsRouter } from './routes/uploads.js';
import { googleWorkspaceOauthRouter, googleWorkspaceRouter } from './routes/google-workspace.js';
import { EMBED_DIMENSION, EMBED_MODEL } from './embeddingProvider.js';
import { getProviderSummary, isNvidiaChatModel } from './config/providers.js';
import { scheduleObsidianVaultSync, shouldSyncObsidianVaultForRequest } from './services/obsidianVaultSync.js';
import { requireApiAuth } from './utils/auth.js';
import { isVercelRuntime, runtimeCapabilities } from './runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_DIR = path.join(__dirname, 'uploads');

/**
 * Builds the exact production Express application: middleware, all routes,
 * and the centralized error handler. Importing/calling this NEVER starts
 * listeners, background workers, or schema initialization — that lives in
 * startServer() (server/index.ts). Integration tests must use this app.
 */
export function createApp(): express.Express {
  const app = express();

  const allowedOrigins = new Set([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    process.env.APP_URL,
  ].filter((value): value is string => Boolean(value)));
  app.use(cors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
    credentials: true,
  }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  // Vercel Functions reject request bodies above 4.5 MB. File uploads use
  // direct-to-Blob tokens, so leave a small margin for JSON/API overhead.
  app.use(express.json({ limit: isVercelRuntime ? '4mb' : '10mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/google/oauth', googleWorkspaceOauthRouter);
  // The Blob completion callback has no browser cookie. This router performs
  // authentication internally for token issuance and lets the SDK validate callbacks.
  app.use('/api/uploads', uploadsRouter);
  app.get('/api/health/live', (_req, res) => {
    res.json({ status: 'ok', runtime: runtimeCapabilities().runtime, timestamp: new Date().toISOString() });
  });
  app.use('/api', requireApiAuth);
  app.use('/api/cron', cronRouter);
  app.get('/api/runtime', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(runtimeCapabilities());
  });
  app.use((req, res, next) => {
    const shouldSync = shouldSyncObsidianVaultForRequest(req.method, req.path);
    if (shouldSync) {
      res.on('finish', () => {
        if (res.statusCode < 400) {
          scheduleObsidianVaultSync(`${req.method} ${req.path}`);
        }
      });
    }
    next();
  });

  app.use('/api/goals', goalsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/notes', notesRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/resources', resourcesRouter);
  app.use('/api/edges', edgesRouter);
  app.use('/api/agent-runs', agentRunsRouter);
  app.use('/api/task-note-files', filesRouter);
  app.use('/api/meetings', meetingsRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/goal-deadlines', deadlinesRouter);
  app.use('/api/milestones', milestonesRouter);
  app.use('/api/schedule-prefs', schedulePrefsRouter);
  app.use('/api/work-sessions', workSessionsRouter);
  app.use('/api/routines', routinesRouter);
  app.use('/api/event-task-links', eventTaskLinksRouter);
  app.use('/api/journal', journalRouter);
  app.use('/api/embeddings', embeddingsRouter);
  app.use('/api/graph', graphRouter);
  app.use('/api/entity-aliases', aliasesRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/topics', topicsRouter);
  app.use('/api/backups', backupsRouter);
  app.use('/api/database-atlas', databaseAtlasRouter);
  app.use('/api/obsidian-vault', obsidianVaultRouter);
  app.use('/api/research', researchRouter);
  app.use('/api/orchestrator', orchestratorRouter);
  app.use('/api/usage', usageRouter);
  app.use('/api/google', googleWorkspaceRouter);

  // POST /api/entity-summaries/backfill — generate deterministic planning summaries for all entities missing them
  app.post('/api/entity-summaries/backfill', async (_req, res) => {
    const { generateDeterministicSummaries } = await import('./services/summaryGenerator.js');
    const tables: Record<string, string> = { goal: 'goals', task: 'tasks', milestone: 'goal_milestones', resource: 'resources', meeting: 'meetings' };
    let queued = 0, skipped = 0;
    for (const [type, table] of Object.entries(tables)) {
      const { query } = await import('./db.js');
      const { rows } = await query(
        `SELECT t.id FROM ${table} t
         LEFT JOIN entity_summaries es ON es.entity_type=$1 AND es.entity_id=t.id AND es.summary_type='planning' AND es.summary_model='deterministic'
         WHERE es.id IS NULL`,
        [type],
      );
      for (const row of rows as { id: string }[]) {
        try {
          await generateDeterministicSummaries(type, row.id);
          queued++;
        } catch { skipped++; }
      }
    }
    res.json({ queued, skipped });
  });

  // GET /api/health/ready — readiness check: DB connectivity + configured model availability
  app.get('/api/health/ready', async (_req, res) => {
    let db: 'connected' | 'error' = 'error';
    try {
      const { query } = await import('./db.js');
      await query('SELECT 1');
      db = 'connected';
    } catch { /* db unreachable */ }

    const { validateChatModels, getChatCooldownStatus } = await import('./ollama.js');
    const models = await validateChatModels();
    const chatCooldown = getChatCooldownStatus();
    const warnings: string[] = [];
    if (!models.reachable) warnings.push('Ollama is unreachable — chat is unavailable');
    if (models.primary.status === 'missing') warnings.push(`Configured primary model "${models.primary.model}" is not installed`);
    if (models.fallback?.status === 'missing') warnings.push(`Configured fallback model "${models.fallback.model}" is not installed`);
    if (models.primary.status === 'cloud') {
      const provider = models.primary.model.startsWith('gemini-')
        ? 'Gemini API'
        : isNvidiaChatModel(models.primary.model)
          ? 'NVIDIA Build API'
          : 'Ollama cloud';
      warnings.push(`Primary model "${models.primary.model}" runs via ${provider} — prompts leave this machine`);
    }

    if (chatCooldown.active) {
      warnings.push(`Primary model "${models.primary.model}" is temporarily rate-limited until ${chatCooldown.until}`);
    }

    if (db !== 'connected') {
      return res.status(503).json({ status: 'not_ready', db, models, warnings, timestamp: new Date().toISOString() });
    }
    const status = warnings.some(w => w.includes('not installed') || w.includes('unreachable')) ? 'degraded' : 'ready';
    res.json({
      status,
      db,
      models: {
        primary: models.primary,
        nvidia_fallback: models.nvidia_fallback,
        fallback: models.fallback,
        available: models.available,
        reachable: models.reachable,
      },
      chat_cooldown: chatCooldown,
      warnings,
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/health — liveness + DB + Ollama connectivity check
  app.get('/api/health', async (_req, res) => {
    const ts = new Date().toISOString();
    let db: 'connected' | 'error' = 'error';
    let queueStats: Record<string, number> = {};
    let ollama: 'ok' | 'unavailable' = 'unavailable';

    let schemaVersion: string | null = null;
    let migrationCount = 0;
    try {
      const { query } = await import('./db.js');
      await query('SELECT 1');
      db = 'connected';
      const { rows } = await query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::int as count FROM embedding_jobs GROUP BY status`,
      );
      for (const r of rows) queueStats[r.status] = Number(r.count);
      // Schema version: latest applied migration name + count
      try {
        const mv = await query<{ name: string; applied_at: string }>(
          `SELECT name, applied_at FROM schema_migrations ORDER BY applied_at DESC, name DESC LIMIT 1`,
        );
        if (mv.rows.length) {
          schemaVersion = mv.rows[0].name;
          const mc = await query<{ count: string }>(`SELECT COUNT(*)::int as count FROM schema_migrations`);
          migrationCount = Number(mc.rows[0].count);
        }
      } catch { /* schema_migrations may not exist yet on first run */ }
    } catch { /* db error already captured */ }

    // Worker diagnostics: oldest pending age, stuck leases, stale embeddings
    let workerDiagnostics: Record<string, unknown> = {};
    if (db === 'connected') {
      try {
        const { query: q } = await import('./db.js');
        const [{ rows: oldestRows }, { rows: stuckRows }, { rows: staleRows }] = await Promise.all([
          q<{ age_seconds: string }>(`
            SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at::TIMESTAMPTZ)))::int AS age_seconds
            FROM embedding_jobs WHERE status = 'pending'`),
          q<{ count: string }>(`
            SELECT COUNT(*)::int AS count FROM embedding_jobs
            WHERE status = 'processing'
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at::TIMESTAMPTZ < NOW()`),
          q<{ count: string }>(`SELECT COUNT(*)::int AS count FROM embeddings WHERE is_stale = true`),
        ]);
        workerDiagnostics = {
          oldest_pending_seconds: oldestRows[0]?.age_seconds ?? null,
          stuck_leases: Number(stuckRows[0]?.count ?? 0),
          stale_embeddings: Number(staleRows[0]?.count ?? 0),
        };
      } catch { /* diagnostics are informational — don't fail health on error */ }
    }

    let chatModels: unknown = null;
    try {
      const { ollamaHealth, validateChatModels } = await import('./ollama.js');
      const h = await ollamaHealth();
      if (h.ok) ollama = 'ok';
      const v = await validateChatModels();
      chatModels = { primary: v.primary, fallback: v.fallback };
    } catch { /* ollama unavailable */ }

    const status = db === 'connected' ? 'ok' : 'degraded';
    res.status(db === 'connected' ? 200 : 503).json({
      status,
      db,
      ollama,
      chat_models: chatModels,
      embed_model: EMBED_MODEL,
      embed_dimension: EMBED_DIMENSION,
      queue: queueStats,
      worker: workerDiagnostics,
      schema_version: schemaVersion,
      migration_count: migrationCount,
      provider: getProviderSummary(),
      timestamp: ts,
    });
  });

  // GET /api/data-health — read-only orphan detection report (no repairs)
  app.get('/api/data-health', async (_req, res) => {
    const { query } = await import('./db.js');

    // Edges whose source or target no longer exist in any canonical table.
    // We check all entity types used as edge endpoints.
    const { rows: orphanEdges } = await query<{ direction: string; count: string }>(`
      SELECT 'source' as direction, COUNT(*)::int as count FROM edges e
      WHERE NOT EXISTS (
        SELECT 1 FROM goals    WHERE id = e.source_id AND source_type = 'goal'
        UNION ALL
        SELECT 1 FROM tasks    WHERE id = e.source_id AND source_type = 'task'
        UNION ALL
        SELECT 1 FROM resources WHERE id = e.source_id AND source_type = 'resource'
        UNION ALL
        SELECT 1 FROM meetings WHERE id = e.source_id AND source_type = 'meeting'
        UNION ALL
        SELECT 1 FROM notes    WHERE id = e.source_id AND source_type = 'note'
      )
      UNION ALL
      SELECT 'target', COUNT(*)::int FROM edges e
      WHERE NOT EXISTS (
        SELECT 1 FROM goals    WHERE id = e.target_id AND target_type = 'goal'
        UNION ALL
        SELECT 1 FROM tasks    WHERE id = e.target_id AND target_type = 'task'
        UNION ALL
        SELECT 1 FROM resources WHERE id = e.target_id AND target_type = 'resource'
        UNION ALL
        SELECT 1 FROM meetings WHERE id = e.target_id AND target_type = 'meeting'
        UNION ALL
        SELECT 1 FROM notes    WHERE id = e.target_id AND target_type = 'note'
      )
    `);
    const orphanEdgeCounts: Record<string, number> = {};
    for (const r of orphanEdges) orphanEdgeCounts[r.direction] = Number(r.count);

    // entity_summaries for entity_ids no longer present in any canonical table
    const { rows: orphanSummaries } = await query<{ count: string }>(`
      SELECT COUNT(*)::int as count FROM entity_summaries es
      WHERE NOT EXISTS (
        SELECT 1 FROM goals        WHERE id = es.entity_id AND es.entity_type = 'goal'
        UNION ALL
        SELECT 1 FROM tasks        WHERE id = es.entity_id AND es.entity_type = 'task'
        UNION ALL
        SELECT 1 FROM goal_milestones WHERE id = es.entity_id AND es.entity_type = 'milestone'
        UNION ALL
        SELECT 1 FROM resources    WHERE id = es.entity_id AND es.entity_type = 'resource'
        UNION ALL
        SELECT 1 FROM meetings     WHERE id = es.entity_id AND es.entity_type = 'meeting'
        UNION ALL
        SELECT 1 FROM journal_entries WHERE id = es.entity_id AND es.entity_type = 'journal_entry'
      )
    `);

    // embeddings for entity_ids no longer present in any canonical table
    const { rows: orphanEmbeddings } = await query<{ count: string }>(`
      SELECT COUNT(*)::int as count FROM embeddings emb
      WHERE NOT EXISTS (
        SELECT 1 FROM goals        WHERE id = emb.entity_id AND emb.entity_type = 'goal'
        UNION ALL
        SELECT 1 FROM tasks        WHERE id = emb.entity_id AND emb.entity_type = 'task'
        UNION ALL
        SELECT 1 FROM goal_milestones WHERE id = emb.entity_id AND emb.entity_type = 'milestone'
        UNION ALL
        SELECT 1 FROM resources    WHERE id = emb.entity_id AND emb.entity_type = 'resource'
        UNION ALL
        SELECT 1 FROM meetings     WHERE id = emb.entity_id AND emb.entity_type = 'meeting'
        UNION ALL
        SELECT 1 FROM journal_entries WHERE id = emb.entity_id AND emb.entity_type = 'journal_entry'
        UNION ALL
        SELECT 1 FROM resource_chunks WHERE id = emb.entity_id AND emb.entity_type = 'resource_chunk'
      )
    `);

    // embedding_jobs (pending or failed) for deleted entities
    const { rows: orphanJobs } = await query<{ count: string }>(`
      SELECT COUNT(*)::int as count FROM embedding_jobs ej
      WHERE ej.status IN ('pending', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM goals        WHERE id = ej.entity_id AND ej.entity_type = 'goal'
          UNION ALL
          SELECT 1 FROM tasks        WHERE id = ej.entity_id AND ej.entity_type = 'task'
          UNION ALL
          SELECT 1 FROM goal_milestones WHERE id = ej.entity_id AND ej.entity_type = 'milestone'
          UNION ALL
          SELECT 1 FROM resources    WHERE id = ej.entity_id AND ej.entity_type = 'resource'
          UNION ALL
          SELECT 1 FROM meetings     WHERE id = ej.entity_id AND ej.entity_type = 'meeting'
          UNION ALL
          SELECT 1 FROM journal_entries WHERE id = ej.entity_id AND ej.entity_type = 'journal_entry'
          UNION ALL
          SELECT 1 FROM resource_chunks WHERE id = ej.entity_id AND ej.entity_type = 'resource_chunk'
        )
    `);

    // work_sessions pointing to tasks that no longer exist
    const { rows: orphanWorkSessions } = await query<{ count: string }>(`
      SELECT COUNT(*)::int as count FROM work_sessions ws
      WHERE ws.task_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = ws.task_id)
    `);

    // Physical file orphans: files on disk not referenced by any resource row
    let orphanFileCount = 0;
    const orphanFileNames: string[] = [];
    try {
      const diskFiles = fs.readdirSync(UPLOADS_DIR);
      const { rows: fileRows } = await query<{ file_path: string; url: string }>(
        `SELECT COALESCE(file_path, '') AS file_path, COALESCE(url, '') AS url FROM resources WHERE file_path IS NOT NULL OR url LIKE '/api/resources/serve/%'`,
      );
      const referencedNames = new Set<string>();
      for (const r of fileRows) {
        // file_path is the absolute on-disk path stored during upload
        if (r.file_path) referencedNames.add(path.basename(r.file_path));
        // url is '/api/resources/serve/<filename>'
        if (r.url?.startsWith('/api/resources/serve/')) referencedNames.add(r.url.split('/').pop() ?? '');
      }
      for (const name of diskFiles) {
        if (!referencedNames.has(name)) {
          orphanFileCount++;
          if (orphanFileNames.length < 20) orphanFileNames.push(name);
        }
      }
    } catch { /* uploads dir may not exist on first run */ }

    const totalOrphans =
      (orphanEdgeCounts['source'] ?? 0) +
      (orphanEdgeCounts['target'] ?? 0) +
      Number(orphanSummaries[0]?.count ?? 0) +
      Number(orphanEmbeddings[0]?.count ?? 0) +
      Number(orphanJobs[0]?.count ?? 0) +
      Number(orphanWorkSessions[0]?.count ?? 0) +
      orphanFileCount;

    res.json({
      ok: totalOrphans === 0,
      total_orphans: totalOrphans,
      details: {
        orphan_edges_by_source: orphanEdgeCounts['source'] ?? 0,
        orphan_edges_by_target: orphanEdgeCounts['target'] ?? 0,
        orphan_entity_summaries: Number(orphanSummaries[0]?.count ?? 0),
        orphan_embeddings: Number(orphanEmbeddings[0]?.count ?? 0),
        orphan_embedding_jobs: Number(orphanJobs[0]?.count ?? 0),
        orphan_work_sessions: Number(orphanWorkSessions[0]?.count ?? 0),
        orphan_upload_files: orphanFileCount,
        ...(orphanFileNames.length ? { orphan_file_sample: orphanFileNames } : {}),
      },
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/data-readiness — planning gaps: tasks missing estimate/due-date, goals without tasks, etc.
  app.get('/api/data-readiness', async (_req, res) => {
    const { query: dbQuery } = await import('./db.js');

    const [
      { rows: tasksNoGoal },
      { rows: tasksNoEstimate },
      { rows: tasksNoDueDate },
      { rows: goalsNoTasks },
      { rows: resourcesUnattached },
      { rows: journalPending },
      { rows: goalsNoPlanSummary },
    ] = await Promise.all([
      dbQuery<{ count: string }>(`
        SELECT COUNT(*)::int as count FROM tasks
        WHERE goal_id IS NULL AND completed = false`),
      dbQuery<{ count: string }>(`
        SELECT COUNT(*)::int as count FROM tasks t
        JOIN goals g ON g.id = t.goal_id
        WHERE t.completed = false AND g.archived_at IS NULL
          AND (t.estimated_minutes IS NULL OR t.estimated_minutes = 0)`),
      dbQuery<{ count: string }>(`
        SELECT COUNT(*)::int as count FROM tasks t
        JOIN goals g ON g.id = t.goal_id
        WHERE t.completed = false AND g.archived_at IS NULL AND t.due_date IS NULL`),
      dbQuery<{ count: string }>(`
        SELECT COUNT(*)::int as count FROM goals g
        WHERE g.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM tasks WHERE goal_id = g.id AND completed = false)`),
      dbQuery<{ count: string }>(`
        SELECT COUNT(*)::int as count FROM resources r
        WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source_id = r.id AND source_type = 'resource' AND relationship = 'attached_to')`),
      dbQuery<{ count: string }>(`
        SELECT COUNT(*)::int as count FROM journal_entries WHERE ingestion_status IN ('pending','failed','needs_review')`),
      dbQuery<{ count: string }>(`
        SELECT COUNT(*)::int as count FROM goals g
        WHERE g.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM entity_summaries WHERE entity_type='goal' AND entity_id=g.id AND summary_type='planning')`),
    ]);

    const items = [
      { bucket: 'tasks_no_goal',           count: Number(tasksNoGoal[0]?.count ?? 0),         severity: 'info',    description: 'Incomplete tasks not attached to any goal' },
      { bucket: 'tasks_no_estimate',        count: Number(tasksNoEstimate[0]?.count ?? 0),      severity: 'warning', description: 'Incomplete tasks with no time estimate — cannot be scheduled' },
      { bucket: 'tasks_no_due_date',        count: Number(tasksNoDueDate[0]?.count ?? 0),       severity: 'info',    description: 'Incomplete tasks with no due date — excluded from deadline scheduling' },
      { bucket: 'goals_no_tasks',           count: Number(goalsNoTasks[0]?.count ?? 0),         severity: 'info',    description: 'Active goals with no incomplete tasks' },
      { bucket: 'resources_unattached',     count: Number(resourcesUnattached[0]?.count ?? 0),  severity: 'info',    description: 'Resources not attached to any goal or task' },
      { bucket: 'journal_pending_failed',   count: Number(journalPending[0]?.count ?? 0),       severity: 'warning', description: 'Journal entries pending ingestion or failed extraction' },
      { bucket: 'goals_no_plan_summary',    count: Number(goalsNoPlanSummary[0]?.count ?? 0),   severity: 'info',    description: 'Active goals without a planning summary (Copilot context is weaker)' },
    ];

    const total_gaps = items.reduce((s, i) => s + i.count, 0);
    res.json({ ok: total_gaps === 0, total_gaps, items, timestamp: new Date().toISOString() });
  });

  // POST /api/data-health/repair — purge confirmed orphan records (non-destructive for live data)
  app.post('/api/data-health/repair', async (_req, res) => {
    const { query: dbQuery } = await import('./db.js');

    // Purge pending/failed embedding_jobs whose entity no longer exists
    const { rowCount: purgedJobs } = await dbQuery(`
      DELETE FROM embedding_jobs ej
      WHERE ej.status IN ('pending', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM goals WHERE id = ej.entity_id AND ej.entity_type = 'goal'
          UNION ALL SELECT 1 FROM tasks WHERE id = ej.entity_id AND ej.entity_type = 'task'
          UNION ALL SELECT 1 FROM goal_milestones WHERE id = ej.entity_id AND ej.entity_type = 'milestone'
          UNION ALL SELECT 1 FROM resources WHERE id = ej.entity_id AND ej.entity_type = 'resource'
          UNION ALL SELECT 1 FROM meetings WHERE id = ej.entity_id AND ej.entity_type = 'meeting'
          UNION ALL SELECT 1 FROM journal_entries WHERE id = ej.entity_id AND ej.entity_type = 'journal_entry'
          UNION ALL SELECT 1 FROM resource_chunks WHERE id = ej.entity_id AND ej.entity_type = 'resource_chunk'
        )
    `);

    // Purge entity_summaries whose entity no longer exists
    const { rowCount: purgedSummaries } = await dbQuery(`
      DELETE FROM entity_summaries es
      WHERE NOT EXISTS (
        SELECT 1 FROM goals WHERE id = es.entity_id AND es.entity_type = 'goal'
        UNION ALL SELECT 1 FROM tasks WHERE id = es.entity_id AND es.entity_type = 'task'
        UNION ALL SELECT 1 FROM goal_milestones WHERE id = es.entity_id AND es.entity_type = 'milestone'
        UNION ALL SELECT 1 FROM resources WHERE id = es.entity_id AND es.entity_type = 'resource'
        UNION ALL SELECT 1 FROM meetings WHERE id = es.entity_id AND es.entity_type = 'meeting'
        UNION ALL SELECT 1 FROM journal_entries WHERE id = es.entity_id AND es.entity_type = 'journal_entry'
      )
    `);

    // Purge work_sessions whose task no longer exists
    const { rowCount: purgedWorkSessions } = await dbQuery(`
      DELETE FROM work_sessions ws
      WHERE ws.task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = ws.task_id)
    `);

    // Purge orphan upload files (files on disk not referenced in DB)
    let purgedFiles = 0;
    try {
      const diskFiles = fs.readdirSync(UPLOADS_DIR);
      const { rows: fileRows } = await dbQuery<{ file_path: string; url: string }>(
        `SELECT COALESCE(file_path, '') AS file_path, COALESCE(url, '') AS url FROM resources WHERE file_path IS NOT NULL OR url LIKE '/api/resources/serve/%'`,
      );
      const referencedNames = new Set<string>();
      for (const r of fileRows) {
        if (r.file_path) referencedNames.add(path.basename(r.file_path));
        if (r.url?.startsWith('/api/resources/serve/')) referencedNames.add(r.url.split('/').pop() ?? '');
      }
      for (const name of diskFiles) {
        if (!referencedNames.has(name)) {
          try {
            fs.unlinkSync(path.join(UPLOADS_DIR, name));
            purgedFiles++;
          } catch { /* ignore individual file errors */ }
        }
      }
    } catch { /* uploads dir may not exist */ }

    res.json({
      ok: true,
      purged: {
        embedding_jobs: purgedJobs ?? 0,
        entity_summaries: purgedSummaries ?? 0,
        work_sessions: purgedWorkSessions ?? 0,
        upload_files: purgedFiles,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/inventory — read-only row counts per canonical table (never mutates)
  app.get('/api/inventory', async (_req, res) => {
    const { query: dbQuery } = await import('./db.js');
    const TABLES = [
      'goals', 'tasks', 'goal_deadlines', 'goal_milestones', 'meetings', 'events',
      'event_task_links', 'work_sessions', 'task_notes', 'task_note_files', 'notes',
      'resources', 'resource_logs', 'edges', 'tags', 'entity_tags', 'daily_scores',
      'user_schedule_prefs', 'journal_entries', 'journal_links', 'extracted_facts',
      'entity_aliases', 'embeddings', 'embedding_jobs', 'entity_summaries',
      'ai_action_proposals', 'resource_chunks', 'schedule_day_overrides',
      'chat_sessions', 'chat_messages', 'schema_migrations',
      'topics', 'topic_aliases', 'topic_memberships', 'suggestion_runs',
      'google_sync_connections', 'google_sync_links',
    ];
    const counts: Record<string, number> = {};
    await Promise.all(
      TABLES.map(async (t) => {
        try {
          const { rows } = await dbQuery<{ count: string }>(`SELECT COUNT(*)::int AS count FROM ${t}`);
          counts[t] = Number(rows[0]?.count ?? 0);
        } catch {
          counts[t] = -1; // table may not exist yet (pre-migration)
        }
      }),
    );
    res.json({ tables: counts, timestamp: new Date().toISOString() });
  });

  // Factory reset — disabled by default; requires ALLOW_FACTORY_RESET=true
  app.post('/api/reset', async (_req, res, next) => {
    if (process.env.ALLOW_FACTORY_RESET !== 'true') {
      return res.status(403).json({ error: 'Factory reset is disabled. Set ALLOW_FACTORY_RESET=true to enable.' });
    }
    try {
      const { resetAndSeed } = await import('./seed.js');
      await resetAndSeed();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Centralized error handler — express-async-errors forwards async rejections here too
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;

    // Zod validation errors → 400
    if (err && typeof err === 'object' && (err as Record<string, unknown>).name === 'ZodError') {
      return res.status(400).json({ error: 'Validation error', issues: (err as Record<string, unknown>).issues });
    }

    // PostgreSQL unique-violation → 409
    if (err && typeof err === 'object' && (err as Record<string, unknown>).code === '23505') {
      return res.status(409).json({ error: 'Conflict: duplicate entry' });
    }

    // PostgreSQL FK violation → 400
    if (err && typeof err === 'object' && (err as Record<string, unknown>).code === '23503') {
      return res.status(400).json({ error: 'Referenced entity does not exist' });
    }

    // Errors thrown with a .status property (e.g. Object.assign(new Error('…'), { status: 404 }))
    if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).status === 'number') {
      const status = (err as Record<string, unknown>).status as number;
      const message = err instanceof Error ? err.message : 'Error';
      return res.status(status).json({ error: message });
    }

    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[server] Unhandled error:', message);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
