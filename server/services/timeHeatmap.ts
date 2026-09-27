import { query } from '../db.js';
import { timeDate, timeDays, type TimeInterval, type TimeHeatmap } from '../../src/utils/timeHeatmap.js';

export async function getTimeHeatmap(year: number): Promise<TimeHeatmap> {
  const { rows: prefs } = await query("SELECT timezone FROM user_schedule_prefs WHERE id='default'");
  const timezone = String(prefs[0]?.timezone || 'Asia/Beirut');
  // Include intervals crossing the year boundary; the allocator clips them to
  // the requested local year. No day limit: all 365/366 dates can contribute.
  const { rows } = await query(`SELECT id,started_at,ended_at,minutes FROM work_sessions
    WHERE minutes > 0 AND started_at < $2
      AND GREATEST(started_at,COALESCE(ended_at,started_at)) >= $1`, [`${year - 1}-12-29`, `${year + 1}-01-03`]);
  return { year, timezone, today: timeDate(Date.now(), timezone),
    days: timeDays(rows as TimeInterval[], year, timezone), loggedSessionIds: rows.map(row => String(row.id)) };
}
