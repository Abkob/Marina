import { Router } from 'express';
import { runMaintenance } from '../services/maintenance.js';
import { runScheduledCloudBackup } from '../services/scheduledBackup.js';

const router = Router();

router.get('/backup', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const result = await runScheduledCloudBackup();
  res.json({ ok: true, ...result });
});

router.get('/maintenance', async (_req, res) => {
  const result = await runMaintenance();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ...result, timestamp: new Date().toISOString() });
});

export { router as cronRouter };
