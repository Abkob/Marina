import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertPlanningTestDatabase, validatePlanningTestUrl } from './databaseFixtures';
import { loadWorkAccounting } from '../../server/services/workAccounting';
import { dateToWeekPos } from '../../src/utils/calendar';

vi.mock('../../server/services/obsidianVaultSync.js', async original => ({ ...await original<typeof import('../../server/services/obsidianVaultSync.js')>(), scheduleObsidianVaultSync: vi.fn() }));
describe.skipIf(!process.env.DATABASE_URL_TEST)('P03.1 work accounting (real PostgreSQL and HTTP)', () => {
  let pool: pg.Pool; let server: typeof import('../../server/__tests__/setup');
  const taskIds: string[] = []; const eventIds: string[] = [];
  const task = async (estimate = 60) => {
    const id = randomUUID(); taskIds.push(id);
    await pool.query("INSERT INTO tasks(id,title,estimated_minutes,due_date,created_at,updated_at) VALUES ($1,'Synthetic accounting work',$2,'2099-01-10',NOW()::text,NOW()::text)", [id, estimate]); return id;
  };
  const session = async (taskId: string, minutes: number) => {
    const id = randomUUID();
    await pool.query("INSERT INTO work_sessions(id,task_id,minutes,started_at,created_at) VALUES ($1,$2,$3,NOW()::text,NOW()::text)", [id, taskId, minutes]); return id;
  };
  const reserve = async (taskId: string, date = '2099-01-04', minutes = 90) => {
    const id = randomUUID(); eventIds.push(id); const position = dateToWeekPos(date);
    await pool.query("INSERT INTO events(id,title,week_start,day_index,start_hour,duration_hours,created_at,updated_at) VALUES ($1,'Synthetic reservation',$2,$3,10,$4,NOW()::text,NOW()::text)", [id, position.week_start, position.day_index, minutes / 60]);
    await pool.query("INSERT INTO event_task_links(id,event_id,task_id,planned_minutes,created_at) VALUES ($1,$2,$3,$4,NOW()::text)", [randomUUID(), id, taskId, minutes]); return id;
  };
  const snapshot = (ids?: string[]) => loadWorkAccounting('2099-01-01', '2099-01-31', 'UTC', ids, new Date('2099-01-01T00:00:00Z'));
  const read = async (id: string) => (await fetch(`${server.baseUrl}/api/tasks/${id}/work-accounting`)).json();
  const save = (id: string, body: unknown) => fetch(`${server.baseUrl}/api/tasks/${id}/work-accounting`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: validatePlanningTestUrl(process.env.DATABASE_URL_TEST, process.env.PLANNING_TEST_DB), max: 4 });
    const client = await pool.connect(); try { await assertPlanningTestDatabase(client); } finally { client.release(); }
    server = await import('../../server/__tests__/setup'); await server.startTestServer();
  });
  afterEach(async () => { await pool.query('DELETE FROM events WHERE id=ANY($1)', [eventIds.splice(0)]); await pool.query('DELETE FROM work_sessions WHERE task_id=ANY($1)', [taskIds]); await pool.query('DELETE FROM tasks WHERE id=ANY($1)', [taskIds.splice(0)]); });
  afterAll(async () => { await server?.stopTestServer(); await pool?.end(); const db = await import('../../server/db'); await db.getPool().end(); });

  it('keeps 60 estimated / 70 logged unfinished work unknown', async () => {
    const id = await task(); await session(id, 70);
    expect((await snapshot([id])).accounting.get(id)).toMatchObject({ logged_minutes: 70, remaining_minutes: null, remaining_state: 'overrun' });
  });
  it('saves and reloads a forecast without changing estimate, logs or completion', async () => {
    const id = await task(); await session(id, 70); const before = await read(id);
    expect((await save(id, { minutes: 90, expected: before.versions })).status).toBe(200);
    await reserve(id);
    expect((await snapshot([id])).accounting.get(id)).toMatchObject({ estimated_minutes: 60, logged_minutes: 70, remaining_minutes: 90, reserved_minutes: 90, unscheduled_minutes: 0 });
    expect((await pool.query('SELECT completed FROM tasks WHERE id=$1', [id])).rows[0].completed).toBe(false);
  });
  it('rejects concurrent forecast writers and retains the winning value', async () => {
    const id = await task(); const before = await read(id);
    const results = await Promise.all([30, 90].map(minutes => save(id, { minutes, expected: before.versions })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect([30, 90]).toContain((await read(id)).work.remaining_minutes);
  });
  it('invalidates forecasts for inserted, corrected and removed sessions, including task reassignment', async () => {
    const id = await task(); const other = await task(); const log = await session(id, 10);
    let before = await read(id); await save(id, { minutes: 50, expected: before.versions });
    await pool.query('UPDATE work_sessions SET minutes=15 WHERE id=$1', [log]);
    expect((await read(id)).work.remaining_state).toBe('stale_forecast');
    before = await read(id); await save(id, { minutes: 45, expected: before.versions });
    const otherBefore = await read(other); await save(other, { minutes: 20, expected: otherBefore.versions });
    await pool.query('UPDATE work_sessions SET task_id=$2 WHERE id=$1', [log, other]);
    expect((await read(id)).work.remaining_state).toBe('stale_forecast');
    expect((await read(other)).work.remaining_state).toBe('stale_forecast');
    before = await read(other); await save(other, { minutes: 20, expected: before.versions });
    await pool.query('DELETE FROM work_sessions WHERE id=$1', [log]);
    expect((await read(other)).work.remaining_state).toBe('stale_forecast');
  });
  it('does not invalidate a forecast for touch timestamps or log notes', async () => {
    const id = await task(); const log = await session(id, 10); const before = await read(id);
    await save(id, { minutes: 50, expected: before.versions });
    await pool.query("UPDATE tasks SET updated_at=NOW()::text,last_activity_at=NOW()::text WHERE id=$1", [id]);
    await pool.query("UPDATE work_sessions SET notes='Corrected spelling' WHERE id=$1", [log]);
    expect((await read(id)).work.remaining_basis).toBe('forecast');
  });
  it('invalidates forecasts and reservations when either completion representation is reopened', async () => {
    for (const completedBy of ["completed=true", "status='done'"]) {
      const id = await task(); const before = await read(id);
      await save(id, { minutes: 40, expected: before.versions }); await reserve(id);
      await pool.query(`UPDATE tasks SET ${completedBy} WHERE id=$1`, [id]);
      expect((await read(id)).work.remaining_basis).toBe('completed');
      await pool.query("UPDATE tasks SET completed=false,status='todo' WHERE id=$1", [id]);
      expect((await snapshot([id])).accounting.get(id)).toMatchObject({ remaining_state: 'stale_forecast', reserved_minutes: 0, stale_reservation_count: 1 });
      expect((await read(id)).versions.work).toBe(before.versions.work + 1);
    }
  });
  it('makes reservations stale after scope changes and never refreshes them merely by rerunning migration', async () => {
    const id = await task(); await reserve(id);
    await pool.query("UPDATE tasks SET title='Different work' WHERE id=$1", [id]);
    expect((await snapshot([id])).accounting.get(id)).toMatchObject({ reserved_minutes: 0, stale_reservation_count: 1 });
    await pool.query(await readFile('server/migrations/032-work-accounting.sql', 'utf8'));
    expect((await snapshot([id])).accounting.get(id)?.stale_reservation_count).toBe(1);
    await pool.query('UPDATE event_task_links SET planned_minutes=90 WHERE task_id=$1', [id]);
    expect((await snapshot([id])).accounting.get(id)?.reserved_minutes).toBe(90);
  });
  it('credits only an explicitly linked task and removes credit when an event is canceled by deletion', async () => {
    const parent = await task(); const child = await task(); await pool.query('UPDATE tasks SET parent_task_id=$2 WHERE id=$1', [child, parent]);
    const event = await reserve(parent);
    expect((await snapshot([child])).accounting.get(child)?.reserved_minutes).toBe(0);
    await pool.query('DELETE FROM events WHERE id=$1', [event]);
    expect((await snapshot([parent])).accounting.get(parent)?.reserved_minutes).toBe(0);
  });
  it('rejects reservation credit outside an inherited work window', async () => {
    const parent = await task(); const child = await task();
    await pool.query("UPDATE tasks SET due_date='2099-01-03' WHERE id=$1", [parent]);
    await pool.query('UPDATE tasks SET parent_task_id=$2 WHERE id=$1', [child, parent]); await reserve(child);
    expect((await snapshot([child])).accounting.get(child)).toMatchObject({ reserved_minutes: 0, stale_reservation_count: 1 });
    await pool.query("UPDATE tasks SET due_date='2099-01-10',start_date='2099-01-06' WHERE id=$1", [parent]);
    expect((await snapshot([child])).accounting.get(child)?.reserved_minutes).toBe(0);
  });
  it('does not double-count sessions when a task has multiple event links', async () => {
    const id = await task(180); await session(id, 30); await reserve(id); await reserve(id, '2099-01-05', 30);
    expect((await snapshot([id])).accounting.get(id)).toMatchObject({ logged_minutes: 30, remaining_minutes: 150, reserved_minutes: 120, unscheduled_minutes: 30 });
  });
  it('rejects malformed, stale, unavailable and completed-task forecast writes', async () => {
    const id = await task(); const before = await read(id);
    for (const minutes of [-1, 0.5, '30', 60000001]) expect((await save(id, { minutes, expected: before.versions })).status).toBe(400);
    await pool.query('UPDATE tasks SET completed=true WHERE id=$1', [id]);
    expect((await save(id, { minutes: 30, expected: before.versions })).status).toBe(409);
    expect((await fetch(`${server.baseUrl}/api/tasks/${randomUUID()}/work-accounting`)).status).toBe(404);
  });
  it('allows clearing a stale forecast without restoring a fabricated zero remainder', async () => {
    const id = await task(); const before = await read(id); await save(id, { minutes: 10, expected: before.versions }); await session(id, 70);
    const stale = await read(id); expect((await save(id, { minutes: null, expected: stale.versions })).status).toBe(200);
    expect((await read(id)).work.remaining_state).toBe('overrun');
  });
  it('chat scheduling and preview use the same accounting for a current snapshot', async () => {
    const id = await task(180); await session(id, 30);
    const today = new Date().toISOString().slice(0, 10); const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await reserve(id, tomorrow, 60);
    const { loadSchedulerInputs } = await import('../../server/routes/ai'); const chat = await loadSchedulerInputs(35);
    const response = await fetch(`${server.baseUrl}/api/ai/schedule-preview?from=${today}`); expect(response.status).toBe(200);
    const preview = await response.json(); expect(preview.task_lookup[id].work_accounting).toEqual(chat.work_accounting[id]);
    expect(preview.task_lookup[id]).toMatchObject({ remaining_minutes: 150, unscheduled_minutes: 90 });
  });
  it('aggregates 100,000 session rows, rejects replayed IDs and reflects corrections without double counting', async () => {
    const prefix = randomUUID(); const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO tasks(id,title,estimated_minutes,created_at,updated_at) SELECT $1||'-'||i,'Stress accounting',1000,NOW()::text,NOW()::text FROM generate_series(0,999) i", [prefix]);
      const insert = "INSERT INTO work_sessions(id,task_id,minutes,started_at,created_at) SELECT $1||'-s-'||i,$1||'-'||(i%1000),1,NOW()::text,NOW()::text FROM generate_series(0,99999) i ON CONFLICT(id) DO NOTHING";
      expect((await client.query(insert, [prefix])).rowCount).toBe(100000);
      expect((await client.query(insert, [prefix])).rowCount).toBe(0);
      await client.query("UPDATE work_sessions SET minutes=2 WHERE id IN (SELECT $1||'-s-'||i FROM generate_series(0,999) i)", [prefix]);
      const totals = await client.query("SELECT task_id,SUM(minutes)::int AS total,COUNT(*)::int AS count FROM work_sessions WHERE task_id LIKE $1 GROUP BY task_id", [prefix + '-%']);
      expect(totals.rows).toHaveLength(1000); expect(totals.rows.every(row => row.total === 101 && row.count === 100)).toBe(true);
      const versions = await client.query('SELECT worklog_version FROM tasks WHERE id LIKE $1', [prefix + '-%']);
      expect(versions.rows.every(row => row.worklog_version === 101)).toBe(true);
    } finally { await client.query('ROLLBACK'); client.release(); }
  }, 120_000);
});
