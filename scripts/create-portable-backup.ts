import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { createPortableBackupArchive } from '../server/services/portableBackup.js';
import { verifyPortableBackup } from './lib/portableBackup.js';

const stamp = new Date().toISOString().replace(/[:]/g, '-');
const requested = process.argv[2];
const destination = path.resolve(
  requested ?? path.join('backups', `marina-complete-${stamp}-${crypto.randomBytes(4).toString('hex')}.marina-backup.zip`),
);
const partial = `${destination}.partial`;

await fsp.mkdir(path.dirname(destination), { recursive: true });
if (fs.existsSync(destination) || fs.existsSync(partial)) {
  console.error(`[backup:create] Refusing to overwrite: ${destination}`);
  process.exit(1);
}

try {
  const output = fs.createWriteStream(partial, { flags: 'wx' });
  const created = await createPortableBackupArchive(output);
  await fsp.rename(partial, destination);
  const verified = await verifyPortableBackup(destination);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(destination)) hash.update(chunk as Buffer);
  console.log(JSON.stringify({
    ok: true,
    archive: destination,
    archive_bytes: verified.archive_bytes,
    archive_sha256: hash.digest('hex'),
    tables: created.manifest.database.tables.length,
    rows: created.manifest.database.total_rows,
    files: created.manifest.total_files,
    file_bytes: created.manifest.total_file_bytes,
    entry_checksums: 'verified',
  }, null, 2));
} catch (error) {
  await fsp.unlink(partial).catch(() => undefined);
  console.error(`[backup:create] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
