import { beforeEach, expect, it, vi } from 'vitest';
import { BlobNotFoundError, head } from '@vercel/blob';
import { existingCloudPortablePath } from '../../../server/routes/backups';

vi.mock('@vercel/blob', async importOriginal => ({ ...await importOriginal<typeof import('@vercel/blob')>(), head: vi.fn() }));
beforeEach(() => vi.mocked(head).mockReset());
const name = 'marina-complete-2026-09-24-proof.marina-backup.zip';
it('resolves a renamed old backup to its existing stored object', async () => {
  vi.mocked(head).mockRejectedValueOnce(new BlobNotFoundError()).mockResolvedValueOnce({} as Awaited<ReturnType<typeof head>>);
  const result = await existingCloudPortablePath(name);
  expect(result).toBe('amina/backups/portable/amina-complete-2026-09-24-proof.amina-backup.zip');
  expect(head).toHaveBeenNthCalledWith(1, `marina/backups/portable/${name}`);
  expect(head).toHaveBeenNthCalledWith(2, result);
});
it('does not mask storage authentication failures as missing backups', async () => {
  vi.mocked(head).mockRejectedValueOnce(new Error('Authentication failed'));
  await expect(existingCloudPortablePath(name)).rejects.toThrow('Authentication failed');
  expect(head).toHaveBeenCalledTimes(1);
});
it('rejects invalid backup names before accessing storage', async () => {
  await expect(existingCloudPortablePath('../../private-file')).rejects.toThrow('invalid portable backup name');
  expect(head).not.toHaveBeenCalled();
});
