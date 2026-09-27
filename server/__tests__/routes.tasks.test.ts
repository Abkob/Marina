import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, stopTestServer, baseUrl, SKIP_INTEGRATION } from './setup.js';

describe.skipIf(SKIP_INTEGRATION)('GET /api/tasks (integration)', () => {
  beforeAll(startTestServer);
  afterAll(stopTestServer);

  it('returns an array', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    expect(res.ok).toBe(true);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it('respects limit param (max 500)', async () => {
    const res = await fetch(`${baseUrl}/api/tasks?limit=3`);
    expect(res.ok).toBe(true);
    const body = await res.json() as unknown[];
    expect(body.length).toBeLessThanOrEqual(3);
  });

  it('returns 404 for unknown task id', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });
});

describe.skipIf(SKIP_INTEGRATION)('POST /api/tasks (integration)', () => {
  let createdGoalId: string;
  let createdTaskId: string;
  let createdOneOffId: string;

  beforeAll(async () => {
    await startTestServer();
    const r = await fetch(`${baseUrl}/api/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '__test_goal_for_task__', description: '', category: 'Test', status: 'Safe' }),
    });
    createdGoalId = ((await r.json()) as { id: string }).id;
  });

  afterAll(async () => {
    if (createdOneOffId) await fetch(`${baseUrl}/api/tasks/${createdOneOffId}`, { method: 'DELETE' });
    if (createdTaskId) await fetch(`${baseUrl}/api/tasks/${createdTaskId}`, { method: 'DELETE' });
    if (createdGoalId) await fetch(`${baseUrl}/api/goals/${createdGoalId}`, { method: 'DELETE' });
    await stopTestServer();
  });

  it('creates a task under a goal', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal_id: createdGoalId, title: '__test_task__', status: 'todo', priority: 'low' }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as { id: string };
    expect(typeof body.id).toBe('string');
    createdTaskId = body.id;
  });

  it('returns the task with goal filter', async () => {
    const res = await fetch(`${baseUrl}/api/tasks?goal_id=${createdGoalId}`);
    expect(res.ok).toBe(true);
    const tasks = await res.json() as { id: string }[];
    expect(tasks.some(t => t.id === createdTaskId)).toBe(true);
  });

  it('creates a parentless one-off task without a goal', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal_id: null,
        parent_task_id: null,
        title: '__test_one_off_task__',
        estimated_minutes: 30,
        due_date: '2026-07-30',
      }),
    });
    expect(res.ok).toBe(true);
    createdOneOffId = ((await res.json()) as { id: string }).id;

    const taskRes = await fetch(`${baseUrl}/api/tasks/${createdOneOffId}`);
    expect(taskRes.ok).toBe(true);
    const task = await taskRes.json() as { goal_id: string | null; parent_task_id: string | null; estimated_minutes: number | null };
    expect(task.goal_id).toBeNull();
    expect(task.parent_task_id).toBeNull();
    expect(task.estimated_minutes).toBe(30);
  });
});

describe.skipIf(SKIP_INTEGRATION)('task deadline hierarchy (integration)', () => {
  let goalId: string;
  let parentId: string;
  let childId: string;

  beforeAll(async () => {
    await startTestServer();
    const goalRes = await fetch(`${baseUrl}/api/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '__deadline_hierarchy_goal__', description: '', category: 'Test', status: 'Safe' }),
    });
    goalId = ((await goalRes.json()) as { id: string }).id;

    const parentRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal_id: goalId, title: '__deadline_parent__', due_date: '2026-08-10' }),
    });
    parentId = ((await parentRes.json()) as { id: string }).id;
  });

  afterAll(async () => {
    if (goalId) await fetch(`${baseUrl}/api/goals/${goalId}`, { method: 'DELETE' });
    await stopTestServer();
  });

  it('rejects a child deadline later than its parent', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal_id: goalId, parent_task_id: parentId, title: '__late_child__', due_date: '2026-08-11' }),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('must be on or before parent task');
  });

  it('rejects moving a parent deadline before an existing child deadline', async () => {
    const childRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal_id: goalId, parent_task_id: parentId, title: '__dated_child__', due_date: '2026-08-09' }),
    });
    childId = ((await childRes.json()) as { id: string }).id;
    expect(childId).toBeTruthy();

    const res = await fetch(`${baseUrl}/api/tasks/${parentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ due_date: '2026-08-08' }),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('Move the child deadline first');
  });
});
