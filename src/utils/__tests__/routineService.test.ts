import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ query: vi.fn(), clientQuery: vi.fn() }));
vi.mock('../../../server/db.js', () => ({ query: db.query, transaction: async (fn: Function) => fn({ query: db.clientQuery }) }));
import { checkInRoutine, createRoutineSchema, isRoutinesSchemaMissing, logRoutineSession, routineSessionSchema, updateRoutine, updateRoutineSchema } from '../../../server/services/routines';

const id = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const routine = { id, title: 'Review', note: '', goal_id: null, cadence: 'daily', weekdays: [1, 2, 3, 4, 5], weekly_target: 3,
  target_count: 20, target_unit: 'minutes', planned_minutes: 20, preferred_time: null, start_date: '2026-09-21', archived_at: null };
const session = { id: sessionId, date: '2026-09-22', started_at: '2026-09-22T10:00:00Z', ended_at: '2026-09-22T10:20:00Z', minutes: 20 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
  db.query.mockReset().mockResolvedValue({ rows: [{ timezone: 'Asia/Beirut' }] }); db.clientQuery.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe('routine validation and rollout safety', () => {
  it('rejects invalid dates, duplicate weekdays, impossible weekly targets, and malformed times', () => {
    const { id: _id, archived_at: _archive, ...input } = routine;
    expect(createRoutineSchema.safeParse(input).success).toBe(true);
    expect(createRoutineSchema.safeParse({ ...input, start_date: '2026-02-30' }).success).toBe(false);
    expect(createRoutineSchema.safeParse({ ...input, weekdays: [1, 1] }).success).toBe(false);
    expect(createRoutineSchema.safeParse({ ...input, cadence: 'weekly', weekdays: [1, 3], weekly_target: 3 }).success).toBe(false);
    expect(createRoutineSchema.safeParse({ ...input, preferred_time: '25:00' }).success).toBe(false);
    expect(createRoutineSchema.safeParse({ ...input, goal_id: 'legacy-goal-id' }).success).toBe(true);
    expect(createRoutineSchema.safeParse({ ...input, goal_id: '' }).success).toBe(false);
    expect(createRoutineSchema.safeParse({ ...input, preferred_time: '23:50' }).success).toBe(false);
    expect(createRoutineSchema.safeParse({ ...input, target_count: 21 }).success).toBe(false);
  });
  it('keeps schedule history immutable and supports archive rather than deletion', () => {
    expect(updateRoutineSchema.safeParse({ archived: true }).success).toBe(true);
    expect(updateRoutineSchema.safeParse({ title: 'New label' }).success).toBe(true);
    expect(updateRoutineSchema.safeParse({ weekdays: [7] }).success).toBe(false);
    expect(updateRoutineSchema.safeParse({ archived: false }).success).toBe(false);
  });
  it('rejects invalid or overreported sessions', () => {
    expect(routineSessionSchema.safeParse(session).success).toBe(true);
    expect(routineSessionSchema.safeParse({ ...session, minutes: 100 }).success).toBe(false);
    expect(routineSessionSchema.safeParse({ ...session, ended_at: '2026-09-22T09:00:00Z' }).success).toBe(false);
  });
  it('only treats specific routine schema omissions as missing feature, never connection errors', () => {
    expect(isRoutinesSchemaMissing({ code: '42P01', message: 'relation "routines" does not exist' })).toBe(true);
    expect(isRoutinesSchemaMissing({ code: '42703', message: 'column "routine_id" does not exist' })).toBe(true);
    expect(isRoutinesSchemaMissing({ code: '42P01', message: 'relation "tasks" does not exist' })).toBe(false);
    expect(isRoutinesSchemaMissing({ code: 'ECONNRESET', message: 'routines' })).toBe(false);
  });
  it('archives at the next local day while retaining the real UTC timestamp', async () => {
    vi.setSystemTime(new Date('2026-09-22T22:30:00Z'));
    await updateRoutine(id, { archived: true });
    expect(db.query.mock.calls[1][1][4]).toBe('2026-09-22T22:30:00.000Z');
    expect(db.query.mock.calls[1][1][5]).toBe('2026-09-24');
  });
  it('rejects future completions and focus logs, but allows skipping a future eligible day', async () => {
    await expect(checkInRoutine(id, { date: '2026-09-23', status: 'completed' })).rejects.toMatchObject({ status: 400 });
    await expect(logRoutineSession(id, { ...session, date: '2026-09-23' })).rejects.toMatchObject({ status: 400 });
    expect(db.clientQuery).not.toHaveBeenCalled();
    db.clientQuery.mockResolvedValueOnce({ rows: [routine] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ status: 'skipped' }] });
    expect((await checkInRoutine(id, { date: '2026-09-23', status: 'skipped' }))?.status).toBe('skipped');
  });
});

