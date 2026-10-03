import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { activeTaskSql } from '../utils/archiveVisibility.js';
import { loadWorkAccounting, localClock } from '../services/workAccounting.js';
import { MAX_WORK_MINUTES } from '../../shared/workAccounting.js';

export const workAccountingRouter = Router({ mergeParams: true });

workAccountingRouter.get<{ taskId: string }>('/', async (req, res) => {
  const { rows: prefs } = await query("SELECT timezone FROM user_schedule_prefs WHERE id='default'");
  const timezone = prefs[0]?.timezone as string | undefined;
  const now = new Date();
  const from = localClock(now, timezone).today;
  const end = new Date(from + 'T12:00:00Z'); end.setUTCDate(end.getUTCDate() + 34);
  const snapshot = await loadWorkAccounting(from, end.toISOString().slice(0, 10), timezone, [String(req.params.taskId)], now);
  const work = snapshot.accounting.get(String(req.params.taskId));
  if (!work) return res.status(404).json({ error: 'Task unavailable.' });
  const input = snapshot.inputs.get(String(req.params.taskId))!;
  res.json({ work, window: snapshot.window, as_of: snapshot.as_of, versions: {
    work: Number(input.work_version), logs: Number(input.worklog_version), forecast: Number(input.forecast_revision),
  }, forecast_updated_at: input.remaining_forecast_updated_at ?? null });
});

const forecastRequest = z.object({
  minutes: z.number().int().min(0).max(MAX_WORK_MINUTES).nullable(),
  expected: z.object({ work: z.number().int().positive(), logs: z.number().int().nonnegative(), forecast: z.number().int().nonnegative() }).strict(),
}).strict();
workAccountingRouter.patch<{ taskId: string }>('/', async (req, res) => {
  const parsed = forecastRequest.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Provide whole remaining minutes and the versions shown when you opened the task.' });
  const { minutes, expected } = parsed.data;
  const { rows } = await query(`UPDATE tasks SET remaining_forecast_minutes=$2,
    remaining_forecast_work_version=CASE WHEN $2::integer IS NULL THEN NULL ELSE work_version END,
    remaining_forecast_log_version=CASE WHEN $2::integer IS NULL THEN NULL ELSE worklog_version END,
    remaining_forecast_updated_at=CASE WHEN $2::integer IS NULL THEN NULL ELSE $6 END,
    forecast_revision=forecast_revision+1, updated_at=$6
    WHERE id=$1 AND ${activeTaskSql()} AND NOT completed AND status<>'done'
      AND work_version=$3 AND worklog_version=$4 AND forecast_revision=$5 RETURNING id`,
  [String(req.params.taskId), minutes, expected.work, expected.logs, expected.forecast, new Date().toISOString()]);
  if (!rows.length) return res.status(409).json({ error: 'This task or its work log changed. Refresh the time details before saving your forecast.' });
  res.json({ saved: true });
});
