import { describe, expect, it } from 'vitest';
import { groupFeatureUsage, type TableUsage } from '../../server/services/usageMetrics.js';

const table = (name: string, bytes: number, rows = 1): TableUsage => ({
  table: name, totalBytes: bytes, dataBytes: bytes, indexBytes: 0, estimatedRows: rows, deadRows: 0,
});

describe('groupFeatureUsage', () => {
  it('groups known tables and retains uncategorized storage', () => {
    const result = groupFeatureUsage([
      table('tasks', 300, 7),
      table('goals', 100, 2),
      table('embeddings', 900, 12),
      table('future_table', 50, 1),
    ]);

    expect(result.find(group => group.key === 'tasks')).toMatchObject({ bytes: 400, estimatedRows: 9 });
    expect(result.find(group => group.key === 'ai')).toMatchObject({ bytes: 900, estimatedRows: 12 });
    expect(result.find(group => group.key === 'system')).toMatchObject({ bytes: 50, tables: ['future_table'] });
    expect(result[0].key).toBe('ai');
  });
});
