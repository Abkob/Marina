import { describe, expect, it } from 'vitest';
import {
  makeVaultAttachmentName,
  makeVaultSafeName,
  minutesLabel,
  replaceStaleWorkspaceFiles,
  shouldSyncObsidianVaultForRequest,
  taskVaultPath,
  yamlFrontmatter,
} from '../services/obsidianVaultSync.js';

describe('obsidianVaultSync helpers', () => {
  it('creates Windows-safe stable names with an id suffix', () => {
    expect(makeVaultSafeName('Fix: bad/path * now?', 'Task', 'abcdef123456')).toBe('Fix bad path now__abcdef12');
    expect(makeVaultSafeName('CON', 'Goal', '1234567890')).toBe('CON-item__12345678');
  });

  it('formats minutes for human reading', () => {
    expect(minutesLabel(20)).toBe('20m');
    expect(minutesLabel(120)).toBe('2h');
    expect(minutesLabel(135)).toBe('2h 15m');
    expect(minutesLabel(null)).toBe('?');
  });

  it('renders compact yaml frontmatter', () => {
    expect(yamlFrontmatter({
      id: 'task-1',
      type: 'task',
      completed: false,
      empty: '',
      tags: ['marina/task', 'school'],
    })).toContain('tags:\n  - "marina/task"\n  - "school"');
  });

  it('keeps attachment extensions while producing portable unique names', () => {
    expect(makeVaultAttachmentName('Draft: final/report.PDF', 'abcdef123456')).toBe('report__abcdef12.pdf');
    expect(makeVaultAttachmentName('sensor notes?.md', '1234567890')).toBe('sensor notes__12345678.md');
  });

  it('queues vault sync after task-note attachment mutations', () => {
    const previous = process.env.OBSIDIAN_VAULT_SYNC;
    process.env.OBSIDIAN_VAULT_SYNC = 'true';
    try {
      expect(shouldSyncObsidianVaultForRequest('POST', '/api/task-note-files/note-1')).toBe(true);
      expect(shouldSyncObsidianVaultForRequest('DELETE', '/api/task-note-files/file/file-1')).toBe(true);
      expect(shouldSyncObsidianVaultForRequest('GET', '/api/task-note-files/note-1')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OBSIDIAN_VAULT_SYNC;
      else process.env.OBSIDIAN_VAULT_SYNC = previous;
    }
  });

  it('uses one flat task note per goal and a separate standalone area', () => {
    expect(taskVaultPath('Draft report', 'abcdef123456', '01 Goals/Research__12345678'))
      .toBe('01 Goals/Research__12345678/Tasks/Draft report__abcdef12.md');
    expect(taskVaultPath('Buy printer paper', '1234567890', null))
      .toBe('02 Standalone Tasks/Buy printer paper__12345678.md');
  });

  it('repairs only workspace tabs that point to stale generated files', () => {
    const workspace = {
      main: { children: [{ state: { state: { file: 'Goals/Old/Task/Files/Index.md' } } }] },
      userTab: { file: 'Personal Notes/Keep Me.md' },
      lastOpenFiles: ['Goals/Old/Task/Files/Index.md', 'Goals/Old/Task/Files/Index.md', 'Personal Notes/Keep Me.md'],
    };
    expect(replaceStaleWorkspaceFiles(workspace, new Set(['Goals/Old/Task/Files/Index.md']), '00 Home.md')).toBe(true);
    expect(workspace.main.children[0].state.state.file).toBe('00 Home.md');
    expect(workspace.userTab.file).toBe('Personal Notes/Keep Me.md');
    expect(workspace.lastOpenFiles).toEqual(['00 Home.md', 'Personal Notes/Keep Me.md']);
  });
});
