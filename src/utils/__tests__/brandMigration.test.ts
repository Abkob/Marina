import { afterEach, expect, it, vi } from 'vitest';
import { migrateDeviceBranding } from '../brandMigration';

const values = new Map<string, string>();
const storage: Storage = {
  get length() { return values.size; },
  key: index => [...values.keys()][index] ?? null,
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value); },
  removeItem: key => { values.delete(key); },
  clear: () => values.clear(),
};
afterEach(() => { storage.clear(); vi.restoreAllMocks(); });
it('moves preferences and drafts without overwriting an existing Marina choice', () => {
  storage.setItem('amina-draft:capture', 'Keep this thought');
  storage.setItem('amina-mobile-schedule-v1', '{"compact":true}');
  storage.setItem('marina-mobile-schedule-v1', '{"compact":false}');
  storage.setItem('unrelated-setting', 'keep');
  migrateDeviceBranding(storage);
  expect(storage.getItem('marina-draft:capture')).toBe('Keep this thought');
  expect(storage.getItem('marina-mobile-schedule-v1')).toBe('{"compact":false}');
  expect(storage.getItem('amina-draft:capture')).toBeNull();
  expect(storage.getItem('unrelated-setting')).toBe('keep');
  migrateDeviceBranding(storage);
  expect(storage.getItem('marina-draft:capture')).toBe('Keep this thought');
});
it('retains the original draft when the new storage write fails', () => {
  storage.setItem('amina-draft:capture', 'Do not lose this');
  vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
  expect(() => migrateDeviceBranding(storage)).toThrow('Storage full');
  expect(storage.getItem('amina-draft:capture')).toBe('Do not lose this');
});
