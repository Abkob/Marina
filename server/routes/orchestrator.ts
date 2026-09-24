import { Router } from 'express';

export const orchestratorRouter = Router();

// All conversation uses the same model-led engine; legacy clients cannot invoke
// the retired keyword classifier through an alternate endpoint.
orchestratorRouter.post('/interpret', (_req, res) => {
  res.status(410).json({ error: 'The intent classifier has been retired. Use /api/ai/chat with conversation messages.', state_changed: false });
});
