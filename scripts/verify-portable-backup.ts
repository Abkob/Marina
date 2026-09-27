import 'dotenv/config';
import { verifyPortableBackup } from './lib/portableBackup.js';

const archivePath = process.argv[2];
if (!archivePath) {
  console.error('Usage: npm run backup:verify -- <marina-complete-....marina-backup.zip>');
  process.exit(1);
}

try {
  const verified = await verifyPortableBackup(archivePath);
  const manifest = verified.manifest;
  console.log(JSON.stringify({
    ok: true,
    archive: verified.archive_path,
    archive_bytes: verified.archive_bytes,
    created_at: manifest.created_at,
    database: manifest.database.name,
    tables: manifest.database.tables.length,
    rows: manifest.database.total_rows,
    files: manifest.total_files,
    file_bytes: manifest.total_file_bytes,
    checksums: 'verified',
  }, null, 2));
} catch (error) {
  console.error(`[backup:verify] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
