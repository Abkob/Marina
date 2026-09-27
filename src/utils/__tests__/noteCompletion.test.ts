import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notesRouter } from '../../../server/routes/notes';
import { query } from '../../../server/db';
import { markEmbeddingStale } from '../../../server/services/embeddingLifecycle';
import { setNoteCompleted } from '../../db/queries/notes';
import { apiPatch } from '../../utils/apiFetch';

vi.mock('../../../server/db', async importOriginal => ({
  ...await importOriginal<typeof import('../../../server/db')>(), query: vi.fn(),
}));
vi.mock('../../../server/services/embeddingLifecycle', () => ({ markEmbeddingStale: vi.fn() }));
vi.mock('../../utils/apiFetch', () => ({ apiPatch: vi.fn() }));

async function request(method: string, path: string, body = {}) {
  type Route = { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> };
  const routes = (notesRouter as unknown as { stack: Array<{ route?: Route }> }).stack;
  const route = routes.find(layer => layer.route?.path === path && layer.route.methods[method])!.route;
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  await route.stack.at(-1)!.handle({ body, params: { id: 'note-1' } }, res, vi.fn());
  return res;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-27T22:15:00Z'));
  vi.mocked(query).mockResolvedValue({ rows: [{ id: 'note-1' }] } as never);
});
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

describe('persistent note completion', () => {
  it('saves completion and edited content in a single update while preserving the first finish time', async () => {
    const response = await request('patch', '/:id', { completed: true, content: 'Finished thought' });
    expect(response.json).toHaveBeenCalledWith({ ok: true });
    const [sql, params] = vi.mocked(query).mock.calls[1];
    expect(sql).toContain('content = $2');
    expect(sql).toContain('completed_at = COALESCE(completed_at, $3)');
    expect(sql).not.toContain('created_at =');
    expect(params).toEqual(['2026-09-27T22:15:00.000Z', 'Finished thought', '2026-09-27T22:15:00.000Z', 'note-1']);
    expect(markEmbeddingStale).toHaveBeenCalledWith('note', 'note-1');
  });

  it('clears completion only when explicitly reopened', async () => {
    await request('patch', '/:id', { completed: false });
    expect(vi.mocked(query).mock.calls[1][0]).toContain('completed_at = NULL');
    expect(markEmbeddingStale).not.toHaveBeenCalled();
  });

  it('keeps completion unchanged when editing an existing note', async () => {
    await request('patch', '/:id', { content: 'Revised text' });
    expect(vi.mocked(query).mock.calls[1][0]).not.toContain('completed_at');
  });

  it('rejects invalid completion flags and missing notes without mutating anything', async () => {
    expect((await request('patch', '/:id', { completed: 'false' })).status).toHaveBeenCalledWith(400);
    expect(query).not.toHaveBeenCalled();
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);
    expect((await request('patch', '/:id', { completed: true })).status).toHaveBeenCalledWith(404);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not silently drop older open notes or completion history after 500 captures', async () => {
    const rows = Array.from({ length: 501 }, (_, id) => ({ id: 'note-' + id, completed_at: null }));
    vi.mocked(query).mockResolvedValue({ rows } as never);
    expect((await request('get', '/')).json).toHaveBeenCalledWith(rows);
    expect(vi.mocked(query).mock.calls[0][0]).not.toMatch(/LIMIT/i);
  });

  it('sends explicit completion and optional edits through the persisted notes API', async () => {
    await setNoteCompleted('note-1', true, 'Latest draft');
    expect(apiPatch).toHaveBeenLastCalledWith('/api/notes/note-1', { completed: true, content: 'Latest draft' });
    await setNoteCompleted('note-1', false);
    expect(apiPatch).toHaveBeenLastCalledWith('/api/notes/note-1', { completed: false });
  });
});
