import {Router} from 'express';
import {z} from 'zod';
import {rateLimit} from '../utils/rateLimit.js';
import {runEmbeddingTrial} from '../services/embeddingTrial.js';
import {EmbeddingTrialError} from '../services/nemotronEmbeddings.js';
import {NEMOTRON_EMBED_MODEL} from '../../shared/embeddingTrial.js';
const router = Router();
router.post('/trial', rateLimit(3, 60_000, 'embedding-trial'), async (req, res) => {
  const input = z.object({model: z.literal(NEMOTRON_EMBED_MODEL)}).strict().safeParse(req.body);
  if (!input.success) return res.status(400).json({error: 'Choose a supported search-model trial.'});
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', cancel);
  try {
    const result = await runEmbeddingTrial(controller.signal);
    if (!controller.signal.aborted) res.json(result);
  } catch (error) {
    if (!controller.signal.aborted) res.status(error instanceof EmbeddingTrialError ? error.status : 502)
      .json({error: error instanceof EmbeddingTrialError ? error.message : 'The search-model trial could not finish.'});
  } finally { res.off('close', cancel); }
});
export {router as embeddingTrialsRouter};
