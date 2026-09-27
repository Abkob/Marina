import { Router } from 'express';
import {
  getObsidianVaultStatus,
  scheduleObsidianVaultSync,
  syncObsidianVault,
} from '../services/obsidianVaultSync.js';
import { canUseLocalPersistence } from '../runtime.js';

const router = Router();

router.get('/status', (_req, res) => {
  res.json(getObsidianVaultStatus());
});

router.post('/sync', async (req, res) => {
  if (!canUseLocalPersistence()) return res.status(409).json({ error: 'Obsidian vault export requires a persistent local filesystem' });
  const force = req.body?.force !== false;
  if (!force) {
    return res.json(scheduleObsidianVaultSync('manual queued'));
  }
  const result = await syncObsidianVault('manual');
  res.json(result);
});

export { router as obsidianVaultRouter };
