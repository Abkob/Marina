import { z } from 'zod';
import { driveDocument, driveError, getDriveFile, listDriveFiles } from './googleDriveClient.js';
import { driveToken, resourceDriveFolder, driveRootGuard, importDriveFile, syncDriveResource } from './googleDrive.js';
import { createDriveAncestryGuard } from './driveAncestry.js';
import type { ResourceTarget } from './driveFolders.js';

const cursorSchema = z.array(z.object({ folder: z.string().regex(/^[\w-]{1,200}$/), page: z.string().max(2000).optional() }).strict()).max(200);
/** One small Drive page per request; the client resumes, originals are processed by durable jobs. */
export async function scanResourceDirectory(target: ResourceTarget, includeSubtasks: boolean, cursor?: string) {
  const destination = await resourceDriveFolder(target);
  const token = await driveToken();
  await (await driveRootGuard(token))(destination.folder_id);
  let pending = [{ folder: destination.folder_id, page: undefined as string | undefined }];
  if (cursor) {
    try { pending = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString())).map(row => ({ folder: row.folder, page: row.page })); }
    catch { throw driveError('Directory refresh expired. Start it again.'); }
  }
  const head = pending.shift();
  if (!head) return { ...destination, checked: 0, skipped: 0, errors: [], next_cursor: null };
  const path = await createDriveAncestryGuard(destination.folder_id, id => getDriveFile(token, id))(head.folder);
  if (!includeSubtasks && target.attach_to_type === 'task' && path.some(f => f.id !== destination.folder_id && f.appProperties?.marinaEntityType === 'task')) throw driveError('This subtask is outside the selected context.', 403);
  const listing = await listDriveFiles(token, '', head.folder, head.page, 10);
  let checked = 0; let skipped = 0; const errors: string[] = [];
  for (const file of listing.files) {
    if (file.mimeType === 'application/vnd.google-apps.folder') {
      if (includeSubtasks || target.attach_to_type !== 'task' || file.appProperties?.marinaEntityType !== 'task') pending.push({ folder: file.id, page: undefined });
      continue;
    }
    try { driveDocument(file); } catch { skipped++; continue; }
    try {
      const imported = await importDriveFile(file.id, target);
      await syncDriveResource(imported.id);
      checked++;
    } catch { errors.push(file.name); }
  }
  if (listing.nextPageToken) pending.unshift({ folder: head.folder, page: listing.nextPageToken });
  if (pending.length > 200) throw driveError('This directory has too many subfolders for one refresh. Select a smaller goal or task folder.', 409);
  return { ...destination, checked, skipped, errors, next_cursor: pending.length ? Buffer.from(JSON.stringify(pending)).toString('base64url') : null };
}
