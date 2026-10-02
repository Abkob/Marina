import { Router } from 'express';
import { z } from 'zod';
import { browseDrive, createDriveAuthorization, disconnectDrive, driveStatus, importDriveFile, reconcileDriveResources, syncDriveResource } from '../services/googleDrive.js';
import { wakeResourceProcessing } from '../services/resourceDispatch.js';
import { rateLimit } from '../utils/rateLimit.js';
import { searchDocuments } from '../services/documentRag.js';
import { scanResourceDirectory } from '../services/driveDirectoryScan.js';
import { query } from '../db.js';
import { activeGoalSql, activeTaskSql, activeResourceSql } from '../utils/archiveVisibility.js';
import { filterRootedDriveRows, DRIVE_FILE_ID_SQL } from '../services/driveResourceAccess.js';
const router = Router();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
router.get('/status', async (_req, res) => { res.json(await driveStatus()); });
router.get('/context-options', async (req, res) => {
  const search = z.string().max(200).parse(req.query.search ?? '');
  const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await query<{ id: string; title: string; kind: string; file_id: string | null }>(`SELECT * FROM (
    (SELECT g.id,g.title,'goal' AS kind,NULL::text AS file_id FROM goals g WHERE ${activeGoalSql('g.id')} AND g.title ILIKE $1 ORDER BY g.title LIMIT 20)
    UNION ALL (SELECT t.id,t.title,'task' AS kind,NULL::text AS file_id FROM tasks t WHERE ${activeTaskSql('t.id')} AND t.title ILIKE $1 ORDER BY t.title LIMIT 20)
    UNION ALL (SELECT r.id,r.title,'resource' AS kind,${DRIVE_FILE_ID_SQL} AS file_id FROM resources r LEFT JOIN resource_drive_files d ON d.resource_id=r.id AND r.file_path LIKE 'gdrive://%'
      WHERE ${activeResourceSql('r.id')} AND (d.resource_id IS NULL OR d.available) AND r.title ILIKE $1 ORDER BY r.title LIMIT 20)
  ) choices ORDER BY kind,title,id`, [like]);
  res.json(await filterRootedDriveRows(rows));
});
router.post('/refresh-directory', rateLimit(120, 60_000, 'drive-directory'), async (req, res) => {
  const body = z.object({ attach_to_id: z.string().min(1).max(100).optional(), attach_to_type: z.enum(['goal','task']).optional(), include_subtasks: z.boolean().default(false), cursor: z.string().max(100000).optional() }).strict().parse(req.body);
  const result = await scanResourceDirectory(body, body.include_subtasks, body.cursor);
  wakeResourceProcessing();
  res.json(result);
});
router.post('/search', rateLimit(30, 60_000, 'document-search'), async (req, res) => {
  const body = z.object({ query: z.string().trim().min(1).max(2000), resource_ids: z.array(z.string().uuid()).max(20).optional(), limit: z.number().int().min(1).max(12).optional() }).parse(req.body);
  res.json(await searchDocuments(body.query, body.resource_ids, body.limit));
});
router.post('/connect', async (req, res) => {
  const body = z.object({ return_to: z.string().max(1000).optional() }).parse(req.body ?? {});
  res.json({ authorization_url: await createDriveAuthorization(body.return_to) });
});
router.delete('/connection', async (_req, res) => { await disconnectDrive(); res.json({ ok: true, google_data_kept: true }); });
router.get('/files', async (req, res) => {
  const q = z.object({ search: z.string().max(200).optional(), folder: z.string().max(200).optional(), page: z.string().max(2000).optional() }).parse(req.query);
  res.json(await browseDrive(q.search, q.folder, q.page));
});
router.post('/import', rateLimit(60, 60_000, 'drive-import'), async (req, res) => {
  const body = z.object({ file_id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/) }).parse(req.body);
  res.json(await importDriveFile(body.file_id));
  wakeResourceProcessing();
});
router.post('/sync', rateLimit(20, 60_000, 'drive-sync'), async (req, res) => {
  const body = z.object({ resource_id: z.string().uuid().optional() }).parse(req.body ?? {});
  const checked = body.resource_id ? (await syncDriveResource(body.resource_id), 1) : await reconcileDriveResources(20, true);
  res.json({ ok: true, checked }); wakeResourceProcessing();
});
export { router as googleDriveRouter };
