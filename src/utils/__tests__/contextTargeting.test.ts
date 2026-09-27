import { describe, expect, it } from 'vitest';
import { findExplicitTaskMatches } from '../../../server/services/contextTargeting.js';

const tasks = [
  { id: 'paper', title: 'Paper drafting' },
  { id: 'schedule', title: 'Fix Incomplete Schedule' },
  { id: 'fyp', title: 'FYP' },
  { id: 'email', title: 'Send Costantine an email' },
];

describe('findExplicitTaskMatches', () => {
  it('matches an explicitly named task', () => {
    expect(findExplicitTaskMatches('Help me break down paper drafting', tasks)).toEqual(['paper']);
    expect(findExplicitTaskMatches('What is going on with FYP?', tasks)).toEqual(['fyp']);
  });

  it('tolerates small spelling mistakes', () => {
    expect(findExplicitTaskMatches('help with papaer draftng', tasks)).toEqual(['paper']);
    expect(findExplicitTaskMatches('did i send costantine an emial', tasks)).toEqual(['email']);
  });

  it('does not mistake a general schedule review for a task reference', () => {
    expect(findExplicitTaskMatches('smart review my entire schedule and all tasks', tasks)).toEqual([]);
    expect(findExplicitTaskMatches(
      'Perform a proactive smart review of my entire planning system. Check every active goal and incomplete task schedule.',
      [...tasks, { id: 'check', title: 'Check Schedule' }],
    )).toEqual([]);
  });
});
