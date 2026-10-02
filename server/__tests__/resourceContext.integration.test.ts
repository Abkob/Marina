import crypto from 'node:crypto';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { query } from '../db.js';
import { SKIP_INTEGRATION, startTestServer, stopTestServer } from './setup.js';
import { EMBED_MODEL } from '../config/providers.js';
import { searchDocuments } from '../services/documentRag.js';
import { findResources } from '../services/documentReading.js';
import { readResourceContext } from '../services/resourceContext.js';
vi.mock('../embeddingProvider.js', async original => ({ ...await original<typeof import('../embeddingProvider.js')>(), embedQuery: async () => [1, ...Array(3071).fill(0)] }));
const vector = `[${[1, ...Array(3071).fill(0)].join(',')}]`, now = new Date().toISOString();
let goalA: string, goalB: string, parent: string, child: string, milestone: string;
const resources: string[] = [], edges: string[] = [], tasks: string[] = [], goals: string[] = [];
async function goal() { const id = crypto.randomUUID(); goals.push(id); await query('INSERT INTO goals(id,title,created_at,updated_at,target_date,hard_deadline) VALUES($1,$1,$2,$2,$3,$4)', [id, now, '2026-10-10', '2026-10-12']); return id; }
async function task(goalId: string | null, parentId: string | null = null, milestoneId: string | null = null) {
  const id = crypto.randomUUID(); tasks.push(id);
  await query('INSERT INTO tasks(id,title,goal_id,parent_task_id,milestone_id,created_at,updated_at,due_date) VALUES($1,$1,$2,$3,$4,$5,$5,$6)', [id, goalId, parentId, milestoneId, now, '2026-10-09']); return id;
}
async function link(sourceType: string, source: string, targetType: string, target: string, relationship = 'attached_to') {
  const id = crypto.randomUUID(); edges.push(id); await query('INSERT INTO edges(id,source_type,source_id,target_type,target_id,relationship,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, sourceType, source, targetType, target, relationship, now]);
}
async function resource(targetType?: string, target?: string) {
  const id = crypto.randomUUID(), chunk = crypto.randomUUID(); resources.push(id);
  await query("INSERT INTO resources(id,title,created_at,file_validation,mime_type) VALUES($1,$1,$2,'valid','text/plain')", [id, now]);
  await query("INSERT INTO resource_processing_jobs(id,resource_id,status) VALUES($1,$2,'ready')", [crypto.randomUUID(), id]);
  await query("INSERT INTO resource_chunks(id,resource_id,chunk_index,content,page_start,page_end,created_at) VALUES($1,$2,0,'recovery evidence',1,1,$3)", [chunk, id, now]);
  await query(`INSERT INTO embeddings(id,entity_type,entity_id,embedding_scope,embedding_text,embedding_3072,embedding_model,embedding_dimension,content_hash,created_at,updated_at)
    VALUES($1,'resource_chunk',$2,'full_text','recovery evidence',$3::halfvec,$4,3072,$5,$6,$6)`, [crypto.randomUUID(), chunk, vector, EMBED_MODEL, crypto.randomUUID(), now]);
  if (targetType && target) await link('resource', id, targetType, target);
  return id;
}
const found = async (scope: { goal_id?: string; task_id?: string }) => (await findResources(scope)).resources.map(row => row.id).sort();
describe.skipIf(SKIP_INTEGRATION)('resource relationships with real PostgreSQL', () => {
  beforeAll(startTestServer, 60_000); afterAll(stopTestServer);
  beforeEach(async () => {
    goalA = await goal(); goalB = await goal(); parent = await task(goalA); child = await task(null, parent);
    milestone = crypto.randomUUID(); await query('INSERT INTO goal_milestones(id,goal_id,created_at,updated_at) VALUES($1,$2,$3,$3)', [milestone, goalB, now]);
  });
  afterEach(async () => {
    await query("DELETE FROM embeddings WHERE entity_type='resource_chunk' AND entity_id IN(SELECT id FROM resource_chunks WHERE resource_id=ANY($1))", [resources]);
    await query('DELETE FROM edges WHERE id=ANY($1)', [edges]);
    await query('DELETE FROM resources WHERE id=ANY($1)', [resources]);
    await query('DELETE FROM tasks WHERE id=ANY($1)', [tasks]);
    await query('DELETE FROM goals WHERE id=ANY($1)', [goals]);
    resources.length = edges.length = tasks.length = goals.length = 0;
  });
  it('discovers direct goal links, inherited task goals and task-note mentions without cross-goal leakage', async () => {
    const direct = await resource('goal', goalA), inherited = await resource('task', child), noted = await resource();
    const note = crypto.randomUUID(); await query('INSERT INTO task_notes(id,task_id,content,created_at) VALUES($1,$2,$3,$4)', [note, child, 'mention', now]);
    await link('note', note, 'resource', noted, 'mentions');
    await resource('goal', goalB);
    expect(await found({ goal_id: goalA })).toEqual([direct, inherited, noted].sort());
    expect(await found({ task_id: parent })).toEqual([inherited, noted].sort());
  });
  it('honors milestone ownership and explicit child goal overrides', async () => {
    const overridden = await task(goalB, parent), milestoneTask = await task(null, parent, milestone);
    const a = await resource('task', overridden), b = await resource('task', milestoneTask);
    expect(await found({ goal_id: goalA })).toEqual([]);
    expect(await found({ goal_id: goalB })).toEqual([a,b].sort());
    expect(await found({ task_id: parent, goal_id: goalB })).toEqual([a,b].sort());
  });
  it.each(['recovery', 'no lexical match'])('applies goal and selected-file intersection to both retrieval lanes: %s', async question => {
    const a = await resource('task', child), b = await resource('goal', goalB);
    const result = await searchDocuments(question, [a,b], 8, 'off', { goal_id: goalA });
    expect(result.vector_degraded).toBe(false); expect(result.evidence.map(row => row.resource_id)).toEqual([a]);
    expect(result.coverage?.resource_ids_without_evidence).toEqual([b]);
    expect((await searchDocuments(question, [b], 8, 'off', { goal_id: goalA })).evidence).toEqual([]);
  });
  it('does not broaden missing, empty or archived scopes', async () => {
    await resource('task', child); await resource('goal', goalB);
    const empty = await goal();
    for (const goalId of [empty, "unknown' OR TRUE --"]) expect(await found({ goal_id: goalId })).toEqual([]);
    expect(await found({ task_id: 'missing' })).toEqual([]);
    expect(await found({ task_id: child, goal_id: goalB })).toEqual([]);
    await query('UPDATE goals SET archived_at=$2 WHERE id=$1', [goalA, now]);
    expect(await found({ goal_id: goalA })).toEqual([]);
    expect((await searchDocuments('recovery', [], 8, 'off', { task_id: child })).evidence).toEqual([]);
  });
  it('constrains automatic semantic discovery even when the requested title is absent', async () => {
    const a = await resource('task', child), b = await resource('goal', goalB);
    const discover = (scope: { goal_id?: string; task_id?: string }) => findResources({ search: 'nonexistent book title', query: 'concept without lexical overlap', ...scope }, 'off');
    const found = await discover({ goal_id: goalA });
    expect(found).toMatchObject({ title_matches: [], resources: [{ id: a }] });
    expect(found).toMatchObject({ semantic_discovery: { vector_degraded: false, candidate_resource_ids: [a] } });
    expect(JSON.stringify(found)).not.toContain(b);
    expect(await discover({ goal_id: goalB, task_id: child })).toMatchObject({ evidence: [] });
    expect(await discover({ goal_id: 'missing' })).toMatchObject({ evidence: [] });
    await query('UPDATE goals SET archived_at=$2 WHERE id=$1', [goalA, now]);
    expect(await discover({ goal_id: goalA })).toMatchObject({ evidence: [] });
  });
  it('returns current deadlines and unlinked context without inventing relationships', async () => {
    const a = await resource('task', child), loose = await resource();
    await query('UPDATE goals SET hard_deadline=$2 WHERE id=$1', [goalA, '2026-11-01']);
    const result = await readResourceContext([a, loose, 'missing']);
    expect(result.resources.find(row => row.id === a)).toMatchObject({ indexed_passages: 1, indexed_text_pages: 1, goals: [{ id: goalA, hard_deadline: '2026-11-01' }], tasks: [{ id: child, due_date: '2026-10-09' }] });
    expect(result.resources.find(row => row.id === loose)).toMatchObject({ goals: [], tasks: [] });
    expect(result.missing_resource_ids).toEqual(['missing']); expect(result.timing_note).toContain('not calendar time blocks');
  });
  it('excludes unavailable Drive originals and bounds relationship fan-out explicitly', async () => {
    const a = await resource(), unavailable = await resource();
    for (let i=0;i<21;i++) await link('resource', a, 'task', await task(goalA));
    await query("UPDATE resources SET file_path='gdrive://test' WHERE id=$1", [unavailable]);
    await query("INSERT INTO resource_drive_files(resource_id,file_id,source_mime,source_version,available) VALUES($1,$1,'application/pdf','1',false)", [unavailable]);
    const result = await readResourceContext([a,unavailable]);
    expect(result.resources).toHaveLength(1); expect(result.resources[0].tasks).toHaveLength(20);
    expect(result.resources[0].tasks_has_more).toBe(true); expect(result.missing_resource_ids).toEqual([unavailable]);
  });
  it('terminates malformed parent cycles and deduplicates repeated ownership paths', async () => {
    await query('UPDATE tasks SET parent_task_id=$2 WHERE id=$1', [parent,child]);
    const a = await resource('task',child); await link('task',child,'resource',a,'mentions');
    expect(await found({ task_id: parent })).toEqual([a]);
    expect((await readResourceContext([a])).resources[0].tasks).toHaveLength(1);
  });
});
