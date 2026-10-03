import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planningFixtures, planningUiStates, parsePlanningFixture, permuteFixture } from './fixtures.js';
import { validatePlanningTestUrl } from './databaseFixtures.js';

// Independent minute-set oracle; does not reuse application interval arithmetic.
function freeMinutes(fixture: typeof planningFixtures[number]) {
  const free = new Set<string>();
  for (const row of fixture.windows) for (let m = row.start_minute; m < row.end_minute; m++) free.add(`${row.day}:${m}`);
  for (const row of fixture.busy) for (let m = row.start_minute; m < row.end_minute; m++) free.delete(`${row.day}:${m}`);
  return free.size;
}
describe('P00.1 immutable synthetic fixtures', () => {
  it('P00.1-U01 preserves unknown estimates and immutable nested evidence through serialization', () => {
    expect(parsePlanningFixture(JSON.stringify(planningFixtures[0])).tasks[0].estimated_minutes).toBeNull();
    expect(() => { planningFixtures[1].evidence[0].excerpt = 'changed'; }).toThrow();
    expect(planningFixtures.map(row => row.key)).toEqual(['no-resource', 'book', 'client-deliverable', 'mixed-work-study']);
  });
  it('P00.1-U02 rejects a resource identity where a task is required', () => {
    const value = structuredClone(planningFixtures[1]); value.resources[0].task_id = value.resources[0].id;
    expect(() => parsePlanningFixture(JSON.stringify(value))).toThrow('task identity');
  });
  it.each(['duplicate', 'generation', 'missing', 'date', 'clock'])('P00.1-U03 rejects inconsistent %s facts', kind => {
    const value = structuredClone(planningFixtures[1]);
    if (kind === 'duplicate') value.tasks[0].id = value.resources[0].id;
    if (kind === 'generation') value.evidence[0].generation++;
    if (kind === 'missing') value.evidence = [];
    if (kind === 'date') value.tasks[0].due_date = '2026-02-30';
    if (kind === 'clock') value.clock.today = '2026-10-07';
    expect(() => parsePlanningFixture(JSON.stringify(value))).toThrow('Invalid planning fixture');
  });
  it('P00.1-U04 checks calendar and remaining-work oracles independently', () => {
    for (const fixture of planningFixtures) {
      expect(freeMinutes(fixture)).toBe(fixture.expected.free_minutes);
      if (fixture.work.length) expect(fixture.work.filter(row => !row.completed).reduce((sum, row) => sum + row.minutes, 0)).toBe(fixture.expected.remaining_minutes);
    }
    const mixed = planningFixtures[3];
    expect(mixed.expected.remaining_minutes! - 30).toBe(50);
    expect(new Date('2026-10-07T00:00:00Z').getTime() - new Date('2026-10-06T00:00:00Z').getTime()).toBe(86400000);
  });
  it('P00.1-F01 provides every requested frontend state without implying a delivered planning UI', () => {
    expect(planningUiStates.map(row => row.state)).toEqual(['absent', 'loading', 'partial_evidence', 'ready_plan', 'stale_proposal', 'provider_failure']);
    expect(planningUiStates.filter(row => row.actionEnabled).map(row => row.state)).toEqual(['ready_plan']);
  });
  for (let seed = 1; seed <= 100; seed++) it(`P00.1-S01 seed ${seed} preserves evidence and arithmetic under reordered insertion`, () => {
    for (const original of planningFixtures) {
      const changed = permuteFixture(original, seed);
      expect(freeMinutes(changed)).toBe(original.expected.free_minutes);
      expect(changed.evidence.map(row => row.id).sort()).toEqual(original.evidence.map(row => row.id).sort());
      expect(JSON.stringify(permuteFixture(original, seed))).toBe(JSON.stringify(changed));
    }
  });
  it('P00.1-S02 rejects a truncated fixture file with no silent defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marina-p00-fixture-')); const file = join(directory, 'truncated.json');
    try {
      await writeFile(file, JSON.stringify(planningFixtures[1]).slice(0, -30));
      const requireText = await readFile(file, 'utf8');
      expect(() => parsePlanningFixture(requireText)).toThrow('Invalid planning fixture JSON');
    } finally { await unlink(file); await rmdir(directory); }
  });
  it.each([
    ['postgresql://x@y.example/marina_planning_test', '1'],
    ['postgresql://x@localhost/marina', '1'], ['postgresql://x@localhost/contest', '1'],
    ['postgresql://x@localhost/marina_planning_test', undefined], ['not a url', '1'],
  ])('P00.1-I01 refuses unsafe or unmarked fixture DB configuration (%#)', (url, marker) => {
    expect(() => validatePlanningTestUrl(url, marker)).toThrow();
  });
});
