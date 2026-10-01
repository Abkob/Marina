import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../apiFetch', async () => ({ ...await vi.importActual('../apiFetch'), apiFetch: mocks.fetch }));
import { uploadDriveChunks } from '../driveUpload';
import { ApiError } from '../apiFetch';
const file = () => new File([new Uint8Array(2*1024*1024+20)], 'notes.txt');
beforeEach(() => vi.resetAllMocks());
describe('Drive resumable upload client', () => {
  it('sends bounded chunks below Vercel limits and reports progress', async () => {
    mocks.fetch.mockResolvedValueOnce({ offset: 0 }).mockResolvedValueOnce({ offset: 2*1024*1024 }).mockResolvedValueOnce({ offset: 2*1024*1024+20, complete: true });
    const progress = vi.fn(); await uploadDriveChunks(file(), 'resource1', progress);
    expect(mocks.fetch.mock.calls[1][1].body.size).toBe(2*1024*1024); expect(mocks.fetch.mock.calls[2][1].body.size).toBe(20);
    expect(progress.mock.calls.at(-1)?.[0]).toEqual({ phase: 'uploading', percentage: 100 });
  });
  it('resumes from bytes already stored by Drive', async () => {
    mocks.fetch.mockResolvedValueOnce({ offset: 2*1024*1024 }).mockResolvedValueOnce({ offset: 2*1024*1024+20, complete: true });
    await uploadDriveChunks(file(), 'resource1'); expect(mocks.fetch.mock.calls[1][0]).toContain('offset=2097152');
  });
  it('does not resend a previously completed file', async () => {
    mocks.fetch.mockResolvedValueOnce({ offset: 2*1024*1024+20, complete: true });
    await uploadDriveChunks(file(), 'resource1'); expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('recovers a lost final response by checking the saved position', async () => {
    mocks.fetch.mockResolvedValueOnce({ offset: 2*1024*1024 }).mockRejectedValueOnce(new TypeError('network lost')).mockResolvedValueOnce({ offset: 2*1024*1024+20, complete: true });
    await uploadDriveChunks(file(), 'resource1'); expect(mocks.fetch.mock.calls.filter(([url]) => url.includes('drive-chunk'))).toHaveLength(1);
  });
  it.each([401,403,413,507])('stops visibly on permanent error %s', async status => {
    mocks.fetch.mockResolvedValueOnce({ offset: 0 }).mockRejectedValueOnce(new ApiError(status, 'stop'));
    await expect(uploadDriveChunks(file(), 'resource1')).rejects.toThrow('stop'); expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([-1, NaN, 999999999, 1.5])('rejects invalid acknowledged offset %s', async offset => {
    mocks.fetch.mockResolvedValueOnce({ offset }); await expect(uploadDriveChunks(file(), 'resource1')).rejects.toThrow('invalid upload position');
  });
  it('bounds retries when Drive repeatedly makes no progress', async () => {
    mocks.fetch.mockResolvedValue({ offset: 0 }); await expect(uploadDriveChunks(file(), 'resource1')).rejects.toThrow('not progressing');
    expect(mocks.fetch).toHaveBeenCalledTimes(5);
  });
});
