import { DRIVE_FOLDER_MIME, driveError, type DriveFile } from './googleDriveClient.js';

/** One-operation cache: moves/revoked access must be checked again on the next operation. */
export function createDriveAncestryGuard(rootId: string, fetchFile: (id: string) => Promise<DriveFile>) {
  const files = new Map<string, Promise<DriveFile>>();
  const get = (id: string) => {
    if (!files.has(id)) files.set(id, fetchFile(id));
    return files.get(id)!;
  };
  return async (fileOrId: DriveFile | string): Promise<DriveFile[]> => {
    const root = await get(rootId);
    if (root.trashed || root.mimeType !== DRIVE_FOLDER_MIME) throw driveError('The Marina Drive root is unavailable. Restore it before continuing.', 403);
    const file = typeof fileOrId === 'string' ? await get(fileOrId) : fileOrId;
    const path: DriveFile[] = [];
    const visited = new Set<string>();
    let current = file;
    for (let depth = 0; depth < 64; depth++) {
      if (current.trashed || visited.has(current.id)) break;
      if (current.mimeType === 'application/vnd.google-apps.shortcut') break;
      visited.add(current.id); path.push(current);
      if (current.id === rootId) return path.reverse();
      // Drive v3 has a single parent. Missing/ambiguous ancestry fails closed.
      if (current.parents?.length !== 1) break;
      current = await get(current.parents[0]);
      if (current.mimeType !== DRIVE_FOLDER_MIME) break;
    }
    throw driveError('This file is outside the Marina Drive folder. Move it into the appropriate Marina goal or task folder first.', 403);
  };
}
