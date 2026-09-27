import { describe, expect, it } from 'vitest';
import { safeBackupFilename } from '../../../server/services/portableBackup.js';

describe('portable backup path safety', () => {
  it('removes traversal, separators, control characters, and Windows-reserved filename characters', () => {
    expect(safeBackupFilename('../../bad\\name:<x>?*.pdf\u0000')).toBe('name__x___.pdf_');
  });

  it('uses a fallback for an empty or dot-only name', () => {
    expect(safeBackupFilename('...', 'attachment.bin')).toBe('attachment.bin');
  });

  it('limits names so archive paths remain portable', () => {
    expect(safeBackupFilename('a'.repeat(300))).toHaveLength(160);
  });
});
