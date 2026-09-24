/** Read the previous release's device preferences once, without losing drafts. */
export function migrateDeviceBranding(storage: Storage) {
  const oldPrefix = 'amina';
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key));
  for (const key of keys) {
    if (!key.startsWith(`${oldPrefix}-`)) continue;
    const next = `marina${key.slice(oldPrefix.length)}`;
    const value = storage.getItem(key);
    if (value === null) continue;
    if (storage.getItem(next) === null) storage.setItem(next, value);
    // Remove only after the new copy is safely present.
    storage.removeItem(key);
  }
}
