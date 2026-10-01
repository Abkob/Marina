import { Router } from 'express';
import { activeResourceSql, activeTaskSql, activeGoalSql, activeEntitySql } from '../utils/archiveVisibility.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { query, buildUpdate, transaction } from '../db.js';
import { generateEntitySummary } from '../services/summaryGenerator.js';
import { queueEmbeddingUpsert, markEmbeddingStale } from '../services/embeddingLifecycle.js';
import { createUploadIntent, finalizeLocalUpload, getUploadIntent, registerLegacyBlob } from '../services/resourceUploads.js';
import { getResourceProcessing, retryResourceProcessing } from '../services/resourceProcessing.js';
import { wakeResourceProcessing, durableProcessingConfigured } from '../services/resourceDispatch.js';
import { validateStoredContent } from '../services/uploadValidation.js';
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES, validateUploadMetadata } from '../../shared/uploadPolicy.js';
import { pipeline } from 'node:stream/promises';
import { isVercelRuntime } from '../runtime.js';
import { z } from 'zod';
import { deleteStoredFile, isPrivateBlobReference, openStoredFile, verifyPrivateBlob } from '../services/fileStorage.js';
import { runInBackground } from '../utils/background.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = isVercelRuntime ? path.join('/tmp', 'marina-uploads') : path.join(__dir, '..', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOADS_DIR),
    filename: (_, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 },
  fileFilter: (_, file, cb) => {
    try { validateUploadMetadata(file.originalname, 1, file.mimetype); cb(null, true); }
    catch (error) { cb(error); }
  },
});

const VALID_READ_STATES = new Set(['Unread', 'Reading', 'Done', 'Shelved']);

const BlobRegistration = z.object({
  blob: z.object({ url: z.string().url(), pathname: z.string().min(1).max(512) }),
  original_name: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(200),
  size: z.number().int().positive().max(50 * 1024 * 1024),
  attach_to_id: z.string().min(1).optional(),
  attach_to_type: z.enum(['task', 'goal']).optional(),
});

const router = Router();

async function attachmentTargetExists(targetId: string, targetType: string): Promise<boolean> {
  if (!['task', 'goal'].includes(targetType)) return false;
  const table = targetType === 'task' ? 'tasks' : 'goals';
  const { rows } = await query(`SELECT id FROM ${table} WHERE id=$1`, [targetId]);
  return rows.length > 0;
}

// GET /api/resources?goal_id=...  or  ?task_id=...  or  ?task_ids=id1,id2,...  or bare (all)
router.get('/', async (req, res) => {
  const { goal_id, task_id, task_ids } = req.query;
  if (goal_id) {
    const { rows } = await query(
      `SELECT r.* FROM resources r
       JOIN edges e ON e.source_id = r.id AND e.relationship = 'attached_to' AND e.target_id = $1`,
      [goal_id],
    );
    return res.json(rows);
  }
  if (task_id) {
    const { rows } = await query(
      `SELECT r.* FROM resources r
       JOIN edges e ON e.source_id = r.id AND e.relationship = 'attached_to' AND e.target_id = $1`,
      [task_id],
    );
    return res.json(rows);
  }
  // Batch lookup: returns { task_id, resource } rows so caller can group them
  if (task_ids && typeof task_ids === 'string') {
    const ids = task_ids.split(',').map(s => s.trim()).filter(Boolean).slice(0, 200);
    if (ids.length === 0) return res.json([]);
    const { rows } = await query(
      `SELECT e.target_id AS task_id, r.*
       FROM resources r
       JOIN edges e ON e.source_id = r.id AND e.relationship = 'attached_to'
       WHERE e.target_id = ANY($1::text[])`,
      [ids],
    );
    return res.json(rows);
  }
  const limit  = Math.min(Math.max(1, Number(req.query.limit)  || 500), 500);
  const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
  let cursor: { created_at: string; id: string } | null = null;
  if (typeof req.query.before === 'string') {
    try { cursor = JSON.parse(Buffer.from(req.query.before, 'base64url').toString()); }
    catch { return res.status(400).json({ error: 'Invalid resource cursor' }); }
    if (!cursor || typeof cursor.created_at !== 'string' || typeof cursor.id !== 'string') return res.status(400).json({ error: 'Invalid resource cursor' });
  }
  const { rows } = await query(
    `SELECT resources.*, (SELECT status FROM resource_processing_jobs j WHERE j.resource_id=resources.id) AS processing_status
     FROM resources WHERE ${activeResourceSql()} AND ($3::text IS NULL OR (created_at,id) < ($3,$4)) ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2`,
    [Math.floor(limit), offset, cursor?.created_at ?? null, cursor?.id ?? null],
  );
  res.json(rows);
});

