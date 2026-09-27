import { beforeEach, expect, it, vi } from 'vitest';
import { transaction } from '../../../server/db';
import { cloudBackupStatus, createCloudPortableBackup } from '../../../server/routes/backups';
import { runScheduledCloudBackup } from '../../../server/services/scheduledBackup';

vi.mock('../../../server/db', () => ({ transaction: vi.fn() }));
vi.mock('../../../server/runtime', () => ({ isVercelRuntime: true }));
vi.mock('../../../server/routes/backups', () => ({ cloudBackupStatus: vi.fn(), createCloudPortableBackup: vi.fn() }));
const lockQuery = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  lockQuery.mockResolvedValue({ rows: [{ locked: true }] });
  vi.mocked(transaction).mockImplementation(async fn => fn({ query: lockQuery } as never));
  vi.mocked(cloudBackupStatus).mockResolvedValue({ enabled: true, last_verified_at: null, overdue: true });
  vi.mocked(createCloudPortableBackup).mockResolvedValue({ filename: 'backup.zip', bytes: 200, sha256: 'verified', verified_at: new Date().toISOString(), row_count: 8, file_count: 0 } as never);
});

it('creates a verified backup when none exists', async () => {
  expect(await runScheduledCloudBackup()).toMatchObject({ filename: 'backup.zip', rows: 8 });
  expect(createCloudPortableBackup).toHaveBeenCalledWith(undefined, false);
});

it('does not create another backup during an overlapping run', async () => {
  lockQuery.mockResolvedValue({ rows: [{ locked: false }] });
  expect(await runScheduledCloudBackup()).toEqual({ skipped: 'already_running' });
  expect(createCloudPortableBackup).not.toHaveBeenCalled();
});

it('skips duplicate runs only when a recent verified backup exists', async () => {
  const last = new Date(Date.now() - 60 * 60_000).toISOString();
  vi.mocked(cloudBackupStatus).mockResolvedValue({ enabled: true, last_verified_at: last, overdue: false });
  expect(await runScheduledCloudBackup()).toEqual({ skipped: 'recent_verified_backup', last_verified_at: last });
  expect(createCloudPortableBackup).not.toHaveBeenCalled();
});

it('creates the next daily backup before the previous one becomes overdue', async () => {
  vi.mocked(cloudBackupStatus).mockResolvedValue({ enabled: true, last_verified_at: new Date(Date.now() - 24 * 60 * 60_000).toISOString(), overdue: false });
  await runScheduledCloudBackup();
  expect(createCloudPortableBackup).toHaveBeenCalledOnce();
});

it('fails the scheduled run when verification fails', async () => {
  vi.mocked(createCloudPortableBackup).mockRejectedValueOnce(new Error('Verification failed'));
  await expect(runScheduledCloudBackup()).rejects.toThrow('Verification failed');
});
