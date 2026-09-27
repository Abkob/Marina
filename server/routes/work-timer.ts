import { Router } from 'express';
import { changeWorkTimer, getWorkTimer, importTimerSchema, startTimerSchema, startWorkTimer, stopTimerSchema, stopWorkTimer, timerNotesSchema } from '../services/workTimer.js';

const router = Router();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
router.get('/', async (_req, res) => { res.json(await getWorkTimer()); });
router.post('/start', async (req, res) => { res.json(await startWorkTimer(startTimerSchema.parse(req.body))); });
router.post('/import', async (req, res) => { res.json(await startWorkTimer(importTimerSchema.parse(req.body), true)); });
router.post('/:id/stop', async (req, res) => { res.json(await stopWorkTimer(req.params.id, stopTimerSchema.parse(req.body))); });
router.patch('/:id', async (req, res) => { res.json(await changeWorkTimer(req.params.id, timerNotesSchema.parse(req.body).notes)); });
router.delete('/:id', async (req, res) => { res.json(await changeWorkTimer(req.params.id, null)); });
export { router as workTimerRouter };
