import type { PoolClient } from 'pg';
import { parsePlanningFixture, type PlanningFixture } from './fixtures.js';
import { dateToWeekPos } from '../../src/utils/calendar.js';

export const PLANNING_TEST_MARKER = 'marina:p00:disposable';
export function validatePlanningTestUrl(value: string | undefined, enabled: string | undefined): string {
  if (!value || enabled !== '1') throw new Error('Planning DB tests require DATABASE_URL_TEST and PLANNING_TEST_DB=1');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid planning test database configuration'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/^\/marina_planning_test(?:_[a-z0-9]+)?$/.test(url.pathname)) throw new Error('Planning fixtures require a local marina_planning_test database');
  return value;
}
export async function assertPlanningTestDatabase(client: PoolClient): Promise<void> {
  const { rows } = await client.query(`SELECT current_database() AS name, host(inet_server_addr()) AS address,
    shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`);
  if (!rows[0] || !/^marina_planning_test(?:_[a-z0-9]+)?$/.test(rows[0].name)
    || !['127.0.0.1', '::1', null].includes(rows[0].address) || rows[0].marker !== PLANNING_TEST_MARKER) {
    throw new Error('Planning fixture database identity/marker check failed');
  }
}

/** The transaction is rolled back, including all fixture-owned rows and any
 * callback writes. Existing rows are never truncated or overwritten. A replay
 * collision fails rather than replacing another test's or user's content. */
export async function withPlanningFixture<T>(client: PoolClient, value: PlanningFixture, run: (fixture: PlanningFixture) => Promise<T>): Promise<T> {
  const fixture = parsePlanningFixture(JSON.stringify(value));
  await assertPlanningTestDatabase(client);
  await client.query('BEGIN');
  try {
    const now = fixture.clock.now;
    for (const goal of fixture.goals) await client.query('INSERT INTO goals (id,title,deadline,created_at,updated_at) VALUES ($1,$2,$3,$4,$4)', [goal.id, goal.title, goal.deadline, now]);
    for (const task of fixture.tasks) await client.query(`INSERT INTO tasks (id,goal_id,title,estimated_minutes,completed,due_date,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, [task.id, task.goal_id, task.title, task.estimated_minutes, task.completed, task.due_date, now]);
    for (const resource of fixture.resources) {
      await client.query('INSERT INTO resources (id,title,type,created_at) VALUES ($1,$2,\'document\',$3)', [resource.id, resource.title, now]);
      await client.query(`INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,created_at)
        VALUES ($1,$2,'resource',$3,'task','attached_to',$4)`, [`p00-resource:${resource.id}`, resource.id, resource.task_id, now]);
    }
    for (const evidence of fixture.evidence) await client.query(`INSERT INTO resource_chunks (id,resource_id,chunk_index,content,page_start,page_end,chunk_metadata,created_at)
      VALUES ($1,$2,$3,$4,$5,$5,$6,$7)`, [evidence.id, evidence.resource_id, fixture.evidence.filter(row => row.resource_id === evidence.resource_id).map(row => row.id).sort().indexOf(evidence.id), evidence.excerpt, evidence.page,
      JSON.stringify({ generation: evidence.generation, evidence_kind: evidence.kind }), now]);
    for (const busy of fixture.busy) {
      const position = dateToWeekPos(busy.day);
      await client.query(`INSERT INTO events (id,title,week_start,day_index,start_hour,duration_hours,created_at,updated_at)
        VALUES ($1,'Synthetic P00 commitment',$2,$3,$4,$5,$6,$6)`, [busy.id, position.week_start, position.day_index, busy.start_minute / 60, (busy.end_minute - busy.start_minute) / 60, now]);
      if (busy.task_id) await client.query(`INSERT INTO event_task_links (id,event_id,task_id,planned_minutes,created_at) VALUES ($1,$2,$3,$4,$5)`,
        [`p00-reservation:${busy.id}`, busy.id, busy.task_id, busy.end_minute - busy.start_minute, now]);
    }
    return await run(fixture);
  } finally { await client.query('ROLLBACK'); }
}
