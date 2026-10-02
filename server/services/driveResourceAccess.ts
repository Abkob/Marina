// The stored original is authoritative even if its synchronization metadata is missing.
export const DRIVE_FILE_ID_SQL = "CASE WHEN r.file_path LIKE 'gdrive://%' THEN substring(r.file_path from 10) ELSE NULL END";
/** Check candidate originals before their text is sent to a reranker or chat model. */
export async function filterRootedDriveRows<T extends { file_id?: string | null }>(rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.flatMap(row => row.file_id ? [row.file_id] : []))];
  if (!ids.length) return rows;
  const { driveToken, driveRootGuard } = await import('./googleDrive.js');
  const guard = await driveRootGuard(await driveToken());
  const allowed = new Set<string>();
  // Bound provider concurrency; the guard shares parent reads for the batch.
  for (let offset = 0; offset < ids.length; offset += 4) {
    await Promise.all(ids.slice(offset, offset + 4).map(async id => {
      try { await guard(id); allowed.add(id); }
      catch (error) { if (![400,403,404].includes(Number((error as { status?: number }).status))) throw error; }
    }));
  }
  return rows.filter(row => !row.file_id || allowed.has(row.file_id));
}
