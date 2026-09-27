import 'express-async-errors';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initSchema, pool, query } from '../db.js';
import { workTimerRouter } from '../routes/work-timer.js';

describe.skipIf(!process.env.DATABASE_URL_TEST)('shared work timer against PostgreSQL', () => {
  let server: Server;
  let origin: string;
  const routineId = crypto.randomUUID();
  async function request(path = '', body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const res = await fetch(`${origin}/api/work-timer${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  }
  const taskStart = (taskId = 'timer-test-task-1', sessionId = crypto.randomUUID()) => ({ taskId, sessionId, notes: 'Focus proof' });
  const taskImport = () => ({ ...taskStart(), startedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
  beforeAll(async () => {
    await initSchema();
    const app = express();
    app.use(express.json()); app.use('/api/work-timer', workTimerRouter);
    app.use(((error, _req, res, _next) => res.status(error.status ?? (error.name === 'ZodError' ? 400 : 500)).json({ error: error.message })) as express.ErrorRequestHandler);
    server = await new Promise<Server>(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  beforeEach(async () => {
    await query('TRUNCATE work_timers,work_sessions,routine_entries,tasks,routines CASCADE');
    const now = new Date().toISOString();
    for (const id of ['timer-test-task-1', 'timer-test-task-2']) await query('INSERT INTO tasks (id,title,created_at,updated_at) VALUES ($1,$1,$2,$2)', [id, now]);
    await query(`INSERT INTO routines (id,title,cadence,weekly_target,weekdays,start_date,target_count,target_unit,planned_minutes,created_at,updated_at)
      VALUES ($1,'Routine proof','daily',7,'[1,2,3,4,5,6,7]','2000-01-01',20,'minutes',20,$2,$2)`, [routineId, now]);
  });
  afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); });

  it('returns the same persisted timer to another session', async () => {
    const started = await request('/start', taskStart());
    expect(started.status).toBe(200);
    const anotherDevice = await request();
    expect(anotherDevice.body.timer).toEqual(started.body.timer);
    expect(anotherDevice.body.timer).toMatchObject({ taskId: 'timer-test-task-1', notes: 'Focus proof' });
  });
  it('serializes competing starts from two devices into one active timer', async () => {
    const replies = await Promise.all([request('/start', taskStart()), request('/start', taskStart('timer-test-task-2'))]);
    expect(replies.map(reply => reply.status)).toEqual([200, 200]);
    expect(replies.filter(reply => reply.body.started)).toHaveLength(1);
    expect(replies[0].body.timer.sessionId).toBe(replies[1].body.timer.sessionId);
  });
  it('logs simultaneous stops once and recalculates task time atomically', async () => {
    const started = await request('/import', taskImport());
    const id = started.body.timer.sessionId;
    const replies = await Promise.all([request(`/${id}/stop`, {}), request(`/${id}/stop`, {})]);
    expect(replies.map(reply => reply.status)).toEqual([200, 200]);
    expect(replies.filter(reply => reply.body.duplicate)).toHaveLength(1);
    expect(replies.map(reply => reply.body.minutes)).toEqual([20, 20]);
    expect((await query('SELECT * FROM work_sessions')).rows).toHaveLength(1);
    expect((await query('SELECT actual_minutes FROM tasks WHERE id=$1', ['timer-test-task-1'])).rows[0].actual_minutes).toBe(20);
    expect((await request()).body.timer).toBeNull();
  });
  it('never lets a stale stop clear a newer timer or restart a finished ID', async () => {
    const input = taskStart();
    await request('/start', input); await request(`/${input.sessionId}/stop`, {});
    expect((await request('/start', input)).body.timer).toBeNull();
    const next = await request('/start', taskStart('timer-test-task-2'));
    const stale = await request(`/${input.sessionId}/stop`, {});
    expect(stale.body.timer.sessionId).toBe(next.body.timer.sessionId);
    expect(stale.body.duplicate).toBe(true);
  });
  it('saves routine progress once when both devices stop it', async () => {
    const started = await request('/import', { taskId: '', routineId, sessionId: crypto.randomUUID(), startedAt: new Date(Date.now() - 20 * 60_000).toISOString(), notes: 'Routine notes' });
    const id = started.body.timer.sessionId;
    const replies = await Promise.all([request(`/${id}/stop`, {}), request(`/${id}/stop`, {})]);
    expect(replies.map(reply => reply.status)).toEqual([200, 200]);
    expect((await query('SELECT * FROM routine_entries')).rows).toEqual([expect.objectContaining({ minutes: 20, status: 'completed' })]);
    expect((await query('SELECT * FROM work_sessions')).rows).toEqual([expect.objectContaining({ routine_id: routineId, task_id: null, minutes: 20 })]);
  });
  it('keeps a forgotten routine running until focused minutes are corrected', async () => {
    const started = await request('/import', { taskId: '', routineId, sessionId: crypto.randomUUID(), startedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() });
    const id = started.body.timer.sessionId;
    expect((await request(`/${id}/stop`, {})).status).toBe(400);
    expect((await request()).body.timer.sessionId).toBe(id);
    expect((await request(`/${id}/stop`, { minutes: 35 })).body.minutes).toBe(35);
  });
  it('rolls back a failed save and preserves the active timer', async () => {
    const started = await request('/start', taskStart());
    await query('DELETE FROM tasks WHERE id=$1', ['timer-test-task-1']);
    expect((await request(`/${started.body.timer.sessionId}/stop`, {})).status).toBe(409);
    expect((await request()).body.timer.sessionId).toBe(started.body.timer.sessionId);
    expect((await query('SELECT * FROM work_sessions')).rows).toHaveLength(0);
  });
  it('syncs notes and discards without logging or resurrecting stale local state', async () => {
    const input = taskImport();
    await request('/import', input);
    await request(`/${input.sessionId}`, { notes: 'Shared note' }, 'PATCH');
    expect((await request()).body.timer.notes).toBe('Shared note');
    await request(`/${input.sessionId}`, undefined, 'DELETE');
    expect((await request('/import', input)).body.timer).toBeNull();
    expect((await request(`/${input.sessionId}/stop`, {})).status).toBe(409);
    expect((await query('SELECT * FROM work_sessions')).rows).toHaveLength(0);
  });
  it('imports old task timers with a deterministic ID and preserves the original start', async () => {
    const { sessionId: _unused, ...input } = taskImport();
    const first = await request('/import', input);
    const second = await request('/import', input);
    expect(first.body.timer.startedAt).toBe(input.startedAt);
    expect(second.body.timer.sessionId).toBe(first.body.timer.sessionId);
    await request(`/${first.body.timer.sessionId}/stop`, {});
    expect((await request('/import', input)).body.timer).toBeNull();
  });
});