describe('routine session persistence', () => {
  it('retry returns original minutes without inserting or incrementing anything', async () => {
    db.clientQuery.mockResolvedValueOnce({ rows: [routine] })
      .mockResolvedValueOnce({ rows: [{ id: sessionId, routine_id: id, minutes: 20 }] })
      .mockResolvedValueOnce({ rows: [{ date: session.date, minutes: 20, status: 'completed' }] });
    const result = await logRoutineSession(id, { ...session, minutes: 21 });
    expect(result.duplicate).toBe(true);
    expect(result.minutes).toBe(20);
    expect(db.clientQuery.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
  });
  it('finishes a timer started before archiving and retries without duplicating its work', async () => {
    const archived = { ...routine, archived_at: '2026-09-22T10:10:00Z', archived_on: '2026-09-23' };
    db.clientQuery.mockResolvedValueOnce({ rows: [archived] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ minutes: 20, status: 'completed' }] });
    expect((await logRoutineSession(id, session)).duplicate).toBe(false);
    db.clientQuery.mockResolvedValueOnce({ rows: [archived] })
      .mockResolvedValueOnce({ rows: [{ id: sessionId, routine_id: id, minutes: 20 }] })
      .mockResolvedValueOnce({ rows: [{ minutes: 20, status: 'completed' }] });
    const retry = await logRoutineSession(id, session);
    expect(retry.duplicate).toBe(true);
    expect(retry.minutes).toBe(20);
    expect(db.clientQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO work_sessions'))).toHaveLength(1);
  });
  it('rejects sessions started after archive and dates outside the archived eligibility window', async () => {
    db.clientQuery.mockResolvedValueOnce({ rows: [{ ...routine, archived_at: '2026-09-22T09:59:59Z', archived_on: '2026-09-23' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(logRoutineSession(id, session)).rejects.toMatchObject({ status: 409 });
    db.clientQuery.mockResolvedValueOnce({ rows: [{ ...routine, archived_at: '2026-09-22T10:10:00Z', archived_on: '2026-09-22' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(logRoutineSession(id, session)).rejects.toMatchObject({ status: 400 });
    expect(db.clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });
  it('rejects future timestamps and a date that does not match the schedule timezone', async () => {
    await expect(logRoutineSession(id, { ...session, ended_at: '2026-09-22T12:00:31Z' })).rejects.toMatchObject({ status: 400 });
    await expect(logRoutineSession(id, { ...session, started_at: '2026-09-22T12:10:00Z', ended_at: '2026-09-22T12:30:00Z' })).rejects.toMatchObject({ status: 400 });
    await expect(logRoutineSession(id, { ...session, date: '2026-09-21' })).rejects.toMatchObject({ status: 400 });
    expect(db.clientQuery).not.toHaveBeenCalled();
  });
  it('uses the local start date across midnight, allowing a pre-archive session to finish later', async () => {
    vi.setSystemTime(new Date('2026-09-23T12:00:00Z'));
    const archived = { ...routine, archived_at: '2026-09-22T22:40:00Z', archived_on: '2026-09-24' };
    const lateSession = { ...session, date: '2026-09-23', started_at: '2026-09-22T22:30:00Z', ended_at: '2026-09-23T01:00:00Z' };
    db.clientQuery.mockResolvedValueOnce({ rows: [archived] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ minutes: 20 }] });
    expect((await logRoutineSession(id, lateSession)).minutes).toBe(20);
    expect(db.clientQuery.mock.calls[4][1][2]).toBe('2026-09-23');
  });
  it('saves one work session and credits only the routine, never a task', async () => {
    db.clientQuery.mockResolvedValueOnce({ rows: [routine] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'entry', minutes: 10, status: 'partial' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'entry', minutes: 30, status: 'completed' }] });
    const result = await logRoutineSession(id, session);
    expect(result.entry?.minutes).toBe(30);
    expect(result.duplicate).toBe(false);
    expect(db.clientQuery.mock.calls[2][0]).toContain('INSERT INTO work_sessions');
    const upsert = db.clientQuery.mock.calls[4];
    expect(upsert[1][3]).toBe('completed');
    expect(upsert[1][4]).toBe(30);
    expect(db.clientQuery.mock.calls.some(([sql]) => /UPDATE tasks/.test(sql))).toBe(false);
  });
  it('does not auto-complete a problem target from minutes alone', async () => {
    db.clientQuery.mockResolvedValueOnce({ rows: [{ ...routine, target_unit: 'problems', target_count: 5 }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'partial' }] });
    await logRoutineSession(id, session);
    expect(db.clientQuery.mock.calls[4][1][3]).toBe('partial');
    expect(db.clientQuery.mock.calls[4][1][5]).toBe(0);
  });
  it('undo preserves logged minutes while undoing explicit completion', async () => {
    db.clientQuery.mockResolvedValueOnce({ rows: [routine] })
      .mockResolvedValueOnce({ rows: [{ id: 'entry', minutes: 10, status: 'completed' }] })
      .mockResolvedValueOnce({ rows: [{ status: 'partial', minutes: 10 }] });
    const result = await checkInRoutine(id, { date: session.date, status: 'pending' });
    expect(result?.status).toBe('partial');
    expect(db.clientQuery.mock.calls[2][1][4]).toBe(10);
    expect(db.clientQuery.mock.calls.some(([sql]) => /DELETE/.test(sql))).toBe(false);
  });
  it('undo removes an unworked check-in rather than storing fictional missed rows', async () => {
    db.clientQuery.mockResolvedValueOnce({ rows: [routine] }).mockResolvedValueOnce({ rows: [{ minutes: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await checkInRoutine(id, { date: session.date, status: 'pending' })).toBeNull();
    expect(db.clientQuery.mock.calls[2][0]).toContain('DELETE FROM routine_entries');
  });
  it('rejects writes to archived routines and collisions with another activity', async () => {
    db.clientQuery.mockResolvedValueOnce({ rows: [{ ...routine, archived_at: '2026-09-22T11:00:00Z' }] });
    await expect(checkInRoutine(id, { date: session.date, status: 'completed' })).rejects.toMatchObject({ status: 409 });
    db.clientQuery.mockResolvedValueOnce({ rows: [routine] }).mockResolvedValueOnce({ rows: [{ routine_id: 'another' }] });
    await expect(logRoutineSession(id, session)).rejects.toMatchObject({ status: 409 });
  });
});
