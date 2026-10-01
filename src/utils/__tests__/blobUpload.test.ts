import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), upload: vi.fn() }));
vi.mock('../apiFetch', async () => ({ ...await vi.importActual('../apiFetch'), apiFetch: mocks.fetch }));
vi.mock('@vercel/blob/client', () => ({ upload: mocks.upload }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.fetch.mockResolvedValue({ private_blob: true, max_bytes: 50 * 1024 * 1024, local_uploads: false });
  mocks.upload.mockResolvedValue({ url: 'https://example.private.blob.vercel-storage.com/file.csv' });
});

describe('resource file uploads', () => {
  it('rejects invalid files before sending bytes or requesting authorization', async () => {
    const { uploadToPrivateBlob, MAX_UPLOAD_BYTES, validateUploadFile } = await import('../blobUpload');
    const large = new File(['data'], 'large.pdf', { type: 'application/pdf' });
    Object.defineProperty(large, 'size', { value: MAX_UPLOAD_BYTES + 1 });
    await expect(uploadToPrivateBlob(large, 'resource')).rejects.toThrow('50 MB');
    await expect(uploadToPrivateBlob(new File(['data'], 'report.docx'), 'resource')).rejects.toThrow('Export Word documents as PDF');
    await expect(uploadToPrivateBlob(new File([], 'empty.txt'), 'resource')).rejects.toThrow('empty');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    const exact = new File(['data'], 'exact.pdf');
    Object.defineProperty(exact, 'size', { value: MAX_UPLOAD_BYTES });
    expect(() => validateUploadFile(exact)).not.toThrow();
  });

  it('normalizes platform MIME differences and uses the same type for authorization and storage', async () => {
    const { uploadToPrivateBlob } = await import('../blobUpload');
    const file = new File(['a,b\n1,2'], 'data.CSV', { type: 'application/vnd.ms-excel' });
    const progress = vi.fn();
    await uploadToPrivateBlob(file, 'resource', progress);
    const options = mocks.upload.mock.calls[0][2];
    expect(options.contentType).toBe('text/csv');
    expect(JSON.parse(options.clientPayload)).toMatchObject({ contentType: 'text/csv', kind: 'resource', size: file.size });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    options.onUploadProgress({ percentage: 42 });
    expect(progress).toHaveBeenLastCalledWith({ phase: 'uploading', percentage: 42 });
  });

  it('recovers from a failed capability request without reloading the page', async () => {
    const { uploadToPrivateBlob } = await import('../blobUpload');
    mocks.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const file = new File(['hello'], 'notes.txt');
    await expect(uploadToPrivateBlob(file, 'resource')).rejects.toThrow('Failed to fetch');
    await uploadToPrivateBlob(file, 'resource');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it('does not send a file through a serverless request when cloud storage is unavailable', async () => {
    const { uploadToPrivateBlob } = await import('../blobUpload');
    mocks.fetch.mockResolvedValue({ private_blob: false, local_uploads: false, max_bytes: 50 * 1024 * 1024 });
    await expect(uploadToPrivateBlob(new File(['hello'], 'notes.txt'), 'resource')).rejects.toThrow('Cloud file storage is unavailable');
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('rechecks capabilities when storage comes back online', async () => {
    const { uploadToPrivateBlob } = await import('../blobUpload');
    mocks.fetch.mockResolvedValueOnce({ private_blob: false, local_uploads: false, max_bytes: 52428800 })
      .mockResolvedValueOnce({ private_blob: true, local_uploads: false, max_bytes: 52428800 });
    const file = new File(['notes'], 'notes.txt');
    await expect(uploadToPrivateBlob(file, 'resource')).rejects.toThrow('unavailable');
    await uploadToPrivateBlob(file, 'resource');
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves the local uploader and enforces the server-provided size limit', async () => {
    const { uploadToPrivateBlob } = await import('../blobUpload');
    mocks.fetch.mockResolvedValue({ private_blob: false, local_uploads: true, max_bytes: 10 });
    await expect(uploadToPrivateBlob(new File(['hello'], 'notes.txt'), 'resource')).resolves.toBeNull();
    await expect(uploadToPrivateBlob(new File(['longer than ten bytes'], 'notes.txt'), 'resource')).rejects.toThrow('limit');
  });

  it('normalizes CSV types on the local multipart path too', async () => {
    const { uploadResourceFile } = await import('../../db/queries/resources');
    mocks.fetch.mockResolvedValueOnce({ private_blob: false, local_uploads: true, max_bytes: 50 * 1024 * 1024 })
      .mockResolvedValueOnce({ id: 'intent-local', pathname: 'test.csv', state: 'uploading' })
      .mockResolvedValueOnce({ id: 'saved-local' });
    const id = await uploadResourceFile(new File(['a,b'], 'data.csv', { type: 'application/vnd.ms-excel' }));
    expect(id).toBe('saved-local');
    const [url, options] = mocks.fetch.mock.calls[2];
    expect(url).toBe('/api/resources/upload');
    const uploaded = options.body.get('file') as File;
    expect(uploaded.name).toBe('data.csv');
    expect(uploaded.type).toBe('text/csv');
    expect(await uploaded.text()).toBe('a,b');
  });

  it('reports saving separately and returns success only after cloud registration', async () => {
    const { uploadResourceFile } = await import('../../db/queries/resources');
    const progress = vi.fn();
    mocks.fetch.mockResolvedValueOnce({ private_blob: true, max_bytes: 50 * 1024 * 1024 })
      .mockImplementationOnce(async (url, options) => {
        expect(url).toBe('/api/uploads/resources');
        expect(JSON.parse(options.body)).toMatchObject({ original_name: 'data.csv', mime_type: 'text/csv', size: 3 });
        return { id: 'upload-id', pathname: 'data.csv', state: 'uploading' };
      })
      .mockImplementationOnce(async (url, options) => {
        expect(url).toBe('/api/uploads/resources/upload-id/complete');
        expect(progress).toHaveBeenLastCalledWith({ phase: 'saving' });
        return { id: 'saved-cloud' };
      });
    expect(await uploadResourceFile(new File(['a,b'], 'data.csv'), progress)).toBe('saved-cloud');
  });
});
