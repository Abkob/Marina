/** Compatibility for previously exported backups and linked Google records.
 * New records and all displayed labels use Marina. Never discard old data for a rename.
 */
export const LEGACY_BRAND = 'amina';
export const LEGACY_LABEL = 'Amina';
export const LEGACY_BACKUP_FORMAT = `${LEGACY_BRAND}-portable-backup`;
export const LEGACY_BACKUP_PREFIX = `${LEGACY_BRAND}/backups/portable/`;
export function legacyAuthenticationSecret(suffix: 'ACCESS_PASSWORD' | 'SESSION_SECRET') {
  return process.env[`${LEGACY_BRAND.toUpperCase()}_${suffix}`];
}
export function marinaBackupName(name: string) {
  return name.replace(new RegExp(`^${LEGACY_BRAND}-complete-`), 'marina-complete-')
    .replace(new RegExp(`\\.${LEGACY_BRAND}-backup\\.zip$`), '.marina-backup.zip');
}
export function legacyBackupName(name: string) {
  return name.replace(/^marina-complete-/, `${LEGACY_BRAND}-complete-`)
    .replace(/\.marina-backup\.zip$/, `.${LEGACY_BRAND}-backup.zip`);
}
