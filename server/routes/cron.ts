import { Router } from 'express';
import { runMaintenance } from '../services/maintenance.js';

const router = Router();

router.get('/maintenance', async (_req, res) => {
  const result = await runMaintenance();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ...result, timestamp: new Date().toISOString() });
});

export { router as cronRouter };
