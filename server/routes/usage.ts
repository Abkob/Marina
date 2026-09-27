import { Router } from 'express';
import { collectUsageMetrics } from '../services/usageMetrics.js';

const router = Router();

// Read-only live operational metrics. This endpoint never mutates application data.
router.get('/', async (_req, res) => {
  res.json(await collectUsageMetrics());
});

export { router as usageRouter };
