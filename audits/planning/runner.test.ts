import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { knownPlanningBaselineFailures, summarizeVitest } from './knownFailures.js';

describe('P00.2 truthful baseline accounting', () => {
  it('P00.2-U01 inventories all expected-failure assertions without hiding new defects', () => {
    const source = [...new Set(knownPlanningBaselineFailures.map(row => row.file))].map(file => readFileSync(file, 'utf8')).join('\n');
    const ids = [...source.matchAll(/it\.fails\(['"]([A-Z]+-\d+)/g)].map(match => match[1]).sort();
    expect(ids).toEqual(knownPlanningBaselineFailures.map(row => row.id).sort());
  });
  it('P00.2-U02 reports ordinary passes, expected failures and skips separately', () => {
    const result = summarizeVitest({ success: true, testResults: [{ name: 'test.ts', assertionResults: [
      { fullName: 'CHAT-01 known defect', status: 'passed' }, { fullName: 'ordinary', status: 'passed' }, { fullName: 'missing database', status: 'pending' },
    ] }] }, 0, [{ id: 'CHAT-01' }]);
    expect(result.ordinary_passes).toBe(1); expect(result.expected_failures).toHaveLength(1); expect(result.skipped).toHaveLength(1);
  });
  it('P00.2-U03 runner failure or a missing expected assertion cannot produce a green receipt', () => {
    expect(summarizeVitest({ success: true }, 1).success).toBe(false);
    expect(summarizeVitest({ success: true }, 0, [{ id: 'CHAT-01' }]).success).toBe(false);
    expect(summarizeVitest({ success: false }, 0).success).toBe(false);
  });
});
