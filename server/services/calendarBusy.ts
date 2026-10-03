import { query as defaultQuery } from '../db.js';
import { activeMeetingSql, activeEventSql } from '../utils/archiveVisibility.js';
import { eventDateServer } from './planLayout.js';
import { loadRoutineReservations } from './routinePlanning.js';
import type { PoolClient } from 'pg';
/** Shared read-only commitments. A supplied client keeps plan reads within their SQL snapshot. */
export async function loadBusyWindow(fromStr: string, toStr: string, client?: Pick<PoolClient, 'query'>) {
  const query = client ? client.query.bind(client) : defaultQuery;
  const [{ rows: meetingRows }, { rows: eventRows }] = await Promise.all([
    query(
      `SELECT id, title, scheduled_at, duration_minutes FROM meetings
       WHERE ${activeMeetingSql()} AND DATE(scheduled_at::timestamp) BETWEEN $1 AND $2`,
      [fromStr, toStr],
    ),
    query(`SELECT id, title, day_index, start_hour, duration_hours, week_start FROM events WHERE week_start IS NOT NULL AND ${activeEventSql()}`),
  ]);

  const busy: Array<{ date: string; start_hour: number; duration_hours: number; title: string; kind: 'meeting' | 'block' }> = [];
  for (const m of meetingRows as Record<string, unknown>[]) {
    const dt = new Date(String(m.scheduled_at));
    if (Number.isNaN(dt.getTime())) continue;
    busy.push({
      date: String(m.scheduled_at).slice(0, 10),
      start_hour: dt.getHours() + dt.getMinutes() / 60,
      duration_hours: Math.max(0.25, Number(m.duration_minutes ?? 60) / 60),
      title: String(m.title ?? 'Meeting'),
      kind: 'meeting',
    });
  }
  for (const ev of eventRows as Record<string, unknown>[]) {
    const date = eventDateServer(String(ev.week_start), Number(ev.day_index ?? 0));
    if (date < fromStr || date > toStr) continue;
    busy.push({
      date,
      start_hour: Number(ev.start_hour ?? 9),
      duration_hours: Math.max(0.25, Number(ev.duration_hours ?? 1)),
      title: String(ev.title ?? 'Block'),
      kind: 'block',
    });
  }
  const { rows: routinePrefs } = await query("SELECT timezone FROM user_schedule_prefs WHERE id='default'");
  const routineToday = new Intl.DateTimeFormat('en-CA', { timeZone: String(routinePrefs[0]?.timezone || 'UTC') }).format(new Date());
  for (const routine of await loadRoutineReservations(fromStr, toStr, routineToday, client)) {
    if (!routine.preferred_time) continue;
    const [hour, minute] = routine.preferred_time.split(':').map(Number);
    busy.push({ date: routine.date, start_hour: hour + minute / 60, duration_hours: routine.minutes / 60, title: `Routine: ${routine.title}`, kind: 'block' });
  }
  return busy;
}