// GET /api/resources/mentions
router.get('/mentions', async (req, res) => {
  const { source_id, source_type, resource_id } = req.query as Record<string, string>;
  if (source_id && source_type) {
    const { rows } = await query(
      `SELECT r.*, e.id as edge_id FROM resources r
       JOIN edges e ON e.target_id = r.id AND e.relationship = 'mentions'
       WHERE e.source_id = $1 AND e.source_type = $2
       ORDER BY e.created_at ASC`,
      [source_id, source_type],
    );
    return res.json(rows);
  }
  if (resource_id) {
    const { rows } = await query(
      `SELECT e.source_id, e.source_type, e.created_at, e.id as edge_id FROM edges e
       WHERE e.target_id = $1 AND e.relationship = 'mentions'
       ORDER BY e.created_at DESC`,
      [resource_id],
    );
    return res.json(rows);
  }
  res.status(400).json({ error: 'provide source_id+source_type or resource_id' });
});

// POST /api/resources/mentions
router.post('/mentions', async (req, res) => {
  const { source_id, source_type, resource_id } = req.body;
  if (!source_id || !source_type || !resource_id) return res.status(400).json({ error: 'missing fields' });
  const { rows: existing } = await query(
    `SELECT id FROM edges WHERE source_id=$1 AND source_type=$2 AND target_id=$3 AND relationship='mentions'`,
    [source_id, source_type, resource_id],
  );
  if (existing.length) return res.json({ id: (existing[0] as Record<string, unknown>).id });
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [id, source_id, source_type, resource_id, 'resource', 'mentions', null, new Date().toISOString()],
  );
  res.json({ id });
});

// DELETE /api/resources/mentions/:edgeId
router.delete('/mentions/:edgeId', async (req, res) => {
  await query("DELETE FROM edges WHERE id=$1 AND relationship='mentions'", [req.params.edgeId]);
  res.json({ ok: true });
});

// POST /api/resources/upload
router.post('/upload', (req, res, next) => {
  if (isVercelRuntime) {
    return res.status(409).json({ error: 'Use private Blob upload on Vercel' });
  }
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large (50 MB limit)' });
    }
    if (err) return res.status(400).json({ error: (err as Error).message });
    next();
  });
}, async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const suppliedId = typeof req.body.upload_id === 'string' ? req.body.upload_id : undefined;
    const intent = suppliedId ? await getUploadIntent(suppliedId) : await createUploadIntent({
      request_key: req.body.request_key ?? crypto.randomUUID(), original_name: file.originalname,
      mime_type: file.mimetype, size: file.size,
      ...(req.body.attach_to_id ? { attach_to_id: req.body.attach_to_id, attach_to_type: req.body.attach_to_type ?? 'goal' } : {}),
    });
    if (file.originalname !== intent.original_name || file.mimetype !== intent.mime_type || file.size !== Number(intent.size)) {
      throw Object.assign(new Error('File does not match the upload intent'), { status: 400 });
    }
    await validateStoredContent(file.path, file.mimetype, file.size);
    const result = await finalizeLocalUpload(intent.id, file);
    if (result.already_saved) await deleteStoredFile(file.path);
    res.json(result);
    wakeResourceProcessing();
  } catch (error) {
    // Do not remove a committed file if the COMMIT response was lost.
    const references = await query('SELECT id FROM resources WHERE file_path=$1', [file.path]).catch(() => null);
    if (references && !references.rows.length) await deleteStoredFile(file.path);
    throw error;
  }
});

