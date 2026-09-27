import { transaction } from '../db.js';
import { isVercelRuntime } from '../runtime.js';
import { cloudBackupStatus, createCloudPortableBackup } from '../routes/backups.js';

/** A separate daily job keeps backups independent of AI maintenance failures. */
export async function runScheduledCloudBackup() {
  if (!isVercelRuntime) return { skipped: 'local_runtime' };
  return transaction(async client => {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('marina-cloud-backup')) AS locked",
    );
    if (!rows[0]?.locked) return { skipped: 'already_running' };
    const status = await cloudBackupStatus();
    // A delayed run still leaves room for tomorrow's scheduled backup.
    if (status.last_verified_at && Date.now() - Date.parse(status.last_verified_at) < 20 * 60 * 60_000) {
      return { skipped: 'recent_verified_backup', last_verified_at: status.last_verified_at };
    }
    const result = await createCloudPortableBackup(undefined, false);
    return {
      filename: result.filename, bytes: result.bytes, sha256: result.sha256,
      verified_at: result.verified_at, rows: result.row_count, files: result.file_count,
    };
  });
}
