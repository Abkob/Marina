import { describe, expect, it, vi } from 'vitest';
import { createDriveAncestryGuard } from '../../../server/services/driveAncestry';
import { DRIVE_FOLDER_MIME, type DriveFile } from '../../../server/services/googleDriveClient';
const folder = (id: string, parents?: string[]): DriveFile => ({ id, parents, name: id, mimeType: DRIVE_FOLDER_MIME, version: '1' });
const root = folder('root');
const child = folder('goal', ['root']);
const file: DriveFile = { ...folder('pdf', ['goal']), mimeType: 'application/pdf' };
const reader = (rows: DriveFile[]) => vi.fn(async (id: string) => {
  const row = rows.find(r => r.id === id);
  if (!row) throw Object.assign(new Error('Unavailable'), { status: 404 });
  return row;
});
describe('Marina Drive ancestry boundary', () => {
  it('resolves nested ancestry and shares reads only within the operation', async () => {
    const get = reader([root, child, file]);
    const guard = createDriveAncestryGuard('root', get);
    expect((await guard('pdf')).map(f => f.id)).toEqual(['root', 'goal', 'pdf']);
    await guard('pdf');
    expect(get).toHaveBeenCalledTimes(3);
    await createDriveAncestryGuard('root', get)('pdf');
    expect(get).toHaveBeenCalledTimes(6);
  });
  it.each([
    { ...file, parents: [] },
    { ...file, parents: ['outside'] },
    { ...file, parents: ['goal', 'outside'] },
    { ...file, trashed: true },
    { ...file, mimeType: 'application/vnd.google-apps.shortcut' },
  ])('rejects unproven, moved, trashed or shortcut sources: %j', async invalid => {
    await expect(createDriveAncestryGuard('root', reader([root, child, folder('outside')]))(invalid)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects a missing or trashed ancestor and malformed cycles', async () => {
    for (const parent of [{ ...child, trashed: true }, folder('goal', ['goal'])]) {
      await expect(createDriveAncestryGuard('root', reader([root, parent]))(file)).rejects.toMatchObject({ status: 403 });
    }
    await expect(createDriveAncestryGuard('root', reader([root]))(file)).rejects.toMatchObject({ status: 404 });
  });
  it('refuses an invalid root even when the file claims it as a parent', async () => {
    await expect(createDriveAncestryGuard('root', reader([{ ...root, trashed: true }]))(file)).rejects.toMatchObject({ status: 403 });
  });
});