router.post('/register-blob', async (req, res) => {
  const result = await registerLegacyBlob(BlobRegistration.parse(req.body));
  res.json(result);
  wakeResourceProcessing();
});

router.get('/:id/processing', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...await getResourceProcessing(req.params.id), worker_available: !isVercelRuntime || durableProcessingConfigured() });
});
router.post('/:id/rechunk', async (req, res) => {
  const result = await retryResourceProcessing(req.params.id);
  res.status(202).json(result);
  wakeResourceProcessing();
});

// GET /api/resources/:id/chunks — chunk inspection (Testing workbench + citation viewer)
router.get('/:id/chunks', async (req, res) => {
  const { rows } = await query(
    `SELECT rc.id, rc.chunk_index, rc.page_start, rc.page_end, rc.chunk_metadata,
            LENGTH(rc.content) AS content_chars, LEFT(rc.content, 240) AS content_preview,
            (e.id IS NOT NULL) AS has_embedding, COALESCE(e.is_stale, false) AS embedding_stale
     FROM resource_chunks rc
     LEFT JOIN embeddings e ON e.entity_type='resource_chunk' AND e.entity_id=rc.id AND e.embedding_3072 IS NOT NULL
     WHERE rc.resource_id=$1
     ORDER BY rc.chunk_index ASC`,
    [req.params.id],
  );
  res.json(rows);
});

// GET /api/resources/serve/:filename
router.get('/serve/:filename', (req, res) => {
  // Only allow alphanumeric, hyphens, underscores, and a single dot for extension
  const safeName = req.params.filename.replace(/[^a-zA-Z0-9.\-_]/g, '');
  const resolved = path.resolve(path.join(UPLOADS_DIR, safeName));
  if (!resolved.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  // Force download for types the viewer doesn't display inline to prevent
  // unexpected browser rendering (e.g. text/html if extension check was bypassed).
  const ext = path.extname(safeName).toLowerCase();
  const inlineExts = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.md', '.csv']);
  if (!inlineExts.has(ext)) {
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  }
  res.sendFile(resolved);
});

// Authenticated streaming keeps private files on the same origin. Legacy
// objects are served with their stored MIME; new files must pass validation.
router.get('/blob/:id', async (req, res) => {
  const row = (await query('SELECT title,file_path,original_name,mime_type,file_validation FROM resources WHERE id=$1', [req.params.id])).rows[0];
  if (!row?.file_path) return res.status(404).json({ error: 'Not found' });
  if (row.file_validation === 'pending') return res.status(409).json({ error: 'File is still being checked. Please try again shortly.' });
  if (row.file_validation === 'invalid') return res.status(422).json({ error: 'File content did not pass validation.' });
  const reference = String(row.file_path);
  const opened = await openStoredFile(reference, req.headers.range);
  if (!opened) return res.status(404).json({ error: 'Not found' });
  let name = row.original_name as string | null;
  if (!name) name = isPrivateBlobReference(reference) ? (await verifyPrivateBlob(reference)).pathname.split('/').pop()! : path.basename(reference);
  const safeName = name.replace(/[^a-zA-Z0-9._ -]/g, '_');
  res.status(opened.statusCode ?? 200);
  const contentType = row.mime_type as string || opened.contentType || 'application/octet-stream';
  const disposition = req.query.download === '1' || !Object.values(UPLOAD_TYPES).includes(contentType) ? 'attachment' : 'inline';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(opened.size));
  res.setHeader('Content-Disposition', disposition + '; filename="' + safeName + '"; filename*=UTF-8\'\'' + encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16)));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
  res.setHeader('Accept-Ranges', 'bytes');
  if (opened.contentRange) res.setHeader('Content-Range', opened.contentRange);
  try { await pipeline(opened.stream, res); }
  catch (error) { if (!res.destroyed) res.destroy(error as Error); }
});

// GET /api/resources/:id
router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM resources WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

