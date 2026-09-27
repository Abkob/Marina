import { Router } from 'express';
import { query } from '../db.js';
import { getCodexWorkerStatus } from '../services/codexWorker.js';

const router = Router();

router.get('/worker/status', (_req, res) => {
  res.json(getCodexWorkerStatus());
});

router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const { rows } = await query(
    `SELECT id,source,agent_kind,session_id,user_message,intent,intent_confidence,
            model,status,summary,error,started_at,finished_at,metadata_json
     FROM agent_runs ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  res.json(rows.map(row => ({
    ...row,
    metadata: safeJson(row.metadata_json),
    metadata_json: undefined,
  })));
});

router.get('/:id', async (req, res) => {
  const [{ rows: runs }, { rows: events }] = await Promise.all([
    query('SELECT * FROM agent_runs WHERE id=$1', [req.params.id]),
    query('SELECT * FROM agent_events WHERE run_id=$1 ORDER BY sequence ASC', [req.params.id]),
  ]);
  if (!runs.length) return res.status(404).json({ error: 'Agent run not found' });
  const run = runs[0];
  res.json({
    ...run,
    metadata: safeJson(run.metadata_json),
    metadata_json: undefined,
    events: events.map(event => ({
      ...event,
      data: safeJson(event.data_json),
      data_json: undefined,
    })),
  });
});

function safeJson(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export { router as agentRunsRouter };
