import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Writable } from 'node:stream';
import crypto from 'node:crypto';
import { get, list, put } from '@vercel/blob';
import { createPortableBackupArchive } from '../../../server/services/portableBackup';
import { cloudBackupStatus, createCloudPortableBackup } from '../../../server/routes/backups';

vi.mock('@vercel/blob', async original => ({
  ...await original<typeof import('@vercel/blob')>(), get: vi.fn(), list: vi.fn(), put: vi.fn(),
}));
vi.mock('../../../server/runtime', () => ({
  isVercelRuntime: true, isBlobStorageConfigured: () => true, canUseLocalPersistence: () => false,
}));
vi.mock('../../../server/services/portableBackup', () => ({ createPortableBackupArchive: vi.fn() }));

const bytes = Buffer.from('complete archive bytes');
const name = 'marina-complete-2026-09-27-proof.marina-backup.zip';
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createPortableBackupArchive).mockImplementation(async (output: Writable) => {
    output.end(bytes);
    return { bytes: bytes.length, manifest: { database: { tables: [{}], total_rows: 8 }, total_files: 0, total_file_bytes: 0 } } as never;
  });
  vi.mocked(put).mockImplementation(async (_path, body) => {
    if (typeof body !== 'string') for await (const _chunk of body as AsyncIterable<Buffer>) { /* consume upload */ }
    return { etag: 'archive-etag' } as never;
  });
  vi.mocked(get).mockResolvedValue({ statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } as never);
  vi.mocked(list).mockResolvedValue({ blobs: [], hasMore: false } as never);
});

describe('verified cloud backups', () => {
  it('records success only after reading back the identical private archive', async () => {
    const result = await createCloudPortableBackup(name, false);
    expect(result).toMatchObject({ sha256, bytes: bytes.length, row_count: 8, download_url: null });
    expect(get).toHaveBeenCalledWith(`marina/backups/portable/${name}`, { access: 'private', useCache: false });
    expect(put).toHaveBeenCalledTimes(2);
    const [receiptPath, receipt, options] = vi.mocked(put).mock.calls[1];
    expect(receiptPath).toBe(`marina/backups/verified/${name}.json`);
    expect(JSON.parse(String(receipt))).toMatchObject({ filename: name, sha256, row_count: 8 });
    expect(options).toMatchObject({ access: 'private', addRandomSuffix: false });
  });

  it('does not mark a corrupted cloud copy as verified', async () => {
    vi.mocked(get).mockResolvedValue({ statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('corrupt')); controller.close(); } }) } as never);
    await expect(createCloudPortableBackup(name, false)).rejects.toThrow('verification failed');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('does not report success when the uploaded archive cannot be read back', async () => {
    vi.mocked(get).mockResolvedValue(null);
    await expect(createCloudPortableBackup(name, false)).rejects.toThrow('read back');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('propagates storage failures instead of reporting a successful backup', async () => {
    vi.mocked(put).mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(createCloudPortableBackup(name, false)).rejects.toThrow('Storage unavailable');
    expect(get).not.toHaveBeenCalled();
  });

  it('marks missing and old verified backups overdue', async () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    expect(await cloudBackupStatus(now)).toMatchObject({ overdue: true, last_verified_at: null });
    vi.mocked(list).mockResolvedValueOnce({ blobs: [{ uploadedAt: new Date(now - 37 * 60 * 60_000) }], hasMore: false } as never);
    expect(await cloudBackupStatus(now)).toMatchObject({ overdue: true });
  });

  it('finds the newest verified backup across pages and ignores future dates', async () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    const latest = new Date(now - 60 * 60_000);
    vi.mocked(list)
      .mockResolvedValueOnce({ blobs: [{ uploadedAt: new Date(now - 48 * 60 * 60_000) }], hasMore: true, cursor: 'page2' } as never)
      .mockResolvedValueOnce({ blobs: [{ uploadedAt: latest }, { uploadedAt: new Date(now + 24 * 60 * 60_000) }], hasMore: false } as never);
    expect(await cloudBackupStatus(now)).toEqual({ enabled: true, last_verified_at: latest.toISOString(), overdue: false });
    expect(list).toHaveBeenLastCalledWith({ prefix: 'marina/backups/verified/', cursor: 'page2', limit: 1000 });
  });

  it('accepts small storage clock differences so immediate retries see the backup', async () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    const timestamp = new Date(now + 1_000);
    vi.mocked(list).mockResolvedValueOnce({ blobs: [{ uploadedAt: timestamp }], hasMore: false } as never);
    expect(await cloudBackupStatus(now)).toEqual({ enabled: true, last_verified_at: timestamp.toISOString(), overdue: false });
  });
});