// POST /api/resources
router.post('/', async (req, res) => {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const b = req.body;
  if (b.attach_to_id && !(await attachmentTargetExists(b.attach_to_id, b.attach_to_type ?? 'goal'))) {
    return res.status(400).json({ error: 'Attachment target does not exist or has an invalid type' });
  }
  await query(
    `INSERT INTO resources (id,title,url,type,info,description,read_state,next_action,tags_json,estimated_minutes,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      b.title ?? '',
      b.url ?? null,
      b.type ?? 'link',
      b.info ?? '',
      b.description ?? null,
      b.read_state ?? 'Unread',
      b.next_action ?? '',
      b.tags_json ?? '[]',
      b.estimated_minutes ?? null,
      now,
      now,
    ],
  );
  if (b.attach_to_id) {
    await query(
      `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), id, 'resource', b.attach_to_id, b.attach_to_type ?? 'goal', 'attached_to', null, now],
    );
  }
  res.json({ id });
  runInBackground(generateEntitySummary('resource', id), 'resource create summary');
  runInBackground(queueEmbeddingUpsert('resource', id), 'resource create embedding queue');
  if (b.tags_json) {
    import('../services/topicTagSync.js')
      .then(({ syncTagsToTopics, parseTags }) => syncTagsToTopics('resource', id, parseTags(b.tags_json), 'manual'))
      .catch(err => console.warn('[resources] tag→topic sync:', err));
  }
});

// Remove only this attachment. The resource remains available in the library
// and any other task mentions/backlinks remain intact.
router.delete('/:id/attachments/:targetType/:targetId', async (req, res) => {
  const { id, targetType, targetId } = req.params;
  if (!['task', 'goal'].includes(targetType)) {
    return res.status(400).json({ error: 'targetType must be task or goal' });
  }
  await query(
    `DELETE FROM edges
     WHERE source_id=$1 AND source_type='resource'
       AND target_id=$2 AND target_type=$3 AND relationship='attached_to'`,
    [id, targetId, targetType],
  );
  res.json({ ok: true });
});

