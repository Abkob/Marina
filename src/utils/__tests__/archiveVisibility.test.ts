import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  ARCHIVE_SCOPE_SQL, activeTaskSql, activeEventSql, activeMeetingSql,
  activeResourceSql, activeEntitySql, proposalTouchesArchive,
} from '../../../server/utils/archiveVisibility';

// Execute the recursive SQL against records instead of mocking query strings.
// The archive predicates use the SQL subset shared by PostgreSQL and SQLite.
describe('archive visibility across active pages', () => {
  let db: DatabaseSync;
  const ids = (table: string, predicate: string) => db.prepare(`SELECT id FROM ${table} WHERE ${predicate} ORDER BY id`).all().map(r => r.id);
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE goals (id TEXT PRIMARY KEY, archived_at TEXT);
      CREATE TABLE goal_milestones (id TEXT PRIMARY KEY, goal_id TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, goal_id TEXT, milestone_id TEXT, parent_task_id TEXT, estimated_minutes INTEGER, completed BOOLEAN DEFAULT false);
      CREATE TABLE meetings (id TEXT PRIMARY KEY, goal_id TEXT, milestone_id TEXT);
      CREATE TABLE resources (id TEXT PRIMARY KEY);
      CREATE TABLE edges (source_type TEXT, source_id TEXT, target_type TEXT, target_id TEXT, relationship TEXT);
      CREATE TABLE events (id TEXT PRIMARY KEY);
      CREATE TABLE event_task_links (event_id TEXT, task_id TEXT);
      CREATE TABLE resource_chunks (id TEXT PRIMARY KEY, resource_id TEXT);
      CREATE TABLE task_notes (id TEXT PRIMARY KEY, task_id TEXT);
      INSERT INTO goals VALUES ('archived', '2026-09-24'), ('active', NULL);
      INSERT INTO goal_milestones VALUES ('old-milestone', 'archived'), ('live-milestone', 'active');
      INSERT INTO tasks (id, goal_id, milestone_id, parent_task_id, estimated_minutes) VALUES
        ('parent', 'archived', NULL, NULL, 120),
        ('child', NULL, NULL, 'parent', 90),
        ('grandchild', 'active', NULL, 'child', 60),
        ('milestone-task', NULL, 'old-milestone', NULL, 40),
        ('active-task', 'active', 'live-milestone', NULL, 30),
        ('standalone', NULL, NULL, NULL, 15);
      INSERT INTO meetings VALUES ('old-meeting', 'archived', NULL), ('linked-meeting', NULL, NULL), ('shared-meeting', NULL, NULL), ('standalone-meeting', NULL, NULL);
      INSERT INTO resources VALUES ('old-resource'), ('shared-resource'), ('standalone-resource');
      INSERT INTO events VALUES ('old-block'), ('shared-block'), ('standalone-block');
      INSERT INTO event_task_links VALUES ('old-block','grandchild'), ('shared-block','child'), ('shared-block','active-task');
      INSERT INTO edges VALUES
        ('meeting','linked-meeting','task','child','linked_to'),
        ('meeting','shared-meeting','task','child','linked_to'),
        ('meeting','shared-meeting','task','active-task','linked_to'),
        ('resource','old-resource','task','grandchild','attached_to'),
        ('resource','shared-resource','goal','archived','attached_to'),
        ('resource','shared-resource','task','active-task','attached_to'),
        ('task','child','task','active-task','blocks');
      INSERT INTO task_notes VALUES ('old-note','child'), ('live-note','active-task');
      INSERT INTO resource_chunks VALUES ('old-chunk','old-resource'), ('live-chunk','shared-resource');
    `);
  });
  afterEach(() => db.close());

  it('hides every descendant even without a goal or with a different active goal', () => {
    expect(ids('tasks', activeTaskSql())).toEqual(['active-task', 'standalone']);
    expect(db.prepare(`SELECT COUNT(*) AS total FROM tasks WHERE ${activeTaskSql()}`).get()?.total).toBe(2);
    expect(ids('tasks', `parent_task_id='parent' AND ${activeTaskSql()}`)).toEqual([]);
  });

  it('excludes archived work from required minutes and dependency links', () => {
    expect(db.prepare(`SELECT SUM(estimated_minutes) AS required FROM tasks t WHERE completed=false AND ${activeTaskSql('t.id')}`).get()?.required).toBe(45);
    expect(db.prepare(`SELECT * FROM edges WHERE relationship='blocks' AND ${activeTaskSql('source_id')} AND ${activeTaskSql('target_id')}`).all()).toEqual([]);
  });

  it('hides archived descendants within an active goal while allowing explicit archive inspection', () => {
    const scoped = (goal: string) => `goal_id='${goal}' AND (${activeTaskSql()} OR EXISTS (SELECT 1 FROM goals WHERE goals.id='${goal}' AND archived_at IS NOT NULL))`;
    expect(ids('tasks', scoped('active'))).toEqual(['active-task']);
    expect(ids('tasks', scoped('archived'))).toEqual(['parent']);
  });

  it('hides exclusively archived linked items while preserving shared and standalone items', () => {
    expect(ids('events', activeEventSql())).toEqual(['shared-block', 'standalone-block']);
    expect(ids('meetings', activeMeetingSql())).toEqual(['shared-meeting', 'standalone-meeting']);
    expect(ids('resources', activeResourceSql())).toEqual(['shared-resource', 'standalone-resource']);
    expect(db.prepare(`SELECT task_id FROM event_task_links WHERE event_id='shared-block' AND ${activeTaskSql('task_id')}`).all()).toEqual([{ task_id: 'active-task' }]);
  });

  it('uses typed visibility for search, topic memberships, notes and resource references', () => {
    db.exec(`CREATE TABLE candidates (id TEXT, entity_type TEXT, entity_id TEXT);
      INSERT INTO candidates VALUES ('1','task','child'), ('2','goal','archived'), ('3','milestone','old-milestone'),
      ('4','task_note','old-note'), ('5','note','old-note'), ('6','resource_chunk','old-chunk'),
      ('7','task','active-task'), ('8','resource','shared-resource'), ('9','journal_entry','child');`);
    expect(ids('candidates', activeEntitySql('entity_type', 'entity_id'))).toEqual(['7', '8', '9']);
  });

  it('restores the whole branch and linked data without deleting records', () => {
    db.exec("UPDATE goals SET archived_at=NULL WHERE id='archived'");
    expect(ids('tasks', activeTaskSql())).toHaveLength(6);
    expect(ids('events', activeEventSql())).toHaveLength(3);
    expect(ids('meetings', activeMeetingSql())).toHaveLength(4);
    expect(ids('resources', activeResourceSql())).toHaveLength(3);
    expect(db.prepare(`${ARCHIVE_SCOPE_SQL} SELECT entity_key FROM archived_entities`).all()).toEqual([]);
  });

  it('terminates cycles and preserves active tasks when no archive applies', () => {
    db.exec("UPDATE tasks SET parent_task_id='child' WHERE id='parent'");
    expect(ids('tasks', activeTaskSql())).toEqual(['active-task', 'standalone']);
  });

  it('does not treat archived children as executable children of an active task', () => {
    db.exec("UPDATE tasks SET parent_task_id='active-task' WHERE id='parent'");
    const leaf = `NOT EXISTS (SELECT 1 FROM tasks child WHERE child.parent_task_id=t.id AND ${activeTaskSql('child.id')})`;
    expect(ids('tasks t', `${activeTaskSql('t.id')} AND ${leaf}`)).toEqual(['active-task', 'standalone']);
  });
});

describe('archived AI proposals', () => {
  const archived = new Set(['task:child', 'goal:archived', 'event:old-block']);
  it.each([
    { source_type: 'task', source_id: 'child' },
    { action_payload: '{"parent_task_id":"child"}' },
    { action_payload: '{"goal_id":"archived"}' },
    { action_payload: '{"task_ids":["active-task","child"]}' },
    { action_payload: '{"target_type":"task","target_id":"child"}' },
    { action_payload: '{"changes":[{"event_id":"old-block"}]}' },
  ])('hides source and nested payload references: %j', proposal => {
    expect(proposalTouchesArchive(proposal, archived)).toBe(true);
  });
  it('keeps unrelated proposals and safely handles legacy malformed JSON', () => {
    expect(proposalTouchesArchive({ action_payload: '{"task_id":"active-task"}' }, archived)).toBe(false);
    expect(proposalTouchesArchive({ source_type: 'journal_entry', source_id: 'child', action_payload: 'invalid' }, archived)).toBe(false);
  });
});
