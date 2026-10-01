import { Router } from 'express';
import { serve } from 'inngest/express';
import { resourceInngest, durableProcessingConfigured, dispatchResourceEvents, reconcileResourceDispatch } from '../services/resourceDispatch.js';
import { processResourceJob } from '../services/resourceProcessing.js';
import { reconcileUploads } from '../services/resourceUploads.js';

export const processDocument = resourceInngest.createFunction({
  id: 'process-resource-stage', triggers: [{ event: 'marina/resource.process' }],
  retries: 3, concurrency: { limit: 2 },
}, async ({ event, step }) => {
  const { jobId, version } = event.data;
  if (typeof jobId !== 'string' || !Number.isInteger(version)) return { ignored: true };
  await step.run('process-stage', () => processResourceJob(jobId, version));
  await step.run('dispatch-next-stage', () => dispatchResourceEvents());
  return { ok: true };
});

export const recoverDocuments = resourceInngest.createFunction({
  id: 'recover-resource-work', triggers: [{ cron: '* * * * *' }], retries: 3,
  concurrency: { limit: 1 },
}, async ({ step }) => {
  await step.run('recover-transfers', () => reconcileUploads());
  await step.run('recover-jobs', () => reconcileResourceDispatch());
  return step.run('deliver-outbox', () => dispatchResourceEvents());
});

const router = Router();
router.use((_req, res, next) => {
  if (!durableProcessingConfigured()) return res.status(503).json({ error: 'Background processing is not configured' });
  next();
});
// Cookie authentication intentionally does not wrap this route. The SDK checks
// signed Inngest requests with INNGEST_SIGNING_KEY in production.
router.use(serve({ client: resourceInngest, functions: [processDocument, recoverDocuments] }));
export { router as resourceWorkflowsRouter };
