import { Router } from 'express';
import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';
import {
  checkInRoutine, createRoutine, createRoutineSchema, isRoutinesSchemaMissing, listRoutineEntries, listRoutines,
  logRoutineSession, RoutineError, routineCheckInSchema, routineIdSchema, routineRangeSchema, routineSessionSchema,
  updateRoutine, updateRoutineSchema,
} from '../services/routines.js';

const router = Router();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
router.get('/', async (_req, res) => { res.json(await listRoutines()); });
router.get('/entries', async (req, res) => {
  const { from, to } = routineRangeSchema.parse(req.query);
  res.json(await listRoutineEntries(from, to));
});
router.post('/', async (req, res) => { res.status(201).json(await createRoutine(createRoutineSchema.parse(req.body))); });
router.patch('/:id', async (req, res) => { res.json(await updateRoutine(routineIdSchema.parse(req.params.id), updateRoutineSchema.parse(req.body))); });
router.post('/:id/check-in', async (req, res) => { res.json(await checkInRoutine(routineIdSchema.parse(req.params.id), routineCheckInSchema.parse(req.body))); });
router.post('/:id/sessions', async (req, res) => { res.json(await logRoutineSession(routineIdSchema.parse(req.params.id), routineSessionSchema.parse(req.body))); });
router.use(((error, _req, res, next) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(issue => issue.message).join('; ') });
  if (error instanceof RoutineError) return res.status(error.status).json({ error: error.message });
  if (isRoutinesSchemaMissing(error)) return res.status(503).json({ code: 'ROUTINES_NOT_READY', error: 'Routines are not enabled on this deployment yet. Your other data is unchanged.' });
  if (error?.code === '23503') return res.status(400).json({ error: 'The linked goal no longer exists. Choose another goal or leave this routine standalone.' });
  if (error?.code === '23505') return res.status(409).json({ error: 'This session ID has already been used by another activity.' });
  next(error);
}) as ErrorRequestHandler);

export { router as routinesRouter };
