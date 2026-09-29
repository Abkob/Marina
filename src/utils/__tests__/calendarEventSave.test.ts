import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import 'express-async-errors';
import type { Server } from 'node:http';

const db = vi.hoisted(() => ({ query: vi.fn(), write: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../server/db.js', () => ({
  query: db.query,
  transaction: db.transaction,
  buildUpdate: (data: Record<string, unknown>) => ({ sets: Object.keys(data).map((key, i) => `${key}=$${i + 1}`).join(','), vals: Object.values(data) }),
}));
import { eventsRouter } from '../../../server/routes/events';
let server: Server;
let url: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/events', eventsRouter);
  app.use((_error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: 'Save failed' }));
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/events`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => {
  vi.clearAllMocks(); db.write.mockReset().mockResolvedValue({ rowCount: 1, rows: [] });
  db.transaction.mockImplementation(callback => callback({ query: db.write }));
});
const send = (path: string, method: string, body: unknown) => fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

it('creates a session and its linked tasks in one transaction', async () => {
  const response = await send('', 'POST', { title: 'Study', day_index: 1, task_link_changes: { add: [{ task_id: 'task', planned_minutes: 90 }] } });
  expect(response.status).toBe(200);
  const { id } = await response.json() as { id: string };
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(db.write).toHaveBeenCalledTimes(2);
  expect(db.write.mock.calls[1][1]).toEqual([expect.any(String), id, 'task', 90, expect.any(String)]);
  expect(db.query).not.toHaveBeenCalled();
});
it('propagates a link failure out of the transaction without reporting success', async () => {
  db.write.mockResolvedValueOnce({ rowCount: 1 }).mockRejectedValueOnce(new Error('Link failed'));
  const response = await send('', 'POST', { title: 'Study', task_link_changes: { add: [{ task_id: 'missing' }] } });
  expect(response.status).toBe(500);
  expect(db.transaction).toHaveBeenCalledTimes(1);
});
it('rejects invalid link requests before writing and scopes unlinking to its event', async () => {
  expect((await send('', 'POST', { title: 'Study', task_link_changes: { add: [{ task_id: 't', planned_minutes: -1 }] } })).status).toBe(400);
  expect(db.transaction).not.toHaveBeenCalled();
  expect((await send('/event', 'PATCH', { task_link_changes: { remove: ['link'] } })).status).toBe(200);
  expect(db.write).toHaveBeenLastCalledWith('DELETE FROM event_task_links WHERE id=$1 AND event_id=$2', ['link', 'event']);
});
it('keeps existing links untouched when only moving or resizing a block', async () => {
  expect((await send('/event', 'PATCH', { duration_hours: 2 })).status).toBe(200);
  expect(db.write).toHaveBeenCalledTimes(1);
  expect(db.write.mock.calls[0][0]).toContain('UPDATE events');
});
