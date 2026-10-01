import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), upload: vi.fn() }));
vi.mock('../apiFetch', async () => ({ ...await vi.importActual('../apiFetch'), apiFetch: mocks.fetch }));
vi.mock('@vercel/blob/client', () => ({ upload: mocks.upload }));

const intent = { id: 'one-upload', pathname: 'marina/resource/one.txt', state: 'uploading' };
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/capabilities')) return { private_blob: true, local_uploads: false, max_bytes: 52428800 };
    if (url.endsWith('/complete')) return { id: intent.id };
    return intent;
  });
  mocks.upload.mockResolvedValue({ url: 'https://example.private.blob.vercel-storage.com/one.txt', pathname: intent.pathname });
});
const file = () => new File(['test document'], 'one.txt');

describe('persistent resource upload client', () => {
  it('binds the upload token to the persisted identity and exact path', async () => {
    const { uploadResourceDocument } = await import('../blobUpload');
    await uploadResourceDocument(file());
    expect(mocks.upload.mock.calls[0][0]).toBe(intent.pathname);
    expect(JSON.parse(mocks.upload.mock.calls[0][2].clientPayload)).toMatchObject({ uploadId: intent.id });
  });
  it('resumes completion without retransferring after a lost save response', async () => {
    const { uploadResourceDocument } = await import('../blobUpload');
    const f = file(); let failed = false;
    const base = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/complete') && !failed) { failed = true; throw new TypeError('lost response'); }
      return base(url, options);
    });
    await expect(uploadResourceDocument(f)).rejects.toThrow('lost response');
    await expect(uploadResourceDocument(f)).resolves.toBe(intent.id);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls.filter(([url]) => url === '/api/uploads/resources')).toHaveLength(1);
  });
  it('recognizes server completion after a browser network failure', async () => {
    const { uploadResourceDocument } = await import('../blobUpload');
    mocks.upload.mockRejectedValue(new TypeError('upload response lost'));
    expect(await uploadResourceDocument(file())).toBe(intent.id);
    expect(mocks.fetch.mock.calls.at(-1)![0]).toMatch(/complete$/);
  });
  it('propagates an actual incomplete transfer and lets a retry send the same path', async () => {
    const { ApiError } = await import('../apiFetch');
    const { uploadResourceDocument } = await import('../blobUpload');
    const base = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/complete')) throw new ApiError(409, 'not transferred');
      return base(url, options);
    });
    mocks.upload.mockRejectedValue(new Error('offline'));
    const f = file();
    await expect(uploadResourceDocument(f)).rejects.toThrow('offline');
    await expect(uploadResourceDocument(f)).rejects.toThrow('offline');
    expect(mocks.upload.mock.calls.map(call => call[0])).toEqual([intent.pathname, intent.pathname]);
  });
  it('does not transfer a resource already finalized by the callback', async () => {
    const { uploadResourceDocument } = await import('../blobUpload');
    mocks.fetch.mockResolvedValueOnce({ private_blob: true, max_bytes: 52428800 }).mockResolvedValueOnce({ ...intent, state: 'completed' });
    expect(await uploadResourceDocument(file())).toBe(intent.id);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('coalesces simultaneous calls for the same file and attachment', async () => {
    const { uploadResourceDocument } = await import('../blobUpload');
    const f = file();
    expect(await Promise.all([uploadResourceDocument(f), uploadResourceDocument(f)])).toEqual([intent.id, intent.id]);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
  it('keeps attachments distinct and persists the target before transferring', async () => {
    const { uploadResourceDocument } = await import('../blobUpload');
    const f = file();
    await uploadResourceDocument(f, undefined, { attach_to_id: 'task-a', attach_to_type: 'task' });
    await uploadResourceDocument(f, undefined, { attach_to_id: 'goal-b', attach_to_type: 'goal' });
    const requests = mocks.fetch.mock.calls.filter(([url]) => url === '/api/uploads/resources').map(([, opts]) => JSON.parse(opts.body));
    expect(requests[0]).toMatchObject({ attach_to_id: 'task-a', attach_to_type: 'task' });
    expect(requests[1].request_key).not.toBe(requests[0].request_key);
  });
  it('uses the same request key when creation committed but the response was lost', async () => {
    const { uploadResourceDocument } = await import('../blobUpload');
    const base = mocks.fetch.getMockImplementation()!; let failed = false;
    mocks.fetch.mockImplementation(async (url, options) => {
      if (url === '/api/uploads/resources' && !failed) { failed = true; throw new TypeError('lost intent'); }
      return base(url, options);
    });
    const f = file();
    await expect(uploadResourceDocument(f)).rejects.toThrow('lost intent');
    await uploadResourceDocument(f);
    const keys = mocks.fetch.mock.calls.filter(([url]) => url === '/api/uploads/resources').map(([, options]) => JSON.parse(options.body).request_key);
    expect(keys[0]).toBe(keys[1]);
  });
  it('reports session expiry and never falls back to a fresh upload identity', async () => {
    const { ApiError } = await import('../apiFetch');
    const { uploadResourceDocument } = await import('../blobUpload');
    const base = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/complete')) throw new ApiError(401, 'Sign in again');
      return base(url, options);
    });
    const f = file();
    await expect(uploadResourceDocument(f)).rejects.toThrow('Sign in again');
    await expect(uploadResourceDocument(f)).rejects.toThrow('Sign in again');
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
});

describe('complete resource library pagination', () => {
  it('loads more than 500 resources using a stable cursor', async () => {
    const { getAllResources } = await import('../../db/queries/resources');
    const page = Array.from({ length: 500 }, (_, i) => ({ id: String(i), created_at: '2026-10-01T00:00:00Z' }));
    mocks.fetch.mockResolvedValueOnce(page).mockResolvedValueOnce([{ id: 'last', created_at: '2026-09-01T00:00:00Z' }]);
    expect(await getAllResources()).toHaveLength(501);
    expect(mocks.fetch.mock.calls[1][0]).toContain('before=');
  });
  it('fails visibly if the server ignores pagination instead of looping forever', async () => {
    const { getAllResources } = await import('../../db/queries/resources');
    mocks.fetch.mockResolvedValue(Array.from({ length: 500 }, (_, i) => ({ id: String(i), created_at: '2026-10-01T00:00:00Z' })));
    await expect(getAllResources()).rejects.toThrow('did not advance');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});
