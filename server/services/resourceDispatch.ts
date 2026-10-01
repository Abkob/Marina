import crypto from 'node:crypto';
import { Inngest } from 'inngest';
import { query } from '../db.js';
import { isVercelRuntime } from '../runtime.js';
import { runInBackground } from '../utils/background.js';
import { processPendingResources, reclaimResourceJobs } from './resourceProcessing.js';

export function durableProcessingConfigured() {
  return Boolean(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY) || localCoordinatorEnabled();
}
function localCoordinatorEnabled() {
  return !isVercelRuntime && process.env.NODE_ENV !== 'production' && process.env.INNGEST_DEV === '1';
}
export const resourceInngest = new Inngest({
  id: 'marina-resources',
  isDev: localCoordinatorEnabled(),
  fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }),
});

export async function reconcileResourceDispatch() {
  await reclaimResourceJobs();
  // A sent event may be dropped or a coordinator may be unavailable. Jobs
  // remaining eligible get a new event ID, including after a restore.
  await query(
    `INSERT INTO resource_outbox (id,job_id,version)
     SELECT $1 || ':' || j.id,j.id,j.version FROM resource_processing_jobs j
     WHERE j.status='queued' AND j.next_attempt_at<=NOW()
       AND (j.last_dispatched_at IS NULL OR j.last_dispatched_at < NOW()-INTERVAL '2 minutes')
       AND NOT EXISTS (SELECT 1 FROM resource_outbox o WHERE o.job_id=j.id AND o.version=j.version AND o.delivered_at IS NULL)
     ON CONFLICT DO NOTHING`, [crypto.randomUUID()],
  );
}

export async function dispatchResourceEvents() {
  if (!durableProcessingConfigured()) return 0;
  const { rows } = await query<{ id: string; job_id: string; version: number }>(
    `SELECT o.id,o.job_id,o.version FROM resource_outbox o JOIN resource_processing_jobs j ON j.id=o.job_id
     WHERE o.delivered_at IS NULL AND o.version=j.version AND j.status='queued' AND j.next_attempt_at<=NOW()
     ORDER BY o.created_at LIMIT 50`,
  );
  if (!rows.length) return 0;
  try {
    await resourceInngest.send(rows.map(row => ({ id: row.id, name: 'marina/resource.process', data: { jobId: row.job_id, version: row.version } })));
    await query('UPDATE resource_outbox SET delivered_at=NOW(),attempts=attempts+1,last_error=NULL WHERE id=ANY($1)', [rows.map(row => row.id)]);
    await query('UPDATE resource_processing_jobs SET last_dispatched_at=NOW() WHERE id=ANY($1)', [rows.map(row => row.job_id)]);
    return rows.length;
  } catch (error) {
    await query("UPDATE resource_outbox SET attempts=attempts+1,last_error='Processing service unavailable; delivery will retry' WHERE id=ANY($1)", [rows.map(row => row.id)]);
    throw error;
  }
}

export function wakeResourceProcessing() {
  if (process.env.NODE_ENV === 'test') return;
  // This only accelerates work; jobs/outbox and the scheduled reconciler own
  // recovery. Never make a successful resource save depend on external delivery.
  void runInBackground(durableProcessingConfigured() ? dispatchResourceEvents()
    : !isVercelRuntime ? processPendingResources(1) : Promise.resolve(0), 'resource processing wake-up');
}