// PATCH /api/resources/:id
router.patch('/:id', async (req, res) => {
  const { rows: existing } = await query('SELECT id FROM resources WHERE id=$1', [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: 'Not found' });
  const { title, type, url, info, description, read_state, next_action, tags_json, estimated_minutes } = req.body;
  if (read_state !== undefined && !VALID_READ_STATES.has(read_state)) {
    return res.status(400).json({ error: `Invalid read_state. Must be one of: ${[...VALID_READ_STATES].join(', ')}` });
  }
  if (tags_json !== undefined) {
    try { if (!Array.isArray(JSON.parse(tags_json))) throw new Error(); }
    catch { return res.status(400).json({ error: 'tags_json must be a JSON array string' }); }
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (title             !== undefined) updates.title             = title;
  if (type              !== undefined) updates.type              = type;
  if (url               !== undefined) updates.url               = url;
  if (info              !== undefined) updates.info              = info;
  if (description       !== undefined) updates.description       = description;
  if (read_state        !== undefined) updates.read_state        = read_state;
  if (next_action       !== undefined) updates.next_action       = next_action;
  if (tags_json         !== undefined) updates.tags_json         = tags_json;
  if (estimated_minutes !== undefined) updates.estimated_minutes = estimated_minutes;

  const { sets, vals } = buildUpdate(updates);
  await query(`UPDATE resources SET ${sets} WHERE id=$${vals.length + 1}`, [...vals, req.params.id]);
  res.json({ ok: true });
  runInBackground(generateEntitySummary('resource', req.params.id), 'resource update summary');
  runInBackground(markEmbeddingStale('resource', req.params.id), 'resource update stale embedding');
  runInBackground(queueEmbeddingUpsert('resource', req.params.id), 'resource update embedding queue');
  // Choice A — tags ARE topics: a user-typed tag matching a topic name/alias
  // joins that topic with full authority.
  if (tags_json !== undefined) {
    import('../services/topicTagSync.js')
      .then(({ syncTagsToTopics, parseTags }) => syncTagsToTopics('resource', req.params.id, parseTags(tags_json), 'manual'))
      .catch(err => console.warn('[resources] tag→topic sync:', err));
  }
});

// DELETE /api/resources/:id
router.delete('/:id', async (req, res) => {
  const resourceId = req.params.id;
  // Read file_path before deletion so we can clean up after transaction
  const { rows: resourceRows } = await query('SELECT file_path FROM resources WHERE id=$1', [resourceId]);
  const filePath = resourceRows.length ? (resourceRows[0] as Record<string, unknown>).file_path as string | null : null;

  await transaction(async (client) => {
    await client.query('SELECT id FROM resources WHERE id=$1 FOR UPDATE', [resourceId]);
    await client.query("UPDATE resource_uploads SET state='deleted' WHERE id=$1", [resourceId]);
    await client.query("DELETE FROM embeddings WHERE entity_type='resource_chunk' AND entity_id IN (SELECT id FROM resource_chunks WHERE resource_id=$1)", [resourceId]);
    await client.query("DELETE FROM embedding_jobs WHERE entity_type='resource_chunk' AND entity_id=$1", [resourceId]);
    // Use explicit type predicates to prevent cross-type ID collisions from deleting unrelated edges
    await client.query(
      `DELETE FROM edges WHERE (source_id=$1 AND source_type='resource')
                            OR (target_id=$1 AND target_type='resource')`,
      [resourceId],
    );
    await client.query('DELETE FROM entity_summaries WHERE entity_type=$1 AND entity_id=$2', ['resource', resourceId]);
    await client.query("DELETE FROM embedding_jobs WHERE entity_type='resource' AND entity_id=$1 AND status IN ('pending','failed')", [resourceId]);
    // Clean derived evidence (no FK cascade for these tables)
    await client.query("DELETE FROM journal_links WHERE target_type='resource' AND target_id=$1", [resourceId]);
    await client.query("DELETE FROM extracted_facts WHERE target_type='resource' AND target_id=$1", [resourceId]);
    await client.query("DELETE FROM entity_aliases WHERE entity_type='resource' AND entity_id=$1", [resourceId]);
    await client.query("DELETE FROM ai_action_proposals WHERE source_type='resource' AND source_id=$1 AND status='pending'", [resourceId]);
    // Null out resource_id on work_sessions (resource_id has no FK constraint in schema)
    await client.query("UPDATE work_sessions SET resource_id=NULL WHERE resource_id=$1", [resourceId]);
    await client.query('DELETE FROM resources WHERE id=$1', [resourceId]);
  });
  // Delete physical file after transaction commits (best-effort — DB is canonical)
  if (filePath) {
    const references = await query('SELECT id FROM resources WHERE file_path=$1 UNION ALL SELECT id FROM task_note_files WHERE file_path=$1', [filePath]);
    if (!references.rows.length) await deleteStoredFile(filePath).catch(err => console.warn('[cleanup] resource file delete:', err));
  }
  await query("DELETE FROM embeddings WHERE entity_type='resource' AND entity_id=$1", [resourceId]);
  res.json({ ok: true });
});

// GET /api/resources/:id/references
router.get('/:id/references', async (req, res) => {
  const { rows: raw } = await query(
    `SELECT e.id as edge_id, e.source_id, e.source_type, e.created_at
     FROM edges e WHERE e.target_id=$1 AND e.relationship='mentions' AND ${activeEntitySql('e.source_type', 'e.source_id')}
     ORDER BY e.created_at DESC`,
    [req.params.id],
  ) as { rows: { edge_id: string; source_id: string; source_type: string; created_at: string }[] };

  const enriched = await Promise.all(
    raw.map(async row => {
      let source_title: string | null = null;
      let source_content: string | null = null;
      let parent_title: string | null = null;

      if (row.source_type === 'note') {
        const { rows: noteRows } = await query('SELECT content, task_id FROM task_notes WHERE id=$1', [row.source_id]);
        if (noteRows.length) {
          const note = noteRows[0] as Record<string, unknown>;
          source_content = (note.content as string).slice(0, 200);
          const { rows: taskRows } = await query('SELECT title FROM tasks WHERE id=$1', [note.task_id]);
          if (taskRows.length) parent_title = (taskRows[0] as Record<string, unknown>).title as string;
        }
        source_title = 'Journal entry';
      } else if (row.source_type === 'task') {
        const { rows: taskRows } = await query('SELECT title FROM tasks WHERE id=$1', [row.source_id]);
        if (taskRows.length) source_title = (taskRows[0] as Record<string, unknown>).title as string;
      } else if (row.source_type === 'goal') {
        const { rows: goalRows } = await query('SELECT title FROM goals WHERE id=$1', [row.source_id]);
        if (goalRows.length) source_title = (goalRows[0] as Record<string, unknown>).title as string;
      } else if (row.source_type === 'braindump') {
        const { rows: noteRows } = await query('SELECT title FROM notes WHERE id=$1', [row.source_id]);
        source_title = noteRows.length ? (noteRows[0] as Record<string, unknown>).title as string : 'Brain dump';
      }

      return { ...row, source_title, source_content, parent_title };
    }),
  );

  res.json(enriched);
});

// GET /api/resources/:id/stats
router.get('/:id/stats', async (req, res) => {
  const resourceId = req.params.id;

  const { rows: directTaskMentions } = await query(
    `SELECT source_id as task_id FROM edges WHERE target_id=$1 AND relationship='mentions' AND ${activeEntitySql('source_type', 'source_id')} AND source_type='task'`,
    [resourceId],
  ) as { rows: { task_id: string }[] };

  const { rows: noteTaskMentions } = await query(
    `SELECT tn.task_id FROM edges e
     JOIN task_notes tn ON tn.id = e.source_id
     WHERE e.target_id=$1 AND e.relationship='mentions' AND ${activeEntitySql('e.source_type', 'e.source_id')} AND e.source_type='note'`,
    [resourceId],
  ) as { rows: { task_id: string }[] };

  const taskIds = Array.from(new Set([
    ...directTaskMentions.map(r => r.task_id),
    ...noteTaskMentions.map(r => r.task_id),
  ]));

  let total_minutes = 0;
  const goalIds = new Set<string>();
  for (const taskId of taskIds) {
    const { rows: taskRows } = await query('SELECT actual_minutes, goal_id FROM tasks WHERE id=$1', [taskId]);
    if (taskRows.length) {
      const t = taskRows[0] as Record<string, unknown>;
      total_minutes += (t.actual_minutes as number) ?? 0;
      if (t.goal_id) goalIds.add(t.goal_id as string);
    }
  }

  const { rows: countRows } = await query(
    `SELECT COUNT(*) as n FROM edges WHERE target_id=$1 AND relationship='mentions' AND ${activeEntitySql('source_type', 'source_id')}`,
    [resourceId],
  );
  const reference_count = Number((countRows[0] as Record<string, unknown>).n ?? 0);

  const { rows: lastLogRows } = await query(
    'SELECT created_at FROM resource_logs WHERE resource_id=$1 ORDER BY created_at DESC LIMIT 1',
    [resourceId],
  );
  const { rows: lastRefRows } = await query(
    `SELECT created_at FROM edges WHERE target_id=$1 AND relationship='mentions' AND ${activeEntitySql('source_type', 'source_id')} ORDER BY created_at DESC LIMIT 1`,
    [resourceId],
  );

  const dates = [
    lastLogRows[0] ? (lastLogRows[0] as Record<string, unknown>).created_at : null,
    lastRefRows[0] ? (lastRefRows[0] as Record<string, unknown>).created_at : null,
  ].filter(Boolean) as string[];
  const last_engaged = dates.length ? dates.sort().reverse()[0] : null;

  res.json({ total_minutes, reference_count, goals_count: goalIds.size, last_engaged });
});

// GET /api/resources/:id/graph
router.get('/:id/graph', async (req, res) => {
  const resourceId = req.params.id;
  const { rows: rRows } = await query('SELECT * FROM resources WHERE id=$1', [resourceId]);
  if (!rRows.length) return res.status(404).end();
  const resource = rRows[0] as Record<string, unknown>;

  type GNode = { id: string; label: string; nodeType: string; meta?: Record<string, unknown> };
  type GEdge = { source: string; target: string; rel: string };
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const seen = new Set<string>();
  const addNode = (n: GNode) => { if (!seen.has(n.id)) { nodes.push(n); seen.add(n.id); } };

  addNode({ id: resourceId, label: resource.title as string, nodeType: 'resource', meta: { subtype: resource.type } });

  const { rows: mentions } = await query(
    `SELECT source_id, source_type FROM edges WHERE target_id=$1 AND relationship='mentions' AND ${activeEntitySql('source_type', 'source_id')}`,
    [resourceId],
  ) as { rows: { source_id: string; source_type: string }[] };

  const taskIds = new Set<string>();

  for (const m of mentions) {
    if (m.source_type === 'note') {
      const { rows: noteRows } = await query('SELECT content, task_id FROM task_notes WHERE id=$1', [m.source_id]);
      if (!noteRows.length) continue;
      const note = noteRows[0] as Record<string, unknown>;
      const { rows: taskRows } = await query(`SELECT id,title,completed,status,goal_id FROM tasks WHERE id=$1 AND ${activeTaskSql()}`, [note.task_id]);
      if (!taskRows.length) continue;
      const task = taskRows[0] as Record<string, unknown>;
      addNode({ id: task.id as string, label: task.title as string, nodeType: 'task', meta: { completed: task.completed, status: task.status, goal_id: task.goal_id } });
      edges.push({ source: task.id as string, target: resourceId, rel: 'mentions' });
      taskIds.add(task.id as string);
    } else if (m.source_type === 'task') {
      const { rows: taskRows } = await query(`SELECT id,title,completed,status,goal_id FROM tasks WHERE id=$1 AND ${activeTaskSql()}`, [m.source_id]);
      if (!taskRows.length) continue;
      const task = taskRows[0] as Record<string, unknown>;
      addNode({ id: task.id as string, label: task.title as string, nodeType: 'task', meta: { completed: task.completed, status: task.status, goal_id: task.goal_id } });
      edges.push({ source: task.id as string, target: resourceId, rel: 'mentions' });
      taskIds.add(task.id as string);
    } else if (m.source_type === 'goal') {
      const { rows: goalRows } = await query(`SELECT id,title FROM goals WHERE id=$1 AND ${activeGoalSql('id')}`, [m.source_id]);
      if (!goalRows.length) continue;
      const goal = goalRows[0] as Record<string, unknown>;
      addNode({ id: goal.id as string, label: goal.title as string, nodeType: 'goal' });
      edges.push({ source: goal.id as string, target: resourceId, rel: 'mentions' });
    }
  }

  for (const taskId of taskIds) {
    const taskNode = nodes.find(n => n.id === taskId);
    const goalId = taskNode?.meta?.goal_id as string | undefined;
    if (!goalId) continue;
    const { rows: goalRows } = await query(`SELECT id,title FROM goals WHERE id=$1 AND ${activeGoalSql('id')}`, [goalId]);
    if (!goalRows.length) continue;
    const goal = goalRows[0] as Record<string, unknown>;
    addNode({ id: goal.id as string, label: goal.title as string, nodeType: 'goal' });
    if (!edges.find(e => e.source === goal.id && e.target === taskId))
      edges.push({ source: goal.id as string, target: taskId, rel: 'contains' });
  }

  res.json({ nodes, edges });
});

// GET /api/resources/:id/logs
router.get('/:id/logs', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM resource_logs WHERE resource_id=$1 ORDER BY created_at DESC',
    [req.params.id],
  );
  res.json(rows);
});

// POST /api/resources/:id/logs
router.post('/:id/logs', async (req, res) => {
  const { content, is_insight } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content required' });
  const id = crypto.randomUUID();
  await query(
    'INSERT INTO resource_logs (id,resource_id,content,is_insight,created_at) VALUES ($1,$2,$3,$4,$5)',
    [id, req.params.id, content.trim(), Boolean(is_insight), new Date().toISOString()],
  );
  res.json({ id });
});

// DELETE /api/resources/:id/logs/:logId
router.delete('/:id/logs/:logId', async (req, res) => {
  await query('DELETE FROM resource_logs WHERE id=$1 AND resource_id=$2', [req.params.logId, req.params.id]);
  res.json({ ok: true });
});

export { router as resourcesRouter };
